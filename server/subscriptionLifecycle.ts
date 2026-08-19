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
  "eventType" | "extractedPrice" | "extractedCurrency" | "extractedDate" | "userId" | "canonicalMerchantDomain"
>;

export type SubscriptionLifecycleUpdate = {
  transition: LifecycleTransitionResult;
  fields: {
    subscriptionStatus?: LifecycleState;
    amount?: string | null;
    currency?: string | null;
    nextBillingDate?: string | null;
  };
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
 */
export function applyEventToSubscription(
  event: LifecycleRelevantEvent,
  subscription: ShadowSubscription
): SubscriptionLifecycleUpdate {
  const transition = computeLifecycleTransition(subscription.subscriptionStatus as LifecycleState, event.eventType);

  const fields: SubscriptionLifecycleUpdate["fields"] = {};

  if (transition.kind === "state_change") {
    fields.subscriptionStatus = transition.to;
  }

  if (transition.kind !== "no_op" && BILLING_DATA_EVENT_TYPES.has(event.eventType)) {
    if (event.extractedPrice) fields.amount = event.extractedPrice;
    if (event.extractedCurrency) fields.currency = event.extractedCurrency;
    if (event.extractedDate) fields.nextBillingDate = event.extractedDate;
  }

  return { transition, fields };
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

// Mirrors routes.ts's getTimezoneOffsetMs() exactly — duplicated rather than
// imported so this module has zero dependency on routes.ts (routes.ts
// imports FROM server modules in this codebase, never the reverse) and so
// the existing computeReminders() code path is not touched at all, per this
// phase's strict boundary.
function getTimezoneOffsetMs(timezone: string, refDate: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(refDate);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0");
    // Some ICU builds format midnight as "24" instead of "00" even with
    // hour12:false — normalize so a spurious 24h offset never sneaks in at
    // local midnight (found empirically while testing this function; the
    // original routes.ts copy has the same latent issue, left untouched
    // per this phase's boundaries since it's out of scope to fix there).
    const localH = get("hour") % 24;
    const localM = get("minute");
    const utcH = refDate.getUTCHours();
    const utcM = refDate.getUTCMinutes();
    return ((localH - utcH) * 60 + (localM - utcM)) * 60 * 1000;
  } catch {
    return 0;
  }
}

/**
 * computeSubscriptionReminderPlan(): same 3-day/2-day/1-day-before math as
 * routes.ts's computeReminders(), reimplemented (not imported/called) so
 * that function stays completely untouched. targetDateStr is
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
