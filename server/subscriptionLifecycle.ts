// ─── Subscription lifecycle model — pure decision logic (Phase 3B.8) ───────────
//
// Same separation-of-concerns pattern as canonicalEvents.ts/entityResolver.ts:
// no DB access here, so every rule is directly unit-testable. server/storage.ts
// owns the DB orchestration (resolving the target subscriptions row, applying
// the returned update, logging the transition).
//
// HARD RULES this module exists to enforce:
//   - unknown/ambiguous events never cause a destructive transition
//   - cancellation requires actual confirmed evidence (subscription_cancelled
//     or the legacy cancellation_confirmed) — never a mere request
//   - one_time_purchase never causes any state transition
//   - cancelled -> active and expired -> active are never reachable via any
//     event, automatically

import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";
import { getTimezoneOffsetMs } from "./reminderScheduling";

export type LifecycleState = "trial" | "active" | "past_due" | "canceled" | "expired" | "unknown";

// The event types this engine recognizes. Everything else (subscription_paused,
// cancellation_requested — a REQUEST, not confirmation, deliberately excluded
// per the HARD RULES — invoice_received/payment_received/subscription_started,
// the pre-3B.1/3B.2 legacy classifier values, and unknown_subscription_event)
// is intentionally NOT handled: an unrecognized event type is always a no-op,
// never a transition, which is exactly the "unknown/ambiguous must not cause
// destructive transitions" rule applied structurally rather than case-by-case.
const LIFECYCLE_EVENT_TYPES = new Set<string>([
  "payment_failed",
  "subscription_renewed",
  "subscription_invoice",
  "trial_started",
  "trial_ending",
  "subscription_cancelled",
  "cancellation_confirmed", // legacy classifier's spelling of the same evidence
  "subscription_expired", // legacy classifier value — the only way "expired" is reachable
  "price_changed",
]);

export function isLifecycleEvent(eventType: string): boolean {
  return LIFECYCLE_EVENT_TYPES.has(eventType);
}

export type LifecycleTransitionResult =
  | { kind: "no_op"; reason: string }
  | { kind: "data_update"; reason: string }
  | { kind: "state_change"; from: LifecycleState; to: LifecycleState; reason: string };

/**
 * The transition table, exactly as specified:
 *   payment_failed        active -> past_due                  (only from active)
 *   subscription_renewed  any -> active                        (confirms/updates; never from canceled/expired)
 *   subscription_invoice   billing data only, no state change
 *   trial_started          unknown -> trial
 *   trial_ending            trial -> trial (end date only)
 *   subscription_cancelled /
 *   cancellation_confirmed  active/past_due -> canceled
 *   subscription_expired    any (not canceled/expired) -> expired
 *   price_changed            amount only, no state change
 */
export function computeLifecycleTransition(
  currentState: LifecycleState,
  eventType: string
): LifecycleTransitionResult {
  if (eventType === "one_time_purchase") {
    return { kind: "no_op", reason: "one_time_purchase never causes a state transition" };
  }

  if (!isLifecycleEvent(eventType)) {
    return { kind: "no_op", reason: `'${eventType}' is not a recognized lifecycle event — no transition` };
  }

  switch (eventType) {
    case "payment_failed":
      if (currentState === "active") {
        return { kind: "state_change", from: "active", to: "past_due", reason: "payment_failed event" };
      }
      return { kind: "no_op", reason: `payment_failed only transitions from active (current: ${currentState})` };

    case "subscription_renewed":
      if (currentState === "canceled" || currentState === "expired") {
        return { kind: "no_op", reason: `${currentState} can never transition to active automatically` };
      }
      if (currentState === "active") {
        return { kind: "no_op", reason: "already active — subscription_renewed confirms, no state change" };
      }
      return { kind: "state_change", from: currentState, to: "active", reason: "subscription_renewed event" };

    case "subscription_invoice":
      return { kind: "data_update", reason: "subscription_invoice updates billing data only" };

    case "trial_started":
      if (currentState === "unknown") {
        return { kind: "state_change", from: "unknown", to: "trial", reason: "trial_started event" };
      }
      return { kind: "no_op", reason: `trial_started only transitions from unknown (current: ${currentState})` };

    case "trial_ending":
      if (currentState === "trial") {
        return { kind: "data_update", reason: "trial_ending updates end date only, no state change" };
      }
      return { kind: "no_op", reason: `trial_ending only applies while in trial (current: ${currentState})` };

    case "subscription_cancelled":
    case "cancellation_confirmed":
      if (currentState === "active" || currentState === "past_due") {
        return { kind: "state_change", from: currentState, to: "canceled", reason: `${eventType} event` };
      }
      return { kind: "no_op", reason: `cancellation only applies from active/past_due (current: ${currentState})` };

    case "subscription_expired":
      if (currentState === "canceled" || currentState === "expired") {
        return { kind: "no_op", reason: `${currentState} does not transition to expired again` };
      }
      return { kind: "state_change", from: currentState, to: "expired", reason: "subscription_expired event" };

    case "price_changed":
      return { kind: "data_update", reason: "price_changed updates amount only, no state change" };

    default:
      return { kind: "no_op", reason: `'${eventType}' has no defined transition` };
  }
}

export type LifecycleRelevantEvent = Pick<
  SubscriptionEvent,
  "id" | "eventType" | "extractedPrice" | "extractedCurrency" | "extractedDate" | "userId" | "canonicalMerchantDomain" | "billingInterval" | "emailConnectionId"
>;

export type SubscriptionLifecycleUpdate = {
  transition: LifecycleTransitionResult;
  fields: {
    subscriptionStatus?: LifecycleState;
    amount?: string | null;
    currency?: string | null;
    nextBillingDate?: string | null;
    billingInterval?: string;
    lastEventEmailConnectionId?: string | null;
    crossAccountConflict?: boolean;
  };
  // Populated only when billingInterval is actually changing (null -> value,
  // or value -> a DIFFERENT value) — lets the caller log the specific
  // "[Lifecycle] billingInterval updated: X -> Y" line STEP 3 asks for,
  // distinct from the state-transition log line.
  billingIntervalChange: { from: string | null; to: string } | null;
};

// Event types whose whole purpose is carrying fresh billing evidence.
// payment_failed/cancellation events never refresh amount/date — a failed
// charge or a cancellation notice doesn't tell you a new trustworthy price
// or renewal date.
const BILLING_DATA_EVENT_TYPES = new Set(["subscription_invoice", "subscription_renewed", "price_changed", "trial_ending"]);

/**
 * applyEventToSubscription(): given one canonical event and the subscription
 * it resolved to (by userId + canonicalMerchantDomain — that resolution
 * happens in storage.ts, not here), decides what should change. Pure: same
 * (event, subscription) input always produces the same output, which is what
 * makes repeated application idempotent — see the module header and Step 3's
 * test coverage. Never auto-creates a subscription; the caller is
 * responsible for "no existing subscription found -> do nothing" (entity
 * resolution owns creation, not this engine).
 *
 * crossAccountProtectionEnabled (Account Isolation architecture, PHASE D):
 * defaults false, so any caller that doesn't pass it — and every existing
 * caller before this phase — keeps the EXACT pre-existing behavior
 * (unconditional overwrite). When true (gated by the caller to the
 * Subscription Intelligence controlled-beta flag, see storage.ts), applies
 * RULES 1-4 below instead, driven by `isKnownDifferentAccount`:
 *   RULE 1 — isKnownDifferentAccount is false or null (same account as last
 *            time, OR provenance unknown on either side — a historical row,
 *            an event with no connection recorded, or a connection whose
 *            provider identity hasn't been captured yet): apply normally,
 *            exactly like the flag-off behavior.
 *   RULE 2 — isKnownDifferentAccount is true, new value AGREES with the
 *            existing one: apply normally, refresh provenance, clear any
 *            prior conflict flag.
 *   RULE 3 — isKnownDifferentAccount is true, new value CONFLICTS: do NOT
 *            overwrite amount/currency/nextBillingDate; set
 *            crossAccountConflict=true.
 *   RULE 4 — existing value is unknown/null: never counts as a conflict
 *            (there's nothing to disagree with) — falls under RULE 2's
 *            "apply normally" path automatically.
 *
 * Active Connection Isolation update: lastEventEmailConnectionId now
 * transfers to the incoming event's connection in EVERY branch above,
 * including RULE 3 — ownership (which connection's ACTIVE view this
 * subscription belongs to) and billing-field trust (whether this event's
 * numbers are reliable enough to overwrite) are independent questions. At
 * most one connection is ever active per user at a time (email_connections'
 * partial unique index), so "isKnownDifferentAccount" here always means the
 * PRIOR owner is a connection that is no longer the live one — never two
 * simultaneously-trusted sources. RULE 3 still refuses to blend possibly-
 * unrelated numbers into amount/currency/nextBillingDate (that protection is
 * unchanged), but the subscription correctly becomes visible again under
 * whichever account is now actually connected, using whatever data is
 * currently trusted for it.
 *
 * isKnownDifferentAccount is deliberately NOT "are the two emailConnectionId
 * values different" — it must be resolved by the caller (storage.ts) by
 * comparing the STABLE Google account identity (providerAccountId) of the
 * two connections, never the raw email_connections row id. Reconnecting the
 * SAME Gmail account creates a brand new connection ROW (a new session) but
 * is still the same ACCOUNT — comparing raw ids would misclassify an
 * ordinary reconnect-and-rescan as a cross-account switch and start
 * flagging perfectly normal price changes as conflicts.
 */
export function applyEventToSubscription(
  event: LifecycleRelevantEvent,
  subscription: ShadowSubscription,
  crossAccountProtectionEnabled: boolean = false,
  isKnownDifferentAccount: boolean | null = null
): SubscriptionLifecycleUpdate {
  const transition = computeLifecycleTransition(subscription.subscriptionStatus as LifecycleState, event.eventType);

  const fields: SubscriptionLifecycleUpdate["fields"] = {};

  if (transition.kind === "state_change") {
    fields.subscriptionStatus = transition.to;
  }

  if (transition.kind !== "no_op" && BILLING_DATA_EVENT_TYPES.has(event.eventType)) {
    const applyBillingFields = () => {
      if (event.extractedPrice) fields.amount = event.extractedPrice;
      if (event.extractedCurrency) fields.currency = event.extractedCurrency;
      if (event.extractedDate) fields.nextBillingDate = event.extractedDate;
    };

    if (!crossAccountProtectionEnabled || isKnownDifferentAccount !== true) {
      // RULE 1: protection off, same account, or provenance unknown —
      // behave exactly as the flag-off path always has.
      applyBillingFields();
      if (crossAccountProtectionEnabled && event.emailConnectionId) {
        fields.lastEventEmailConnectionId = event.emailConnectionId;
      }
    } else {
      // A KNOWN different account than last time — check agreement per
      // field. RULE 4 falls out naturally: a null existing value can never
      // "conflict," so it always takes the RULE 2 branch.
      const amountConflict = event.extractedPrice !== null && subscription.amount !== null && event.extractedPrice !== subscription.amount;
      const currencyConflict = event.extractedCurrency !== null && subscription.currency !== null && event.extractedCurrency !== subscription.currency;

      if (amountConflict || currencyConflict) {
        // RULE 3: preserve the existing known value; do not touch
        // amount/currency/nextBillingDate. Ownership still transfers (see
        // the Active Connection Isolation note above) so the subscription
        // remains correctly visible under whichever account is now active.
        fields.crossAccountConflict = true;
        if (event.emailConnectionId) {
          fields.lastEventEmailConnectionId = event.emailConnectionId;
        }
      } else {
        // RULE 2: different account, but agrees (or fills a gap) — apply
        // normally, refresh provenance, clear any stale conflict flag.
        applyBillingFields();
        fields.lastEventEmailConnectionId = event.emailConnectionId;
        fields.crossAccountConflict = false;
      }
    }
  }

  // Phase 3B.9.2A Step 3: billingInterval propagation is UNCONDITIONAL —
  // independent of transition.kind and event type, since it's data, not a
  // state transition. Only ever fills a gap (null -> value) or updates to a
  // genuinely different value from the most recent canonical event; a known
  // interval is never overwritten with null (event.billingInterval === null
  // means "this particular email didn't mention it," not "there is no
  // interval" — the subscription's existing value, once known, stays put).
  // Deliberately NOT part of the cross-account conflict check above — a
  // billing frequency (monthly/annual) either matches or it's a genuinely
  // new fact about the SAME real subscription, and the existing "never
  // downgrade a known interval" rule already protects it independently of
  // which connection supplied it.
  let billingIntervalChange: SubscriptionLifecycleUpdate["billingIntervalChange"] = null;
  if (event.billingInterval && event.billingInterval !== subscription.billingInterval) {
    fields.billingInterval = event.billingInterval;
    billingIntervalChange = { from: subscription.billingInterval, to: event.billingInterval };
  }

  return { transition, fields, billingIntervalChange };
}

// ─── Reminder eligibility (Phase 3B.8 Step 5) ──────────────────────────────────
//
// Deliberately conservative — every one of the task's explicit "DO NOT"
// rules is its own guard clause, not folded into one boolean, so the reasons
// stay traceable:
//   past_due               -> no renewal reminder
//   cancelled/expired       -> no reminder at all
//   ambiguous/unresolved    -> no reminder (resolutionStatus check; in
//                              practice these never reach `subscriptions` at
//                              all, per entityResolver's eligibility gate,
//                              but kept explicit so this function is correct
//                              standalone)
//   missing/uncertain date  -> no date-based reminder
export function isEligibleForReminder(subscription: ShadowSubscription): boolean {
  if (subscription.subscriptionStatus !== "active" && subscription.subscriptionStatus !== "trial") return false;
  if (subscription.resolutionStatus !== "resolved") return false;
  if (!subscription.nextBillingDate) return false;
  return true;
}

export type SubscriptionReminderPlan = { remindAt: Date; type: "THREE_DAYS" | "TWO_DAYS" | "ONE_DAY" };

// getTimezoneOffsetMs() now lives in ./reminderScheduling.ts (extracted from
// routes.ts as part of the maintenance patch that fixed the ICU
// midnight-formatting bug both this module and routes.ts's computeReminders()
// used to have their own copy of) — imported above instead of duplicated.

/**
 * computeSubscriptionReminderPlan(): same 3-day/2-day/1-day-before math as
 * routes.ts's computeReminders() (server/reminderScheduling.ts), reusing
 * that exact getTimezoneOffsetMs(). targetDateStr is
 * subscription.nextBillingDate — used uniformly whether it represents a
 * renewal date (active) or a trial end date (trial), since `subscriptions`
 * has no separate trialEndDate column.
 */
export function computeSubscriptionReminderPlan(
  targetDateStr: string,
  now: Date,
  timezone: string
): SubscriptionReminderPlan[] {
  const tzOffsetMs = getTimezoneOffsetMs(timezone, now);
  const targetDateTimeUtc = new Date(new Date(targetDateStr + "T23:59:59.000Z").getTime() - tzOffsetMs);

  const minFutureMs = 2 * 60 * 1000;
  const offsets: Array<{ hoursBefore: number; type: SubscriptionReminderPlan["type"] }> = [
    { hoursBefore: 72, type: "THREE_DAYS" },
    { hoursBefore: 48, type: "TWO_DAYS" },
    { hoursBefore: 24, type: "ONE_DAY" },
  ];

  const results: SubscriptionReminderPlan[] = [];
  for (const offset of offsets) {
    const remindAt = new Date(targetDateTimeUtc.getTime() - offset.hoursBefore * 60 * 60 * 1000);
    if (remindAt.getTime() > now.getTime() + minFutureMs) {
      results.push({ remindAt, type: offset.type });
    }
  }
  return results;
}
