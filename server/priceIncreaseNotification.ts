// ─── Price Increase Notification — pure decision logic ─────────────────────
//
// Mirrors server/reminderDelivery.ts's separation of concerns exactly: pure,
// independently-testable decisions here; DB orchestration in storage.ts;
// actual sending in email.ts. No DB access, no classification — this module
// only ever answers two questions: "does this detected price change warrant
// a notification record at all" and "should an already-created notification
// actually be sent right now."
//
// Deliberately does NOT reclassify or re-derive what counts as a genuine
// increase — that's priceChangeDetector.ts's job (changeType), untouched
// here. buildPriceIncreaseNotificationRecord() only ever gates on the
// classification priceChangeDetector.ts already produced.
import type { PriceChange } from "./priceChangeDetector";
import type { InsertPriceIncreaseNotification } from "@shared/schema";

// Same exact-marker convention as REMINDERS_DISABLED_SKIP_REASON
// (reminderDelivery.ts) — an exact-string match, not a fragile parse, so
// this reason is unambiguous wherever it's read back.
export const PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON = "price increase notifications disabled by user";

export type PriceIncreaseNotificationDecision =
  | { action: "skip"; reason: string }
  | { action: "attempt" };

/**
 * buildPriceIncreaseNotificationRecord(): translates a PriceChangeResult's
 * `latestChange` into an insertable row — or null when it isn't a genuine
 * increase. Returning null (rather than throwing) lets the caller treat
 * "nothing to notify about" as the ordinary case it is: a first-known
 * price, a decrease, a currency change, an interval change, or an
 * unrecoverable/malformed pair all structurally produce a changeType other
 * than "increase" (or produce no `latestChange` at all) in
 * priceChangeDetector.ts already — this function adds no additional
 * filtering beyond that single check, so it can never diverge from that
 * module's own classification.
 */
export function buildPriceIncreaseNotificationRecord(
  change: PriceChange,
  subscriptionId: string,
  userId: string
): Omit<InsertPriceIncreaseNotification, "id" | "createdAt" | "status" | "sentAt" | "provider" | "providerMessageId" | "lastError" | "claimedAt"> | null {
  if (change.changeType !== "increase") return null;

  return {
    subscriptionId,
    userId,
    detectedAt: change.detectedAt,
    previousAmount: change.previousAmount,
    previousCurrency: change.previousCurrency,
    previousInterval: change.previousInterval,
    newAmount: change.newAmount,
    newCurrency: change.newCurrency,
    newInterval: change.newInterval,
    percentageChange: String(change.percentageChange),
    monthlyImpact: String(change.monthlyImpact),
    annualImpact: String(change.annualImpact),
  };
}

/**
 * decidePriceIncreaseNotificationAction(): the delivery-time gate, checked
 * immediately before claiming a PENDING/FAILED notification row. Two
 * independent reasons to skip, same "disconnect race condition" logic
 * subscription reminders already apply (decideReminderDeliveryAction):
 *   - the user has turned this notification off since the row was created
 *   - the subscription is no longer visible under the user's current active
 *     Gmail connection (hidden/disconnected since the increase was detected)
 * Deliberately does NOT re-run price-change eligibility — a detected
 * increase doesn't "expire" the way a date-based reminder can; it either
 * still happened or it didn't, and priceChangeDetector.ts's classification
 * at creation time is authoritative.
 */
export function decidePriceIncreaseNotificationAction(
  notificationsEnabledForUser: boolean,
  isCurrentlyActive: boolean
): PriceIncreaseNotificationDecision {
  if (!notificationsEnabledForUser) {
    return { action: "skip", reason: PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON };
  }
  if (!isCurrentlyActive) {
    return { action: "skip", reason: "hidden by active Gmail connection isolation" };
  }
  return { action: "attempt" };
}
