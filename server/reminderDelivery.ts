// ─── Phase 4.2 — Reminder Delivery: pure delivery decision ─────────────────────
//
// decideReminderDeliveryAction() answers exactly one question, right before
// a due reminder would be claimed and sent: should this attempt actually
// happen, or has the underlying subscription stopped qualifying since its
// reminder row was created?
//
// Composes two independently-tested checks rather than inventing new logic:
//   - evaluateReminderEligibility() (Phase 4.1, subscriptionLifecycle.ts) —
//     catches a subscription that's been dismissed, cancelled, or whose
//     renewal date became invalid/passed since the reminder was scheduled.
//   - isCurrentlyActive (Phase 3D/Active Connection Isolation) — the caller
//     (server/storage.ts's isSubscriptionCurrentlyActive(), itself a thin
//     wrapper around filterByActiveConnection()) resolves this against the
//     DB; it's passed in here as a plain boolean so this function stays
//     pure and independently testable. This is exactly the "disconnect race
//     condition" the phase's spec calls out: a subscription visible when its
//     reminder was generated can become hidden (Gmail disconnected, or a
//     different account now active) by the time remindAt actually arrives.
//
// Deliberately does NOT decide "is this due yet" (remindAt <= now) or
// "is this reminder already SENT/SKIPPED" — those are the SQL WHERE clause's
// job (storage.ts's getDueSubscriptionReminders/claimSubscriptionReminderForSending),
// a DB-layer guarantee verified live rather than simulated here, consistent
// with this codebase's convention throughout.
import type { ShadowSubscription } from "@shared/schema";
import { evaluateReminderEligibility } from "./subscriptionLifecycle";

export type ReminderDeliveryDecision =
  | { action: "skip"; reason: string }
  | { action: "attempt" };

export function decideReminderDeliveryAction(
  subscription: ShadowSubscription,
  isCurrentlyActive: boolean,
  now: Date,
  timezone: string
): ReminderDeliveryDecision {
  const evaluation = evaluateReminderEligibility(subscription, now, timezone);
  if (!evaluation.eligible) {
    return { action: "skip", reason: `no longer eligible: ${evaluation.reason}` };
  }
  if (!isCurrentlyActive) {
    return { action: "skip", reason: "hidden by active Gmail connection isolation" };
  }
  return { action: "attempt" };
}
