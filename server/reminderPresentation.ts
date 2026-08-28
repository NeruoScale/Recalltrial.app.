// ─── Phase 4.3 — Reminder UX: user-facing presentation ─────────────────────────
//
// Translates Phase 4.1 eligibility + real subscription_reminders rows into a
// small, stable, user-facing shape — never raw technical statuses (PENDING/
// SENDING/FAILED/SKIPPED), never database ids, never lastError/provider
// details. Pure and DB-free: the caller (server/routes.ts) fetches the
// subscription + its reminder rows via storage.ts, this module only shapes
// already-fetched data, same separation as subscriptionVault.ts.
//
// Does NOT decide whether a reminder gets scheduled or sent — that remains
// entirely evaluateReminderEligibility()'s (Phase 4.1) and the delivery
// pipeline's (Phase 4.2) job, untouched. This module only DESCRIBES the
// current, real state truthfully — "never display 'you'll receive a
// reminder' unless the backend actually schedules/delivers one."
import type { ShadowSubscription, SubscriptionReminder } from "@shared/schema";
import { evaluateReminderEligibility } from "./subscriptionLifecycle";

export type ReminderDisplayStatus = "scheduled" | "sent" | "unavailable" | "not_scheduled";

export type ReminderDisplayItem = {
  type: "THREE_DAYS" | "TWO_DAYS" | "ONE_DAY";
  label: string;
  status: ReminderDisplayStatus;
  remindAt: string | null;
  sentAt: string | null;
};

export type ReminderPresentation =
  | { eligible: false; reason: string; items: [] }
  | { eligible: true; items: ReminderDisplayItem[] };

const OFFSET_LABELS: { type: ReminderDisplayItem["type"]; label: string }[] = [
  { type: "THREE_DAYS", label: "3 days before" },
  { type: "TWO_DAYS", label: "2 days before" },
  { type: "ONE_DAY", label: "1 day before" },
];

// Mirrors evaluateReminderEligibility()'s OWN check order exactly (status ->
// resolutionStatus -> dismissed -> date) so the friendly reason always
// matches whichever check actually failed. Deliberately does NOT parse
// evaluateReminderEligibility()'s reason string (that string is for
// logs/tests, not user-facing copy, and string-matching it would be fragile)
// — this independently re-checks the same stable conditions to produce
// user-facing text, while the actual eligible/ineligible DECISION is still
// 100% owned by evaluateReminderEligibility() below.
function describeIneligibleReason(subscription: ShadowSubscription): string {
  if (subscription.subscriptionStatus !== "active" && subscription.subscriptionStatus !== "trial") {
    return "Reminders aren't available for this subscription's current status.";
  }
  if (subscription.resolutionStatus !== "resolved") {
    return "Reminders aren't available yet.";
  }
  if (subscription.userDismissed) {
    return "You've dismissed this subscription, so reminders are turned off for it.";
  }
  if (!subscription.nextBillingDate) {
    return "We don't have a renewal date yet, so we can't schedule a reminder.";
  }
  return "This renewal date has already passed.";
}

function deriveItemStatus(
  row: Pick<SubscriptionReminder, "status" | "remindAt" | "sentAt"> | undefined
): Pick<ReminderDisplayItem, "status" | "remindAt" | "sentAt"> {
  if (!row) return { status: "not_scheduled", remindAt: null, sentAt: null };
  switch (row.status) {
    case "SENT":
      return { status: "sent", remindAt: null, sentAt: row.sentAt ? row.sentAt.toISOString() : null };
    case "FAILED":
      // User-facing: "We couldn't send this reminder" — never the raw
      // FAILED status name, never lastError/provider details (never even
      // passed into this module).
      return { status: "unavailable", remindAt: null, sentAt: null };
    case "PENDING":
    case "SENDING":
      return { status: "scheduled", remindAt: row.remindAt ? row.remindAt.toISOString() : null, sentAt: null };
    default:
      // SKIPPED (or any future status) is terminal and no longer
      // applicable — shown identically to "never scheduled," not as an
      // error state.
      return { status: "not_scheduled", remindAt: null, sentAt: null };
  }
}

/**
 * buildReminderPresentation(): given a subscription and its OWN real
 * subscription_reminders rows (already fetched, ownership-scoped by the
 * caller), returns exactly what the UI should show. `existingReminders`
 * reflects real DB state, so `status` here can genuinely differ from what
 * evaluateReminderEligibility()'s plans would predict (e.g. a row for an
 * eligible offset simply hasn't been generated yet by the next cron tick) —
 * that's correct, not a bug: this module describes reality, not a forecast.
 */
export function buildReminderPresentation(
  subscription: ShadowSubscription,
  now: Date,
  timezone: string,
  existingReminders: Pick<SubscriptionReminder, "type" | "status" | "remindAt" | "sentAt">[]
): ReminderPresentation {
  const evaluation = evaluateReminderEligibility(subscription, now, timezone);
  if (!evaluation.eligible) {
    return { eligible: false, reason: describeIneligibleReason(subscription), items: [] };
  }

  const byType = new Map(existingReminders.map((r) => [r.type, r]));
  const items: ReminderDisplayItem[] = OFFSET_LABELS.map(({ type, label }) => ({
    type,
    label,
    ...deriveItemStatus(byType.get(type)),
  }));

  return { eligible: true, items };
}
