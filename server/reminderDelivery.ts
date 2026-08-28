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

// Phase 4.4: the exact, stable marker used BOTH when a reminder is skipped
// because the user turned subscription reminders off (here, and in
// storage.ts's skipPendingRemindersForDisabledUser()) AND when deciding
// whether a SKIPPED row is safe to revive on re-enable
// (storage.ts's reviveSkippedRemindersForUser()) — an exact-string match,
// never a fragile parse of a dynamic reason, so re-enabling can never
// accidentally resurrect a reminder that was skipped for an unrelated cause
// (dismissed subscription, hidden by connection isolation, etc).
export const REMINDERS_DISABLED_SKIP_REASON = "reminders disabled by user";

export type ReminderDeliveryDecision =
  | { action: "skip"; reason: string }
  | { action: "attempt" };

// Phase 4.4: the cutoff computation for stale-SENDING recovery, extracted
// as its own pure function for the same reason getTimezoneOffsetMs() was
// extracted earlier in this project — small, easy-to-get-subtly-wrong
// arithmetic deserves a direct unit test, independent of the SQL query
// (storage.ts's recoverStaleSendingReminders) that actually selects rows
// against it. A claimedAt exactly AT the cutoff is intentionally NOT stale
// (matches the SQL's strict `<` comparison) — only strictly older claims
// are recovered.
export function computeStaleSendingCutoff(now: Date, timeoutMinutes: number): Date {
  return new Date(now.getTime() - timeoutMinutes * 60 * 1000);
}

export function decideReminderDeliveryAction(
  subscription: ShadowSubscription,
  isCurrentlyActive: boolean,
  now: Date,
  timezone: string,
  remindersEnabledForUser: boolean = true
): ReminderDeliveryDecision {
  if (!remindersEnabledForUser) {
    return { action: "skip", reason: REMINDERS_DISABLED_SKIP_REASON };
  }
  const evaluation = evaluateReminderEligibility(subscription, now, timezone);
  if (!evaluation.eligible) {
    return { action: "skip", reason: `no longer eligible: ${evaluation.reason}` };
  }
  if (!isCurrentlyActive) {
    return { action: "skip", reason: "hidden by active Gmail connection isolation" };
  }
  return { action: "attempt" };
}
