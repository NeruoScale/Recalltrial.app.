// ─── Historical body-extraction backfill (Phase 3B.9.7-PATCH) ──────────────────
//
// One-time (idempotent) enrichment pass over ALREADY-canonical events that
// were written before Phase 3B.9.7's full-body fetch existed, or whose
// snippet-only extraction missed data the body actually has (the Anthropic
// £15.00 case). Reuses fetchMessageBody()/extractAmount()/
// extractBillingInterval()/extractDate() exactly as scanGmailForTrials()
// does — no new extraction logic, no raw body storage, same PRIVACY
// guarantees as server/gmail.ts's Layer 2 (body is a local variable here
// too, never logged, never persisted).
//
// Per Phase 3B.8's HARD RULES (server/subscriptionLifecycle.ts, unchanged):
// one_time_purchase/payment_failed events never carry billing data into
// subscriptions.amount, regardless of how good their OWN extraction is —
// that's a deliberate lifecycle-semantics boundary this phase does not
// touch. Backfilling those events' extractedPrice still improves
// subscription_events (and therefore the Subscription Vault's price
// history/detail view, which reads events directly), it just won't ever
// move subscriptions.amount for that specific event.

import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { subscriptionEvents, users, type SubscriptionEvent } from "@shared/schema";
import { buildGmailClient, fetchMessageBody, extractAmount, extractBillingInterval, extractDate } from "./gmail";
import { storage } from "./storage";
import { sourcePrecedence, isEligibleToUpgrade } from "./sourcePrecedence";

const BODY_PRECEDENCE = sourcePrecedence("body");

export type ExistingEventFields = Pick<
  SubscriptionEvent,
  "extractedPrice" | "extractedCurrency" | "amountSource" | "billingInterval" | "intervalSource" | "extractedDate" | "dateSource"
>;

export type BodyExtractionResult = {
  amount: string | null;
  currency: string;
  interval: string | null;
  date: string | null;
};

export type FieldUpdatePlan = {
  updates: Partial<Pick<SubscriptionEvent, "extractedPrice" | "extractedCurrency" | "amountSource" | "billingInterval" | "intervalSource" | "extractedDate" | "dateSource">>;
  amountImproved: boolean;
  intervalImproved: boolean;
  dateImproved: boolean;
};

/**
 * needsBodyFetch(): true only when at least one field is STRICTLY below
 * body-tier quality — an event already fully at body/ai tier for all three
 * fields has nothing a body fetch could add, so it's skipped before ever
 * calling Gmail (the "skipped: already has body-quality data" counter).
 * Deliberately a strict `<`, not isEligibleToUpgrade()'s `>=` — this is the
 * pre-filter for "is there a GAP to fill," not the per-field "is this
 * source allowed to write" check (that's planFieldUpdatesFromBody() below).
 */
export function needsBodyFetch(existing: ExistingEventFields): boolean {
  return (
    sourcePrecedence(existing.amountSource) < BODY_PRECEDENCE ||
    sourcePrecedence(existing.intervalSource) < BODY_PRECEDENCE ||
    sourcePrecedence(existing.dateSource) < BODY_PRECEDENCE
  );
}

/**
 * planFieldUpdatesFromBody(): pure per-event decision — given what's
 * currently stored and what the body ALONE extracted, decides which fields
 * to write. Two-layer guard per field: (1) isEligibleToUpgrade() — is
 * 'body' source-quality allowed to touch this field at all (never
 * downgrades ai, allows body-over-body/snippet/metadata/null); (2) a VALUE
 * comparison on top — even when eligible, a field whose value AND source
 * are already identical to what body would produce is left untouched. That
 * second layer is what makes running this backfill twice idempotent
 * (second run: 0 improvements) despite the first layer alone permitting
 * body==body — see server/sourcePrecedence.ts's own comment on why
 * equal-tier eligibility exists at all (a genuinely fresher body at the
 * same tier), which this function still allows for a value that DID change.
 */
export function planFieldUpdatesFromBody(existing: ExistingEventFields, body: BodyExtractionResult): FieldUpdatePlan {
  const updates: FieldUpdatePlan["updates"] = {};
  let amountImproved = false;
  let intervalImproved = false;
  let dateImproved = false;

  if (body.amount !== null && isEligibleToUpgrade("body", existing.amountSource)) {
    const unchanged = existing.extractedPrice === body.amount && existing.extractedCurrency === body.currency && existing.amountSource === "body";
    if (!unchanged) {
      updates.extractedPrice = body.amount;
      updates.extractedCurrency = body.currency;
      updates.amountSource = "body";
      amountImproved = true;
    }
  }

  if (body.interval !== null && isEligibleToUpgrade("body", existing.intervalSource)) {
    const unchanged = existing.billingInterval === body.interval && existing.intervalSource === "body";
    if (!unchanged) {
      updates.billingInterval = body.interval;
      updates.intervalSource = "body";
      intervalImproved = true;
    }
  }

  if (body.date !== null && isEligibleToUpgrade("body", existing.dateSource)) {
    const unchanged = existing.extractedDate === body.date && existing.dateSource === "body";
    if (!unchanged) {
      updates.extractedDate = body.date;
      updates.dateSource = "body";
      dateImproved = true;
    }
  }

  return { updates, amountImproved, intervalImproved, dateImproved };
}

export type BackfillReport = {
  scanned: number;
  bodyFetched: number;
  amountImproved: number;
  intervalImproved: number;
  dateImproved: number;
  unchanged: number;
  failed: number;
  skipped: number;
};

/**
 * backfillCanonicalEventBodies(): the DB/network orchestration around the
 * two pure functions above. Scoped to `userId` when given (cross-user
 * isolation — a run for user A only ever selects rows WHERE user_id = A,
 * and groups by user again internally so a global run still never mixes
 * one user's Gmail client with another user's events). dryRun=true runs
 * every extraction and computes every count exactly as a real run would,
 * it just never calls db.update() or the post-update lifecycle
 * re-application.
 */
export async function backfillCanonicalEventBodies(userId?: string, dryRun = false): Promise<BackfillReport> {
  const report: BackfillReport = {
    scanned: 0, bodyFetched: 0, amountImproved: 0, intervalImproved: 0, dateImproved: 0, unchanged: 0, failed: 0, skipped: 0,
  };

  const events = await db
    .select()
    .from(subscriptionEvents)
    .where(
      userId
        ? and(eq(subscriptionEvents.isCanonical, true), eq(subscriptionEvents.userId, userId))
        : eq(subscriptionEvents.isCanonical, true)
    );

  const eventsByUser = new Map<string, SubscriptionEvent[]>();
  for (const ev of events) {
    if (!ev.sourceMessageId) continue;
    const list = eventsByUser.get(ev.userId) ?? [];
    list.push(ev);
    eventsByUser.set(ev.userId, list);
  }

  for (const [uid, userEvents] of Array.from(eventsByUser.entries())) {
    const [user] = await db.select().from(users).where(eq(users.id, uid));

    if (!user || !user.gmailAccessToken) {
      // No connected Gmail account to fetch bodies from — every event for
      // this user is scanned but cannot possibly be improved right now.
      report.scanned += userEvents.length;
      report.failed += userEvents.length;
      continue;
    }

    const gmail = buildGmailClient(user.gmailAccessToken, user.gmailRefreshToken, user.gmailTokenExpiry);

    for (const ev of userEvents) {
      report.scanned++;

      if (!needsBodyFetch(ev)) {
        report.skipped++;
        continue;
      }

      let body: string | null;
      try {
        body = await fetchMessageBody(gmail, ev.sourceMessageId);
      } catch {
        body = null;
      }

      if (!body) {
        report.failed++;
        continue;
      }
      report.bodyFetched++;

      const { amount, currency } = extractAmount("", body);
      const interval = extractBillingInterval("", body);
      // No original Date header is stored for a historical event — createdAt
      // (when we recorded it) is the best available stand-in for receivedAt.
      // This only affects relative/duration-phrased dates ("ends in 3 days");
      // explicit dates ("next billing date: Sep 1, 2026" — the common case
      // for a body-only re-extraction) don't depend on it at all.
      const { date } = extractDate("", ev.createdAt, body);

      const plan = planFieldUpdatesFromBody(ev, { amount, currency, interval, date });

      if (plan.amountImproved) report.amountImproved++;
      if (plan.intervalImproved) report.intervalImproved++;
      if (plan.dateImproved) report.dateImproved++;

      const improvedAny = plan.amountImproved || plan.intervalImproved || plan.dateImproved;
      if (!improvedAny) {
        report.unchanged++;
        continue;
      }

      if (dryRun) continue;

      await db.update(subscriptionEvents).set(plan.updates).where(eq(subscriptionEvents.id, ev.id));

      // Phase 3B.9.7-PATCH STEP 4: rerun lifecycle/billing-intelligence so
      // subscriptions.amount/currency/billingInterval pick up the improved
      // event data wherever the existing (unchanged) lifecycle rules allow
      // it to. Isolated in its own try/catch — a lifecycle failure must
      // never mark the event-level backfill itself as failed, matching the
      // same isolation pattern createSubscriptionEvent() already uses.
      try {
        await storage.applyLifecycleEventToSubscription({
          id: ev.id,
          eventType: ev.eventType,
          extractedPrice: plan.updates.extractedPrice ?? ev.extractedPrice,
          extractedCurrency: plan.updates.extractedCurrency ?? ev.extractedCurrency,
          extractedDate: plan.updates.extractedDate ?? ev.extractedDate,
          userId: ev.userId,
          canonicalMerchantDomain: ev.canonicalMerchantDomain,
          billingInterval: plan.updates.billingInterval ?? ev.billingInterval,
        });
      } catch (err) {
        console.error("[Backfill] lifecycle re-application failed:", err);
      }
    }
  }

  return report;
}
