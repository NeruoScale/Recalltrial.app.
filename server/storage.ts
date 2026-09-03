import { randomUUID } from "node:crypto";
import { eq, and, isNull, lte, lt, sql, count, desc, inArray, type SQLWrapper } from "drizzle-orm";
import { db } from "./db";
import { users, trials, reminders, analyticsEvents, reviews, suggestedTrials, passwordResetTokens, processedPurchaseEvents, subscriptionEvents, entityResolutionCandidates, subscriptions, subscriptionReminders, aiEnrichmentJobs, emailConnections, priceIncreaseNotifications, type User, type Trial, type Reminder, type Review, type SuggestedTrial, type PasswordResetToken, type InsertSubscriptionEvent, type SubscriptionEvent, type InsertEntityResolutionCandidate, type InsertShadowSubscription, type ShadowSubscription, type SubscriptionReminder, type EmailConnection, type InsertEmailConnection, type PriceIncreaseNotification } from "@shared/schema";
import { decideCanonicalization } from "./canonicalEvents";
import { applyEventToSubscription, evaluateReminderEligibility, type LifecycleRelevantEvent, type LifecycleTransitionResult } from "./subscriptionLifecycle";
import { inferBillingInterval, shouldUpdateBillingIntelligence, type BillingIntervalSource, type BillingIntervalConfidence } from "./billingIntelligence";
import { lookupMerchantKnowledge } from "./merchantKnowledge";
import { buildPriceHistory } from "./priceHistory";
import { detectPriceChanges } from "./priceChangeDetector";
import { buildGmailDisconnectUpdate } from "./gmail";
import { isSubscriptionVisibleForActiveConnection } from "./activeConnectionScope";
import { REMINDERS_DISABLED_SKIP_REASON, computeStaleSendingCutoff } from "./reminderDelivery";
import { buildPriceIncreaseNotificationRecord, PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON } from "./priceIncreaseNotification";
import { resolveEntity, isEligibleForShadowSubscription, deriveShadowSubscription } from "./entityResolver";

// ─── Phase 3B.9.7-PATCH: source-aware conflict resolution ──────────────────────
//
// Mirrors server/sourcePrecedence.ts's isEligibleToUpgrade() rule (ai=4 >
// body=3 > snippet=2 > metadata=1 > null=0) directly in SQL — raw SQL inside
// onConflictDoUpdate() can't call a TS function, so the numbers are
// hand-duplicated here; if sourcePrecedence.ts's table ever changes, this
// must change with it. Equal-tier comparisons resolve to TRUE (>=)
// deliberately: a same-tier re-scan of the same message can carry
// genuinely fresher data (e.g. a merchant's stated price changed between
// two scans of the same email — unlikely but not impossible for a
// re-classification), so equal tiers are allowed to overwrite. This is the
// LIVE re-scan path; server/backfillBodyExtraction.ts's one-time backfill
// additionally checks whether the VALUE itself actually changed before
// counting/writing an update, which matters there for idempotency but is
// unnecessary here.
function sourceRank(columnSql: SQLWrapper) {
  return sql`(CASE ${columnSql} WHEN 'ai' THEN 4 WHEN 'body' THEN 3 WHEN 'snippet' THEN 2 WHEN 'metadata' THEN 1 ELSE 0 END)`;
}

/**
 * buildSourceAwareConflictSet(): the onConflictDoUpdate() `set` clause
 * shared by both insert paths in createSubscriptionEvent() below. Per-field
 * independent — amount/interval/date each compare their OWN provenance
 * column, so e.g. a re-scan with a worse amount but a better interval only
 * upgrades interval, never regresses amount just because they arrived in
 * the same write. Never touches eventType/confidence/detectionSource/etc —
 * those remain owned entirely by classification, not extraction quality.
 */
function buildSourceAwareConflictSet(data: InsertSubscriptionEvent) {
  const amountWins = sql`${sourceRank(sql`excluded.amount_source`)} >= ${sourceRank(subscriptionEvents.amountSource)}`;
  const intervalWins = sql`${sourceRank(sql`excluded.interval_source`)} >= ${sourceRank(subscriptionEvents.intervalSource)}`;
  const dateWins = sql`${sourceRank(sql`excluded.date_source`)} >= ${sourceRank(subscriptionEvents.dateSource)}`;

  return {
    canonicalMerchantName: data.canonicalMerchantName,
    canonicalMerchantDomain: data.canonicalMerchantDomain,
    paymentProcessor: data.paymentProcessor,
    merchantConfidence: data.merchantConfidence,
    merchantResolutionStatus: data.merchantResolutionStatus,
    extractedPrice: sql`CASE WHEN ${amountWins} THEN excluded.extracted_price ELSE ${subscriptionEvents.extractedPrice} END`,
    extractedCurrency: sql`CASE WHEN ${amountWins} THEN excluded.extracted_currency ELSE ${subscriptionEvents.extractedCurrency} END`,
    amountSource: sql`CASE WHEN ${amountWins} THEN excluded.amount_source ELSE ${subscriptionEvents.amountSource} END`,
    billingInterval: sql`CASE WHEN ${intervalWins} THEN excluded.billing_interval ELSE ${subscriptionEvents.billingInterval} END`,
    intervalSource: sql`CASE WHEN ${intervalWins} THEN excluded.interval_source ELSE ${subscriptionEvents.intervalSource} END`,
    extractedDate: sql`CASE WHEN ${dateWins} THEN excluded.extracted_date ELSE ${subscriptionEvents.extractedDate} END`,
    dateSource: sql`CASE WHEN ${dateWins} THEN excluded.date_source ELSE ${subscriptionEvents.dateSource} END`,
    // Bugfix (Phase 3B.9.9): this was missing entirely, so bodyFetched was
    // only ever persisted on a genuine first-time INSERT (no conflict) —
    // any re-scan of an already-known message silently dropped it back to
    // the column's false default regardless of what this scan's `data`
    // said, which meant isEligibleForAI() could never see bodyFetched=true
    // for a previously-scanned message. Sticky-true (OR, not overwrite):
    // once a body fetch has ever succeeded for this row, deterministic
    // extraction has had its full shot at it, and a later scan where the
    // fetch happens to fail (transient Gmail hiccup) must not erase that.
    bodyFetched: sql`(${subscriptionEvents.bodyFetched} OR excluded.body_fetched)`,
  };
}

export interface IStorage {
  getUserById(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined>;
  createUser(email: string, passwordHash: string): Promise<User>;
  updateUserTimezone(userId: string, timezone: string): Promise<User>;
  updateUserStripeInfo(userId: string, data: Partial<Pick<User, "plan" | "stripeCustomerId" | "stripeSubscriptionId" | "subscriptionStatus" | "currentPeriodEnd">>): Promise<User>;
  countActiveTrials(userId: string): Promise<number>;

  getTrialsByUser(userId: string): Promise<Trial[]>;
  getTrialById(trialId: string, userId: string): Promise<Trial | undefined>;
  getTrialByIdPublic(trialId: string): Promise<Trial | undefined>;
  createTrial(data: Omit<Trial, "id" | "createdAt" | "canceledAt">): Promise<Trial>;
  cancelTrial(trialId: string, userId: string): Promise<Trial | undefined>;

  // Phase 2 (Subscription Intelligence, PHASE1_AUDIT.md §18): parallel,
  // observation-only write path.
  createSubscriptionEvent(data: InsertSubscriptionEvent): Promise<SubscriptionEvent | null>;
  queueAIEnrichmentJob(userId: string, subscriptionEventId: string): Promise<boolean>;
  getAIEnrichmentMetrics(): Promise<{
    totalJobs: number;
    byStatus: Record<string, number>;
    avgInputTokens: number;
    avgOutputTokens: number;
    estimatedTotalCostUsd: number;
    fieldsImproved: { amount: number; currency: number; billingInterval: number };
    successRate: number;
  }>;
  getSubscriptionEventMetrics(): Promise<{
    totalCount: number;
    byEventType: { eventType: string; count: number }[];
    byDetectionSource: { detectionSource: string; count: number }[];
    averageConfidence: number;
    recentEvents: {
      eventType: string;
      extractedPrice: string | null;
      extractedCurrency: string | null;
      extractedDate: string | null;
      extractedMerchant: string | null;
      confidence: number;
      detectionSource: string;
      createdAt: Date;
    }[];
  }>;

  // Phase 3B.4: entity resolution shadow mode — see the implementation for
  // the "why" on each.
  getAllSubscriptionEventsForResolution(): Promise<SubscriptionEvent[]>;
  saveEntityResolutionCandidates(candidates: InsertEntityResolutionCandidate[]): Promise<number>;

  // Phase 3B.5: shadow subscriptions — see the implementation for the "why"
  // on each. isShadow is always true; nothing here is read by production UX.
  upsertShadowSubscription(data: InsertShadowSubscription): Promise<ShadowSubscription>;
  // Phase 3B.6: admin shadow-subscription preview dashboard read path.
  getShadowSubscriptionsForDashboard(): Promise<(ShadowSubscription & { userEmail: string })[]>;
  // Phase 3B.7.3: end-user "detected subscriptions" dashboard read path.
  // Phase 3C.2: includeDismissed defaults to false — userDismissed rows are
  // hidden from the main list unless the caller explicitly asks for them
  // (GET /api/subscriptions?showDismissed=true).
  getShadowSubscriptionsForUser(userId: string, includeDismissed?: boolean): Promise<ShadowSubscription[]>;
  // Phase 3B.9.5: subscription vault detail view.
  getShadowSubscriptionById(id: string, userId: string): Promise<ShadowSubscription | undefined>;
  getCanonicalEventsForSubscription(subscription: ShadowSubscription): Promise<SubscriptionEvent[]>;
  // Phase 3C.1: batch variant of the above for endpoints that need canonical
  // events for a user's ENTIRE subscription list at once (savings
  // intelligence) — one query total instead of N, keyed by subscription id.
  getCanonicalEventsForUserSubscriptions(userId: string, subscriptions: ShadowSubscription[]): Promise<Record<string, SubscriptionEvent[]>>;
  getShadowSubscriptionMetrics(): Promise<{
    canonicalEvents: number;
    supersededClassifications: number;
    shadowSubscriptions: number;
    subscriptionsByResolutionStatus: { resolutionStatus: string; count: number }[];
    subscriptionsByEvidenceClass: { resolutionMethod: string; count: number }[];
    processorOnlySkipped: number;
    ambiguousSkipped: number;
    perUserBreakdown: { userId: string; count: number }[];
    perMerchantBreakdown: { canonicalMerchantName: string; count: number }[];
    potentialFalseMerges: number;
    potentialFalseSplits: number;
  }>;

  // Phase 3B.7.4: controlled promotion of eligible shadow subscriptions to
  // active (isShadow=false). See the implementation for the exact
  // eligibility SQL (shared between both methods) and idempotency
  // guarantee. Deliberately does NOT touch trials/reminders — this only
  // flips a flag + records why on the `subscriptions` row itself.
  promoteEligibleShadowSubscriptions(userId?: string): Promise<{ promoted: number; skipped: number; alreadyActive: number }>;
  previewShadowSubscriptionPromotion(userId?: string): Promise<{
    eligible: ShadowSubscription[];
    ineligible: Array<{ subscription: ShadowSubscription; reason: string }>;
    alreadyActive: ShadowSubscription[];
  }>;

  // Phase 3B.8: subscription lifecycle engine — see server/subscriptionLifecycle.ts
  // for the pure decision logic this orchestrates against the DB.
  applyLifecycleEventToSubscription(event: LifecycleRelevantEvent): Promise<{
    applied: boolean;
    transition?: LifecycleTransitionResult;
    subscription?: ShadowSubscription;
  }>;
  generateRemindersForEligibleSubscriptions(subscriptionId?: string): Promise<{ created: number; skipped: number }>;

  // Phase 4.2: subscription-reminder DELIVERY. Mirrors the shape of the
  // legacy trial-reminder methods below (getDueReminders/claimAndSendReminder/
  // markReminderSent/markReminderFailed) — same pattern, new table, no
  // parallel mechanism invented.
  getDueSubscriptionReminders(now: Date): Promise<(SubscriptionReminder & { subscription: ShadowSubscription; user: User })[]>;
  claimSubscriptionReminderForSending(reminderId: string): Promise<SubscriptionReminder | undefined>;
  markSubscriptionReminderSent(reminderId: string, providerMessageId?: string): Promise<void>;
  markSubscriptionReminderFailed(reminderId: string, error: string): Promise<void>;
  markSubscriptionReminderSkipped(reminderId: string, reason: string): Promise<void>;
  isSubscriptionCurrentlyActive(subscription: ShadowSubscription): Promise<boolean>;
  getRemindersForSubscription(subscriptionId: string, userId: string): Promise<SubscriptionReminder[]>;
  toggleSubscriptionReminders(userId: string, enabled: boolean): Promise<User>;
  skipPendingRemindersForDisabledUser(userId: string): Promise<number>;
  reviveSkippedRemindersForUser(userId: string, now: Date): Promise<number>;
  recoverStaleSendingReminders(timeoutMinutes: number, now: Date): Promise<number>;

  // Price Increase Notification: mirrors the subscription-reminder delivery
  // methods immediately above exactly in shape (same atomic-claim pattern,
  // same PENDING/SENDING/SENT/FAILED/SKIPPED vocabulary via the reused
  // reminder_status enum) — a separate table, not a parallel mechanism.
  // No "due at a future time" concept here (unlike remindAt) — a row is
  // notification-worthy the moment it's created, so there's no date filter,
  // only a status filter.
  getPendingPriceIncreaseNotifications(): Promise<(PriceIncreaseNotification & { subscription: ShadowSubscription; user: User })[]>;
  claimPriceIncreaseNotificationForSending(id: string): Promise<PriceIncreaseNotification | undefined>;
  markPriceIncreaseNotificationSent(id: string, providerMessageId?: string): Promise<void>;
  markPriceIncreaseNotificationFailed(id: string, error: string): Promise<void>;
  markPriceIncreaseNotificationSkipped(id: string, reason: string): Promise<void>;
  recoverStalePriceIncreaseNotificationSending(timeoutMinutes: number, now: Date): Promise<number>;
  togglePriceIncreaseNotifications(userId: string, enabled: boolean): Promise<User>;
  skipPendingPriceIncreaseNotificationsForDisabledUser(userId: string): Promise<number>;

  getRemindersByTrial(trialId: string, userId: string): Promise<Reminder[]>;
  createReminder(data: { trialId: string; userId: string; remindAt: Date; type: string }): Promise<Reminder>;
  getDueReminders(now: Date): Promise<(Reminder & { trial: Trial; user: User })[]>;
  claimAndSendReminder(reminderId: string): Promise<boolean>;
  markReminderSent(reminderId: string, providerMessageId?: string): Promise<void>;
  markReminderFailed(reminderId: string, error: string): Promise<void>;
  skipRemindersByTrial(trialId: string): Promise<void>;

  getSubscription(subscriptionId: string): Promise<any>;
  getStripePrices(): Promise<any[]>;

  logEvent(userId: string | null, event: string, metadata?: Record<string, any>): Promise<void>;
  claimPurchaseEvent(checkoutSessionId: string): Promise<boolean>;
  getMetrics(): Promise<{
    totalUsers: number;
    totalTrials: number;
    activeTrials: number;
    canceledTrials: number;
    totalReminders: number;
    sentReminders: number;
    recentEvents: { event: string; count: number }[];
  }>;

  getApprovedReviews(limit?: number): Promise<Review[]>;
  getAllReviews(): Promise<Review[]>;
  createReview(data: { rating: number; text: string; name?: string | null; location?: string | null; source?: string; userId?: string | null; isApproved?: boolean }): Promise<Review>;
  approveReview(reviewId: string): Promise<Review | undefined>;
  deleteReview(reviewId: string): Promise<boolean>;
  toggleFeaturedReview(reviewId: string): Promise<Review | undefined>;

  updateUserGmailTokens(userId: string, tokens: { accessToken: string; refreshToken: string | null; expiry: Date | null }): Promise<void>;
  clearUserGmailTokens(userId: string): Promise<void>;

  // Account Isolation architecture, PHASE A: email_connections storage layer.
  // Dual-write alongside (never instead of) the users Gmail columns above —
  // see server/migrate.ts's table comment for why. Unwired from the actual
  // connect/disconnect/scan routes until PHASE B/C actually have identity
  // data worth writing.
  createEmailConnection(data: InsertEmailConnection): Promise<EmailConnection>;
  getActiveEmailConnection(userId: string, provider?: string): Promise<EmailConnection | undefined>;
  getEmailConnectionById(id: string): Promise<EmailConnection | undefined>;
  disconnectEmailConnection(id: string): Promise<EmailConnection | undefined>;
  updateEmailConnectionTokens(id: string, tokens: { accessToken: string; refreshToken: string | null; expiry: Date | null }): Promise<EmailConnection | undefined>;
  // Active Connection Isolation: called at disconnect time to retroactively
  // attribute any of this user's never-explicitly-owned subscriptions to the
  // connection that's closing — see storage.ts's implementation comment.
  attributeUnownedSubscriptionsToConnection(userId: string, connectionId: string): Promise<number>;
  toggleEmailScanning(userId: string, enabled: boolean): Promise<User>;
  toggleAiScanning(userId: string, enabled: boolean): Promise<User>;
  recordAiScanningConsent(userId: string, version: string): Promise<void>;
  updateLastEmailScan(userId: string, messagesProcessed?: number): Promise<void>;
  getProUsersWithScanningEnabled(): Promise<User[]>;
  getUsersDueForMonthlyAiCreditGrant(): Promise<User[]>;

  getSuggestedTrials(userId: string): Promise<SuggestedTrial[]>;
  upsertSuggestedTrial(data: Omit<SuggestedTrial, "id" | "createdAt" | "status"> & { userId: string }): Promise<void>;
  markSuggestedTrialAdded(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  markSuggestedTrialIgnored(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  getSuggestedTrialById(id: string, userId: string): Promise<SuggestedTrial | undefined>;

  createPasswordResetToken(userId: string, token: string, expiresAt: Date): Promise<PasswordResetToken>;
  getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined>;
  consumePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;

  // Phase 3C.2: savings-opportunity dismissal — stored in users.preferences
  // (jsonb), never a new table, since this is display-only per-user UI
  // state. Scoped entirely by userId; a subscription id dismissed by one
  // user has no effect on any other user's savings section.
  getDismissedSavingsOpportunityIds(userId: string): Promise<string[]>;
  dismissSavingsOpportunity(userId: string, subscriptionId: string): Promise<string[]>;

  // Phase 3C.2: explicit user acknowledgement of a detected subscription.
  // Both scoped by (id AND userId) together, matching getShadowSubscriptionById's
  // exact cross-user-isolation pattern — a cross-user id update affects 0
  // rows and returns undefined, never another user's row.
  confirmSubscription(id: string, userId: string): Promise<ShadowSubscription | undefined>;
  dismissSubscription(id: string, userId: string): Promise<ShadowSubscription | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return user;
  }

  async getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId)).limit(1);
    return user;
  }

  async createUser(email: string, passwordHash: string): Promise<User> {
    const [user] = await db.insert(users).values({ email, passwordHash }).returning();
    return user;
  }

  async updateUserTimezone(userId: string, timezone: string): Promise<User> {
    const [user] = await db.update(users).set({ timezone }).where(eq(users.id, userId)).returning();
    return user;
  }

  async updateUserStripeInfo(userId: string, data: Partial<Pick<User, "plan" | "stripeCustomerId" | "stripeSubscriptionId" | "subscriptionStatus" | "currentPeriodEnd">>): Promise<User> {
    const [user] = await db.update(users).set(data).where(eq(users.id, userId)).returning();
    return user;
  }

  async countActiveTrials(userId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` }).from(trials)
      .where(and(eq(trials.userId, userId), eq(trials.status, "ACTIVE")));
    return result[0]?.count ?? 0;
  }

  async getTrialsByUser(userId: string): Promise<Trial[]> {
    return db.select().from(trials).where(eq(trials.userId, userId)).orderBy(trials.endDate);
  }

  async getTrialById(trialId: string, userId: string): Promise<Trial | undefined> {
    const [trial] = await db.select().from(trials)
      .where(and(eq(trials.id, trialId), eq(trials.userId, userId)))
      .limit(1);
    return trial;
  }

  async getTrialByIdPublic(trialId: string): Promise<Trial | undefined> {
    const [trial] = await db.select().from(trials)
      .where(eq(trials.id, trialId))
      .limit(1);
    return trial;
  }

  async createTrial(data: Omit<Trial, "id" | "createdAt" | "canceledAt">): Promise<Trial> {
    const [trial] = await db.insert(trials).values(data).returning();
    return trial;
  }

  async cancelTrial(trialId: string, userId: string): Promise<Trial | undefined> {
    const [trial] = await db.update(trials)
      .set({ status: "CANCELED", canceledAt: new Date() })
      .where(and(eq(trials.id, trialId), eq(trials.userId, userId)))
      .returning();
    return trial;
  }

  async getRemindersByTrial(trialId: string, userId: string): Promise<Reminder[]> {
    return db.select().from(reminders)
      .where(and(eq(reminders.trialId, trialId), eq(reminders.userId, userId)))
      .orderBy(reminders.remindAt);
  }

  async createReminder(data: { trialId: string; userId: string; remindAt: Date; type: string }): Promise<Reminder> {
    const [reminder] = await db.insert(reminders).values({
      trialId: data.trialId,
      userId: data.userId,
      remindAt: data.remindAt,
      type: data.type as any,
    }).returning();
    return reminder;
  }

  async getDueReminders(now: Date): Promise<(Reminder & { trial: Trial; user: User })[]> {
    const results = await db
      .select({ reminder: reminders, trial: trials, user: users })
      .from(reminders)
      .innerJoin(trials, eq(reminders.trialId, trials.id))
      .innerJoin(users, eq(reminders.userId, users.id))
      .where(and(eq(reminders.status, "PENDING"), lte(reminders.remindAt, now), eq(trials.status, "ACTIVE")));

    return results.map((r) => ({ ...r.reminder, trial: r.trial, user: r.user }));
  }

  async claimAndSendReminder(reminderId: string): Promise<boolean> {
    const result = await db.update(reminders)
      .set({ status: "SENT", sentAt: new Date() })
      .where(and(eq(reminders.id, reminderId), eq(reminders.status, "PENDING")))
      .returning();
    return result.length > 0;
  }

  async markReminderSent(reminderId: string, providerMessageId?: string): Promise<void> {
    await db.update(reminders)
      .set({
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: providerMessageId || null,
        lastError: null,
      })
      .where(eq(reminders.id, reminderId));
  }

  async markReminderFailed(reminderId: string, error: string): Promise<void> {
    await db.update(reminders)
      .set({
        status: "FAILED",
        lastError: error,
      })
      .where(eq(reminders.id, reminderId));
  }

  async skipRemindersByTrial(trialId: string): Promise<void> {
    await db.update(reminders)
      .set({ status: "SKIPPED" })
      .where(and(eq(reminders.trialId, trialId), eq(reminders.status, "PENDING")));
  }

  async getSubscription(subscriptionId: string): Promise<any> {
    const result = await db.execute(
      sql`SELECT * FROM stripe.subscriptions WHERE id = ${subscriptionId}`
    );
    return result.rows[0] || null;
  }

  async getStripePrices(): Promise<any[]> {
    const result = await db.execute(
      sql`SELECT * FROM stripe.prices WHERE active = true ORDER BY unit_amount ASC`
    );
    return result.rows;
  }

  async logEvent(userId: string | null, event: string, metadata?: Record<string, any>): Promise<void> {
    try {
      await db.insert(analyticsEvents).values({
        userId: userId ?? undefined,
        event,
        metadata: metadata ? JSON.stringify(metadata) : null,
      });
    } catch (err) {
      console.error("Failed to log analytics event:", err);
    }
  }

  async claimPurchaseEvent(checkoutSessionId: string): Promise<boolean> {
    const result = await db.insert(processedPurchaseEvents)
      .values({ checkoutSessionId })
      .onConflictDoNothing()
      .returning({ id: processedPurchaseEvents.id });
    return result.length > 0;
  }

  async getMetrics(): Promise<{
    totalUsers: number;
    totalTrials: number;
    activeTrials: number;
    canceledTrials: number;
    totalReminders: number;
    sentReminders: number;
    recentEvents: { event: string; count: number }[];
  }> {
    const [userCount] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    const [trialCount] = await db.select({ count: sql<number>`count(*)::int` }).from(trials);
    const [activeCount] = await db.select({ count: sql<number>`count(*)::int` }).from(trials).where(eq(trials.status, "ACTIVE"));
    const [canceledCount] = await db.select({ count: sql<number>`count(*)::int` }).from(trials).where(eq(trials.status, "CANCELED"));
    const [reminderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(reminders);
    const [sentCount] = await db.select({ count: sql<number>`count(*)::int` }).from(reminders).where(eq(reminders.status, "SENT"));

    const eventCounts = await db
      .select({ event: analyticsEvents.event, count: sql<number>`count(*)::int` })
      .from(analyticsEvents)
      .groupBy(analyticsEvents.event)
      .orderBy(sql`count(*) desc`);

    return {
      totalUsers: userCount?.count ?? 0,
      totalTrials: trialCount?.count ?? 0,
      activeTrials: activeCount?.count ?? 0,
      canceledTrials: canceledCount?.count ?? 0,
      totalReminders: reminderCount?.count ?? 0,
      sentReminders: sentCount?.count ?? 0,
      recentEvents: eventCounts.map((r) => ({ event: r.event, count: r.count })),
    };
  }

  async getApprovedReviews(limit?: number): Promise<Review[]> {
    const query = db.select().from(reviews)
      .where(eq(reviews.isApproved, true))
      .orderBy(desc(reviews.createdAt));
    if (limit) return query.limit(limit);
    return query;
  }

  async getAllReviews(): Promise<Review[]> {
    return db.select().from(reviews).orderBy(desc(reviews.createdAt));
  }

  async createReview(data: { rating: number; text: string; name?: string | null; location?: string | null; source?: string; userId?: string | null; isApproved?: boolean }): Promise<Review> {
    const [review] = await db.insert(reviews).values({
      rating: data.rating,
      text: data.text,
      name: data.name || null,
      location: data.location || null,
      source: (data.source || "manual") as any,
      userId: data.userId || null,
      isApproved: data.isApproved ?? false,
    }).returning();
    return review;
  }

  async approveReview(reviewId: string): Promise<Review | undefined> {
    const [review] = await db.update(reviews)
      .set({ isApproved: true })
      .where(eq(reviews.id, reviewId))
      .returning();
    return review;
  }

  async deleteReview(reviewId: string): Promise<boolean> {
    const result = await db.delete(reviews).where(eq(reviews.id, reviewId)).returning();
    return result.length > 0;
  }

  async toggleFeaturedReview(reviewId: string): Promise<Review | undefined> {
    const [existing] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!existing) return undefined;
    const [review] = await db.update(reviews)
      .set({ isFeatured: !existing.isFeatured })
      .where(eq(reviews.id, reviewId))
      .returning();
    return review;
  }

  async updateUserGmailTokens(userId: string, tokens: { accessToken: string; refreshToken: string | null; expiry: Date | null }): Promise<void> {
    await db.update(users).set({
      gmailAccessToken: tokens.accessToken,
      gmailRefreshToken: tokens.refreshToken,
      gmailTokenExpiry: tokens.expiry,
      gmailConnected: true,
    }).where(eq(users.id, userId));
  }

  // Account-switch isolation fix (Gmail Account Switching audit, TASK 1) —
  // see server/gmail.ts's buildGmailDisconnectUpdate() for why
  // lastEmailScanAt/lastScanMessagesProcessed are reset here too, not just
  // the token fields.
  async clearUserGmailTokens(userId: string): Promise<void> {
    await db.update(users).set(buildGmailDisconnectUpdate()).where(eq(users.id, userId));
  }

  // ── Account Isolation architecture, PHASE A: email_connections storage ──

  async createEmailConnection(data: InsertEmailConnection): Promise<EmailConnection> {
    const [row] = await db.insert(emailConnections).values(data).returning();
    return row;
  }

  // The partial unique index (user_id, provider WHERE disconnected_at IS NULL)
  // guarantees at most one row could ever match this query — .limit(1) here
  // is defensive redundancy, not reliance on it being the only source of
  // that guarantee.
  async getActiveEmailConnection(userId: string, provider: string = "google"): Promise<EmailConnection | undefined> {
    const [row] = await db
      .select()
      .from(emailConnections)
      .where(and(
        eq(emailConnections.userId, userId),
        eq(emailConnections.provider, provider),
        isNull(emailConnections.disconnectedAt)
      ))
      .limit(1);
    return row;
  }

  async getEmailConnectionById(id: string): Promise<EmailConnection | undefined> {
    const [row] = await db.select().from(emailConnections).where(eq(emailConnections.id, id)).limit(1);
    return row;
  }

  // Sets disconnectedAt, never deletes the row — the whole point of this
  // table is to preserve connection HISTORY (server/migrate.ts's table
  // comment), so a disconnect is a state transition, not a deletion.
  async disconnectEmailConnection(id: string): Promise<EmailConnection | undefined> {
    const [row] = await db
      .update(emailConnections)
      .set({ disconnectedAt: new Date() })
      .where(and(eq(emailConnections.id, id), isNull(emailConnections.disconnectedAt)))
      .returning();
    return row;
  }

  async updateEmailConnectionTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | null; expiry: Date | null }
  ): Promise<EmailConnection | undefined> {
    const [row] = await db
      .update(emailConnections)
      .set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenExpiry: tokens.expiry })
      .where(eq(emailConnections.id, id))
      .returning();
    return row;
  }

  // Active Connection Isolation: a subscription with lastEventEmailConnectionId
  // still null has never been explicitly attributed to a connection — either
  // it predates this architecture, or its user has never disconnected since.
  // Called right as a connection is closing (POST /api/gmail/disconnect),
  // this retroactively records "this connection was the only source of this
  // user's evidence up to now," which is simply true, not fabricated — it's
  // what lets getShadowSubscriptionsForUser() correctly hide these rows the
  // moment a genuinely DIFFERENT connection later becomes active, without
  // incorrectly hiding them for a user who has never switched accounts at
  // all (see isSubscriptionVisibleForActiveConnection's null-owner rule).
  // Never touches a subscription that already has an owner.
  async attributeUnownedSubscriptionsToConnection(userId: string, connectionId: string): Promise<number> {
    const result = await db
      .update(subscriptions)
      .set({ lastEventEmailConnectionId: connectionId, updatedAt: new Date() })
      .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.lastEventEmailConnectionId)))
      .returning({ id: subscriptions.id });
    return result.length;
  }

  // Active Connection Isolation: the single chokepoint every active-view
  // consumer (vault, savings, recommendations, analyst, subscription detail)
  // filters through. Gated behind subscriptionIntelligenceEnabled — the same
  // controlled-beta flag every prior Account Isolation phase used — so a
  // non-beta user's behavior is completely unchanged. Two more passthrough
  // cases exist deliberately: a user with Gmail fully disconnected via the
  // legacy columns (gmailConnected=false) sees zero active subscriptions
  // regardless of ownership data; a beta user who is CONNECTED but has never
  // been through a Phase B/C connect (no email_connections row at all yet)
  // is left completely unfiltered — this is what keeps sikeayoub4@gmail.com
  // (connected, never reconnected since this architecture shipped) from
  // losing visibility into their own still-valid data the moment this ships.
  private async filterByActiveConnection(userId: string, rows: ShadowSubscription[]): Promise<ShadowSubscription[]> {
    if (rows.length === 0) return rows;

    const user = await this.getUserById(userId);
    if (!user?.subscriptionIntelligenceEnabled) return rows;
    if (!user.gmailConnected) return [];

    const activeConnection = await this.getActiveEmailConnection(userId, "google");
    if (!activeConnection) return rows;

    const ownerIds = Array.from(new Set(
      rows.map((r) => r.lastEventEmailConnectionId).filter((id): id is string => id !== null)
    ));
    const ownerConnections = ownerIds.length
      ? await db.select().from(emailConnections).where(inArray(emailConnections.id, ownerIds))
      : [];
    const ownerById = new Map(ownerConnections.map((c) => [c.id, c]));

    return rows.filter((r) => isSubscriptionVisibleForActiveConnection(
      r.lastEventEmailConnectionId,
      r.lastEventEmailConnectionId ? ownerById.get(r.lastEventEmailConnectionId) : undefined,
      activeConnection
    ));
  }

  // Phase 4.2: a single-subscription public wrapper around
  // filterByActiveConnection() — used by the reminder DELIVERY path to
  // re-check ownership immediately before sending (the disconnect race
  // condition: a subscription can become hidden between when its reminder
  // row was created and when it becomes due). Same exact mechanism the
  // vault/savings/recommendations/analyst already rely on — no second
  // ownership check invented.
  async isSubscriptionCurrentlyActive(subscription: ShadowSubscription): Promise<boolean> {
    const [visible] = await this.filterByActiveConnection(subscription.userId, [subscription]);
    return !!visible;
  }

  async toggleEmailScanning(userId: string, enabled: boolean): Promise<User> {
    const [user] = await db.update(users).set({ emailScanningEnabled: enabled }).where(eq(users.id, userId)).returning();
    return user;
  }

  async toggleAiScanning(userId: string, enabled: boolean): Promise<User> {
    const [user] = await db.update(users).set({ aiScanningEnabled: enabled }).where(eq(users.id, userId)).returning();
    return user;
  }

  // Phase 3B.9.10 STEP 7: recorded ONLY on the transition to enabled (see
  // the route), never cleared on disable — it's a historical record of
  // "when/under what version did this user last consent," not a live flag
  // (aiScanningEnabled itself is the live flag).
  async recordAiScanningConsent(userId: string, version: string): Promise<void> {
    await db.update(users).set({ aiScanningConsentAt: new Date(), aiScanningConsentVersion: version }).where(eq(users.id, userId));
  }

  async updateLastEmailScan(userId: string, messagesProcessed?: number): Promise<void> {
    await db.update(users)
      .set({
        lastEmailScanAt: new Date(),
        ...(messagesProcessed !== undefined ? { lastScanMessagesProcessed: messagesProcessed } : {}),
      })
      .where(eq(users.id, userId));
  }

  async getProUsersWithScanningEnabled(): Promise<User[]> {
    // Ordered by lastEmailScanAt (NULLS FIRST) so scanning rotates fairly
    // across users instead of always favoring whichever rows Postgres
    // happens to return first. lastEmailScanAt is only ever set by
    // updateLastEmailScan(), called after a user's scan fully completes
    // (routes.ts, POST /api/cron/email-scan) — so it represents completed
    // scan time, making "oldest completed scan first" the correct ordering
    // for who gets scanned next when a batch is capped.
    return db.select().from(users).where(
      and(
        inArray(users.plan, ["PRO", "PREMIUM"]),
        eq(users.emailScanningEnabled, true),
        eq(users.gmailConnected, true),
      )
    ).orderBy(sql`${users.lastEmailScanAt} ASC NULLS FIRST`);
  }

  // Phase 3B.9.10 STEP 4: candidates for a monthly AI-credit grant. Free
  // plan is excluded entirely (creditsForPlan("FREE") is 0 anyway, so
  // including them would just be wasted work). The actual 30-day
  // idempotency check is re-verified atomically inside
  // grantMonthlyCredits() itself — this query is a coarse candidate list,
  // not the source of truth for "is this user actually due."
  async getUsersDueForMonthlyAiCreditGrant(): Promise<User[]> {
    return db.select().from(users).where(
      and(
        inArray(users.plan, ["PLUS", "PRO", "PREMIUM"]),
        sql`(${users.aiCreditsResetAt} IS NULL OR ${users.aiCreditsResetAt} < now() - interval '30 days')`,
      )
    );
  }

  async createSubscriptionEvent(data: InsertSubscriptionEvent): Promise<SubscriptionEvent | null> {
    // Phase 3B.3 note: a re-scan of a message already classified with the
    // same (userId, sourceMessageId, eventType) — expected whenever the
    // classifier itself hasn't changed since the last scan — used to be a
    // silent no-op (onConflictDoNothing), which meant new columns added
    // after a row already existed (like Phase 3B.3's merchant-resolution
    // fields) could never backfill onto it. Now upserts merchant fields
    // unconditionally, and upserts extractedPrice/extractedCurrency/
    // billingInterval/extractedDate too — but ONLY per-field, and ONLY when
    // buildSourceAwareConflictSet()'s precedence check says the new value's
    // source is at least as good as what's already stored (Phase
    // 3B.9.7-PATCH). A worse-sourced re-scan (e.g. snippet-only) can never
    // regress a field a previous body-fetch already improved.
    //
    // Phase 3B.5: a re-scan that lands on a DIFFERENT eventType than the
    // message's current canonical row is a reclassification, not an
    // independent event — see server/canonicalEvents.ts for the decision
    // logic. This whole method runs in a transaction so the "old row
    // superseded + new row canonical" state change is atomic.
    // Phase 3B.9.9: widened from a narrow lifecycle-only Pick<> to the full
    // row — server/gmail.ts's AI-enrichment queueing (STEP 4) needs
    // isCanonical/bodyFetched/amountSource/intervalSource, not just the
    // lifecycle-relevant subset the previous phase needed.
    const writtenRow: SubscriptionEvent | null = await db.transaction(async (tx): Promise<SubscriptionEvent | null> => {
      const existingRows = await tx
        .select()
        .from(subscriptionEvents)
        .where(and(eq(subscriptionEvents.userId, data.userId), eq(subscriptionEvents.sourceMessageId, data.sourceMessageId)));

      const decision = decideCanonicalization(existingRows, data.eventType);

      if (decision.kind === "same_classification") {
        const [row] = await tx.insert(subscriptionEvents).values(data)
          .onConflictDoUpdate({
            target: [subscriptionEvents.userId, subscriptionEvents.sourceMessageId, subscriptionEvents.eventType],
            set: buildSourceAwareConflictSet(data),
          })
          .returning();
        return row ?? null;
      }

      // first_generation or reclassification: this scan produces a new
      // canonical row. A pre-generated id lets canonicalEventId point at
      // "this row's own id" within the same insert. The onConflictDoUpdate
      // target is a safety net for the rare cycling case (eventType goes
      // A -> B -> A again) — it resurrects the old A row as canonical
      // instead of violating the (userId, sourceMessageId, eventType)
      // unique constraint by inserting a second row with the same
      // eventType; canonicalEventId there self-references the target row's
      // own (unchanged) id rather than the discarded `excluded.id`.
      const newRowId = randomUUID();
      const generation = decision.kind === "reclassification" ? decision.newGeneration : 1;

      const [canonicalRow] = await tx.insert(subscriptionEvents).values({
        ...data,
        id: newRowId,
        classificationGeneration: generation,
        isCanonical: true,
        canonicalEventId: newRowId,
        supersededBy: null,
      })
        .onConflictDoUpdate({
          target: [subscriptionEvents.userId, subscriptionEvents.sourceMessageId, subscriptionEvents.eventType],
          set: {
            ...buildSourceAwareConflictSet(data),
            classificationGeneration: generation,
            isCanonical: true,
            canonicalEventId: sql`${subscriptionEvents.id}`,
            supersededBy: null,
          },
        })
        .returning();

      if (!canonicalRow) return null;

      if (decision.kind === "reclassification") {
        await tx.update(subscriptionEvents)
          .set({ isCanonical: false, supersededBy: canonicalRow.id, canonicalEventId: canonicalRow.id })
          .where(eq(subscriptionEvents.id, decision.oldCanonicalRow.id));

        if (decision.chainRowIdsToRelink.length > 0) {
          await tx.update(subscriptionEvents)
            .set({ canonicalEventId: canonicalRow.id })
            .where(inArray(subscriptionEvents.id, decision.chainRowIdsToRelink));
        }
      }

      return canonicalRow;
    });

    // Phase 3B.8: the lifecycle engine runs AFTER the event write commits,
    // in its own try/catch — a lifecycle failure must never affect whether
    // the underlying subscription_event write succeeded or roll it back.
    // Same isolation pattern as gmail.ts's sub-detector write relative to
    // the trial-suggestion pipeline.
    //
    // Phase 3B.9.7-PATCH: uses writtenRow's ACTUAL post-merge stored values,
    // not the raw incoming `data` — when the conflict-resolution above
    // PRESERVED an existing higher-quality field (e.g. kept a body-sourced
    // price over this scan's worse snippet-only price), the lifecycle
    // engine must see what's really in the row now, not what this
    // particular scan happened to propose.
    if (writtenRow) {
      try {
        await this.applyLifecycleEventToSubscription({
          id: writtenRow.id,
          eventType: writtenRow.eventType,
          extractedPrice: writtenRow.extractedPrice,
          extractedCurrency: writtenRow.extractedCurrency,
          extractedDate: writtenRow.extractedDate,
          userId: writtenRow.userId,
          canonicalMerchantDomain: writtenRow.canonicalMerchantDomain,
          billingInterval: writtenRow.billingInterval,
          emailConnectionId: writtenRow.emailConnectionId,
        });
      } catch (err) {
        console.error("[Lifecycle] failed to apply event to subscription:", err);
      }
    }

    return writtenRow;
  }

  // Phase 3B.9.9 STEP 4: idempotency is the UNIQUE constraint on
  // subscription_event_id + onConflictDoNothing — not a pre-check SELECT.
  // Returns whether a NEW row was actually inserted (false on a genuine
  // conflict — a job already exists for this event), purely for the
  // caller's own logging; gmail.ts's scan must never block or throw on
  // either outcome.
  async queueAIEnrichmentJob(userId: string, subscriptionEventId: string): Promise<boolean> {
    const result = await db.insert(aiEnrichmentJobs)
      .values({ userId, subscriptionEventId, status: "pending" })
      .onConflictDoNothing({ target: aiEnrichmentJobs.subscriptionEventId })
      .returning({ id: aiEnrichmentJobs.id });
    return result.length > 0;
  }

  // Phase 3B.9.9 STEP 6: aggregate observability only — same "no per-user
  // detail, counts/averages only" shape as getSubscriptionEventMetrics()
  // above, which this deliberately mirrors.
  async getAIEnrichmentMetrics(): Promise<{
    totalJobs: number;
    byStatus: Record<string, number>;
    avgInputTokens: number;
    avgOutputTokens: number;
    estimatedTotalCostUsd: number;
    fieldsImproved: { amount: number; currency: number; billingInterval: number };
    successRate: number;
  }> {
    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(aiEnrichmentJobs);

    const byStatusRows = await db
      .select({ status: aiEnrichmentJobs.status, count: sql<number>`count(*)::int` })
      .from(aiEnrichmentJobs)
      .groupBy(aiEnrichmentJobs.status);

    const [aggRow] = await db.select({
      avgInput: sql<number>`coalesce(avg(${aiEnrichmentJobs.inputTokenCount}), 0)::float`,
      avgOutput: sql<number>`coalesce(avg(${aiEnrichmentJobs.outputTokenCount}), 0)::float`,
      totalCost: sql<number>`coalesce(sum(${aiEnrichmentJobs.estimatedCostUsd}), 0)::float`,
    }).from(aiEnrichmentJobs);

    const byStatus: Record<string, number> = { pending: 0, processing: 0, completed: 0, failed: 0, dead_letter: 0 };
    for (const r of byStatusRows) byStatus[r.status] = r.count;

    const completedRows = await db
      .select({ fieldsImproved: aiEnrichmentJobs.fieldsImproved })
      .from(aiEnrichmentJobs)
      .where(eq(aiEnrichmentJobs.status, "completed"));

    const fieldsImproved = { amount: 0, currency: 0, billingInterval: 0 };
    for (const row of completedRows) {
      for (const field of row.fieldsImproved ?? []) {
        if (field === "amount") fieldsImproved.amount++;
        else if (field === "currency") fieldsImproved.currency++;
        else if (field === "billingInterval") fieldsImproved.billingInterval++;
      }
    }

    const terminalCount = byStatus.completed + byStatus.failed + byStatus.dead_letter;

    return {
      totalJobs: totalRow?.count ?? 0,
      byStatus,
      avgInputTokens: aggRow?.avgInput ?? 0,
      avgOutputTokens: aggRow?.avgOutput ?? 0,
      estimatedTotalCostUsd: aggRow?.totalCost ?? 0,
      fieldsImproved,
      successRate: terminalCount > 0 ? byStatus.completed / terminalCount : 0,
    };
  }

  async getSubscriptionEventMetrics(): Promise<{
    totalCount: number;
    byEventType: { eventType: string; count: number }[];
    byDetectionSource: { detectionSource: string; count: number }[];
    averageConfidence: number;
    recentEvents: {
      eventType: string;
      extractedPrice: string | null;
      extractedCurrency: string | null;
      extractedDate: string | null;
      extractedMerchant: string | null;
      confidence: number;
      detectionSource: string;
      createdAt: Date;
    }[];
  }> {
    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(subscriptionEvents);

    const byEventType = await db
      .select({ eventType: subscriptionEvents.eventType, count: sql<number>`count(*)::int` })
      .from(subscriptionEvents)
      .groupBy(subscriptionEvents.eventType)
      .orderBy(sql`count(*) desc`);

    const byDetectionSource = await db
      .select({ detectionSource: subscriptionEvents.detectionSource, count: sql<number>`count(*)::int` })
      .from(subscriptionEvents)
      .groupBy(subscriptionEvents.detectionSource)
      .orderBy(sql`count(*) desc`);

    const [avgRow] = await db
      .select({ avg: sql<number>`coalesce(avg(${subscriptionEvents.confidence}), 0)::float` })
      .from(subscriptionEvents);

    // Extracted/structured fields only — no sourceMessageId, no userId, no
    // raw email content. This is an aggregate observability endpoint, not
    // a per-user data view.
    const recentEvents = await db
      .select({
        eventType: subscriptionEvents.eventType,
        extractedPrice: subscriptionEvents.extractedPrice,
        extractedCurrency: subscriptionEvents.extractedCurrency,
        extractedDate: subscriptionEvents.extractedDate,
        extractedMerchant: subscriptionEvents.extractedMerchant,
        confidence: subscriptionEvents.confidence,
        detectionSource: subscriptionEvents.detectionSource,
        createdAt: subscriptionEvents.createdAt,
      })
      .from(subscriptionEvents)
      .orderBy(desc(subscriptionEvents.createdAt))
      .limit(5);

    return {
      totalCount: totalRow?.count ?? 0,
      byEventType: byEventType.map((r) => ({ eventType: r.eventType, count: r.count })),
      byDetectionSource: byDetectionSource.map((r) => ({ detectionSource: r.detectionSource, count: r.count })),
      averageConfidence: avgRow?.avg ?? 0,
      recentEvents,
    };
  }

  // Phase 3B.4: entity resolution SHADOW MODE only — read-only source data
  // for server/entityResolver.ts, and a snapshot-style write of its
  // proposed groupings. Nothing here is read by any other part of the app.
  //
  // Phase 3B.5: scoped to isCanonical=true only — a message's superseded
  // classification generations must never be treated as independent events
  // by the resolver (a hard boundary of this phase).
  async getAllSubscriptionEventsForResolution(): Promise<SubscriptionEvent[]> {
    return db.select().from(subscriptionEvents).where(eq(subscriptionEvents.isCanonical, true));
  }

  async saveEntityResolutionCandidates(candidates: InsertEntityResolutionCandidate[]): Promise<number> {
    // Snapshot semantics, not an accumulating log: resolveEntity() mints a
    // fresh proposedSubscriptionId on every call (documented as shadow-only,
    // not stable across runs), so re-running without clearing first would
    // just pile up redundant rows describing the same proposed groupings.
    // Replace-on-write keeps this table representing "what we'd propose
    // right now," which is what an observation table should show.
    return db.transaction(async (tx) => {
      await tx.delete(entityResolutionCandidates);
      if (candidates.length === 0) return 0;
      const inserted = await tx.insert(entityResolutionCandidates).values(candidates).returning({ id: entityResolutionCandidates.id });
      return inserted.length;
    });
  }

  // Phase 3B.5: SHADOW SUBSCRIPTIONS ONLY — isShadow is always true today.
  // Upsert on (userId, entityKey) so repeated resolver runs are idempotent:
  // same input always converges to the same row instead of piling up
  // duplicates (Step 3's requirement).
  async upsertShadowSubscription(data: InsertShadowSubscription): Promise<ShadowSubscription> {
    const [row] = await db.insert(subscriptions).values(data)
      .onConflictDoUpdate({
        target: [subscriptions.userId, subscriptions.entityKey],
        set: {
          canonicalMerchantName: data.canonicalMerchantName,
          canonicalMerchantDomain: data.canonicalMerchantDomain,
          merchantConfidence: data.merchantConfidence,
          resolutionMethod: data.resolutionMethod,
          resolutionStatus: data.resolutionStatus,
          planName: data.planName,
          subscriptionStatus: data.subscriptionStatus,
          amount: data.amount,
          currency: data.currency,
          billingInterval: data.billingInterval,
          nextBillingDate: data.nextBillingDate,
          lastBillingDate: data.lastBillingDate,
          sourceCanonicalEventId: data.sourceCanonicalEventId,
          potentialFalseMerge: data.potentialFalseMerge,
          potentialFalseSplit: data.potentialFalseSplit,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // Phase 3B.6: admin-only preview dashboard. Reads exclusively from
  // `subscriptions` — never from subscription_events/entity_resolution_
  // candidates directly — so the dashboard can only ever show what already
  // passed the full Gmail -> classification -> canonical event -> entity
  // resolution -> shadow subscription pipeline (including the HARD SAFETY
  // RULE in entityResolver.ts's isEligibleForShadowSubscription()). There is
  // no unresolved/ambiguous row to filter out here because those never make
  // it into this table in the first place.
  async getShadowSubscriptionsForDashboard(): Promise<(ShadowSubscription & { userEmail: string })[]> {
    const rows = await db
      .select({ subscription: subscriptions, userEmail: users.email })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(eq(subscriptions.isShadow, true))
      .orderBy(users.email, subscriptions.canonicalMerchantName);
    return rows.map((r) => ({ ...r.subscription, userEmail: r.userEmail }));
  }

  // Phase 3B.7.3: scoped to one user (tenant-isolated, session-authenticated
  // caller only — see requireAuth in routes.ts) AND resolutionStatus=
  // "resolved" only. Ambiguous/unresolved/conflict rows never reach this far
  // in practice (only "resolved" groups ever become a `subscriptions` row at
  // all, per entityResolver.ts's isEligibleForShadowSubscription()), but the
  // resolutionStatus filter is kept explicit here anyway so this query stays
  // correct on its own even if that upstream invariant ever changes.
  //
  // Phase 3B.7.4 note: deliberately does NOT filter on isShadow anymore.
  // Promotion only flips isShadow false and stamps promotedAt/
  // promotionReason/promotionEvidence — it never changes resolutionStatus,
  // so a promoted row is exactly as "detected, not confirmed" as it was the
  // moment before promotion, and the end-user dashboard must keep showing
  // it (Step 6's explicit requirement) rather than having it silently
  // disappear the instant it's promoted.
  async getShadowSubscriptionsForUser(userId: string, includeDismissed = false): Promise<ShadowSubscription[]> {
    const conditions = [
      eq(subscriptions.userId, userId),
      eq(subscriptions.resolutionStatus, "resolved"),
    ];
    if (!includeDismissed) {
      conditions.push(eq(subscriptions.userDismissed, false));
    }
    const rows = await db
      .select()
      .from(subscriptions)
      .where(and(...conditions))
      .orderBy(subscriptions.canonicalMerchantName);
    return this.filterByActiveConnection(userId, rows);
  }

  // Phase 3B.9.5: subscription vault detail view. Scoped by id AND userId in
  // the same WHERE clause (matches getTrialById's exact pattern) — a
  // cross-user id comes back as undefined here, which is what lets the route
  // return 404 (never 403) without an extra ownership check leaking anything.
  async getShadowSubscriptionById(id: string, userId: string): Promise<ShadowSubscription | undefined> {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
      .limit(1);
    if (!sub) return undefined;
    // Active Connection Isolation: a direct-by-id lookup must not bypass the
    // same active-connection visibility the list view applies — otherwise a
    // deep link would leak a disconnected account's subscription. Filtered
    // out here comes back undefined, which the route already turns into a
    // 404 (never 403), matching this route's existing cross-user-id pattern.
    const [visible] = await this.filterByActiveConnection(userId, [sub]);
    return visible;
  }

  // Phase 3C.2: "Track Subscription" — an explicit user acknowledgement,
  // deliberately independent of amount/billingInterval (works when
  // amount=null). Scoped by (id AND userId) together, same pattern as
  // getShadowSubscriptionById above: a cross-user id updates 0 rows and
  // returns undefined.
  async confirmSubscription(id: string, userId: string): Promise<ShadowSubscription | undefined> {
    const [sub] = await db
      .update(subscriptions)
      .set({ userConfirmed: true, userConfirmedAt: new Date() })
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
      .returning();
    return sub;
  }

  // Phase 3C.2: hides a subscription from the main list without deleting it
  // (preserved for audit) — see getShadowSubscriptionsForUser's includeDismissed param.
  async dismissSubscription(id: string, userId: string): Promise<ShadowSubscription | undefined> {
    const [sub] = await db
      .update(subscriptions)
      .set({ userDismissed: true, userDismissedAt: new Date() })
      .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
      .returning();
    return sub;
  }

  // Phase 3C.2: savings-opportunity dismissal lives in users.preferences
  // (jsonb) rather than a new table — display-only per-user UI state, never
  // read by lifecycle/billing/reminder logic.
  async getDismissedSavingsOpportunityIds(userId: string): Promise<string[]> {
    const user = await this.getUserById(userId);
    return user?.preferences?.dismissedSavingsOpportunities ?? [];
  }

  async dismissSavingsOpportunity(userId: string, subscriptionId: string): Promise<string[]> {
    const user = await this.getUserById(userId);
    const current = user?.preferences?.dismissedSavingsOpportunities ?? [];
    if (current.includes(subscriptionId)) return current;
    const updated = [...current, subscriptionId];
    await db
      .update(users)
      .set({ preferences: { ...(user?.preferences ?? {}), dismissedSavingsOpportunities: updated } })
      .where(eq(users.id, userId));
    return updated;
  }

  // Phase 3B.9.6A Step 4: PRIMARY lookup is now the real subscriptionId FK
  // (populated going forward by applyLifecycleEventToSubscription() above,
  // and backfilled for the historical backlog by server/migrate.ts's
  // one-time backfill). The userId+domain/name heuristic below is now only
  // a FALLBACK for whatever the backfill couldn't uniquely resolve
  // (ambiguous or unmatched rows) — logged explicitly whenever it fires so
  // that usage is visible/auditable, not silent.
  async getCanonicalEventsForSubscription(subscription: ShadowSubscription): Promise<SubscriptionEvent[]> {
    const byForeignKey = await db
      .select()
      .from(subscriptionEvents)
      .where(and(
        eq(subscriptionEvents.subscriptionId, subscription.id),
        eq(subscriptionEvents.isCanonical, true)
      ))
      .orderBy(desc(subscriptionEvents.createdAt));

    if (byForeignKey.length > 0) {
      return byForeignKey;
    }

    console.log(`[Vault] using merchant-match fallback for event (subscriptionId not populated): ${subscription.canonicalMerchantName}`);

    const merchantMatch = subscription.canonicalMerchantDomain
      ? eq(subscriptionEvents.canonicalMerchantDomain, subscription.canonicalMerchantDomain)
      : and(
          isNull(subscriptionEvents.canonicalMerchantDomain),
          eq(subscriptionEvents.canonicalMerchantName, subscription.canonicalMerchantName)
        );

    return db
      .select()
      .from(subscriptionEvents)
      .where(and(
        eq(subscriptionEvents.userId, subscription.userId),
        eq(subscriptionEvents.isCanonical, true),
        merchantMatch
      ))
      .orderBy(desc(subscriptionEvents.createdAt));
  }

  // Phase 3C.1: same FK-then-merchant-fallback matching as
  // getCanonicalEventsForSubscription() above, but for a user's whole
  // subscription list in ONE query rather than N — avoids the N+1 pattern a
  // naive per-subscription loop would create for savings intelligence.
  async getCanonicalEventsForUserSubscriptions(
    userId: string,
    subscriptions: ShadowSubscription[]
  ): Promise<Record<string, SubscriptionEvent[]>> {
    const allEvents = await db
      .select()
      .from(subscriptionEvents)
      .where(and(eq(subscriptionEvents.userId, userId), eq(subscriptionEvents.isCanonical, true)))
      .orderBy(desc(subscriptionEvents.createdAt));

    const byForeignKey = new Map<string, SubscriptionEvent[]>();
    const unmatched: SubscriptionEvent[] = [];
    for (const event of allEvents) {
      if (event.subscriptionId) {
        const list = byForeignKey.get(event.subscriptionId) ?? [];
        list.push(event);
        byForeignKey.set(event.subscriptionId, list);
      } else {
        unmatched.push(event);
      }
    }

    const result: Record<string, SubscriptionEvent[]> = {};
    for (const sub of subscriptions) {
      const fkMatches = byForeignKey.get(sub.id);
      if (fkMatches && fkMatches.length > 0) {
        result[sub.id] = fkMatches;
        continue;
      }
      result[sub.id] = unmatched.filter((event) =>
        sub.canonicalMerchantDomain
          ? event.canonicalMerchantDomain === sub.canonicalMerchantDomain
          : event.canonicalMerchantDomain === null && event.canonicalMerchantName === sub.canonicalMerchantName
      );
    }
    return result;
  }

  async getShadowSubscriptionMetrics(): Promise<{
    canonicalEvents: number;
    supersededClassifications: number;
    shadowSubscriptions: number;
    subscriptionsByResolutionStatus: { resolutionStatus: string; count: number }[];
    subscriptionsByEvidenceClass: { resolutionMethod: string; count: number }[];
    processorOnlySkipped: number;
    ambiguousSkipped: number;
    perUserBreakdown: { userId: string; count: number }[];
    perMerchantBreakdown: { canonicalMerchantName: string; count: number }[];
    potentialFalseMerges: number;
    potentialFalseSplits: number;
  }> {
    const [canonicalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.isCanonical, true));

    const [supersededRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.isCanonical, false));

    const [shadowRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.isShadow, true));

    const subscriptionsByResolutionStatus = await db
      .select({ resolutionStatus: subscriptions.resolutionStatus, count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .groupBy(subscriptions.resolutionStatus)
      .orderBy(sql`count(*) desc`);

    const subscriptionsByEvidenceClass = await db
      .select({ resolutionMethod: subscriptions.resolutionMethod, count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .groupBy(subscriptions.resolutionMethod)
      .orderBy(sql`count(*) desc`);

    // processor_only and ambiguous candidates are ones entityResolver.ts
    // already decided are NOT shadow-eligible — they live in the Phase 3B.4
    // entity_resolution_candidates snapshot table, never in `subscriptions`.
    const [processorOnlyRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(entityResolutionCandidates)
      .where(eq(entityResolutionCandidates.resolutionMethod, "processor_body_match"));

    const [ambiguousRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(entityResolutionCandidates)
      .where(eq(entityResolutionCandidates.resolutionStatus, "ambiguous"));

    const perUserBreakdown = await db
      .select({ userId: subscriptions.userId, count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .groupBy(subscriptions.userId)
      .orderBy(sql`count(*) desc`);

    const perMerchantBreakdown = await db
      .select({ canonicalMerchantName: subscriptions.canonicalMerchantName, count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .groupBy(subscriptions.canonicalMerchantName)
      .orderBy(sql`count(*) desc`);

    const [falseMergeRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.potentialFalseMerge, true));

    const [falseSplitRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.potentialFalseSplit, true));

    return {
      canonicalEvents: canonicalRow?.count ?? 0,
      supersededClassifications: supersededRow?.count ?? 0,
      shadowSubscriptions: shadowRow?.count ?? 0,
      subscriptionsByResolutionStatus,
      subscriptionsByEvidenceClass,
      processorOnlySkipped: processorOnlyRow?.count ?? 0,
      ambiguousSkipped: ambiguousRow?.count ?? 0,
      perUserBreakdown,
      perMerchantBreakdown,
      potentialFalseMerges: falseMergeRow?.count ?? 0,
      potentialFalseSplits: falseSplitRow?.count ?? 0,
    };
  }

  // ── Phase 3B.7.4: controlled production activation ──────────────────────────
  //
  // Eligibility (all six conditions from the task, all enforced in SQL, not
  // application code):
  //   1. is_shadow = true                         (WHERE clause)
  //   2/4. resolution_status = 'resolved'          (WHERE clause — this alone
  //        also rules out "conflict" status by definition, since a row can't
  //        equal both 'resolved' and 'conflict')
  //   3. resolution_method = 'domain_match'        (WHERE clause — excludes
  //        name_match, processor_body_match, ambiguous_platform_name)
  //   5. canonical_merchant_domain IS NOT NULL     (WHERE clause)
  //   6. userId exists and is valid                — already guaranteed
  //        structurally: subscriptions.user_id has a NOT NULL FK to
  //        users.id, so Postgres itself makes this condition impossible to
  //        violate. No redundant EXISTS join added for a check the schema
  //        already enforces.
  // Plus the explicit "DO NOT promote... potentialFalseMerge=true" rule from
  // the task, folded in as a seventh WHERE condition even though it wasn't
  // in the numbered list of six.
  //
  // The trailing NOT EXISTS guards against ever having two ACTIVE rows for
  // the same (userId, canonicalMerchantDomain) — provably redundant today
  // given the (userId, entityKey) unique constraint (entityKey IS the
  // domain for domain_match rows), but kept exactly as the task specified
  // it: defense in depth against that invariant ever changing.
  //
  // shadowPromotionEligibilityWhere() is shared verbatim between the real
  // UPDATE and the dry-run preview SELECT below, so the two can never drift
  // apart into "preview says eligible, real run disagrees."
  private shadowPromotionEligibilityWhere(userId?: string) {
    const userScope = userId ? sql`AND user_id = ${userId}` : sql``;
    return sql`
      is_shadow = true
      AND resolution_status = 'resolved'
      AND resolution_method = 'domain_match'
      AND canonical_merchant_domain IS NOT NULL
      AND potential_false_merge = false
      ${userScope}
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s2
        WHERE s2.user_id = subscriptions.user_id
          AND s2.canonical_merchant_domain = subscriptions.canonical_merchant_domain
          AND s2.is_shadow = false
      )
    `;
  }

  async promoteEligibleShadowSubscriptions(userId?: string): Promise<{ promoted: number; skipped: number; alreadyActive: number }> {
    const userScope = userId ? sql`AND user_id = ${userId}` : sql``;

    const totalShadowResult = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM subscriptions WHERE is_shadow = true ${userScope}
    `);
    const alreadyActiveResult = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM subscriptions WHERE is_shadow = false ${userScope}
    `);

    // Idempotency: on a second run, every previously-promoted row already
    // has is_shadow=false, so `WHERE is_shadow = true` alone excludes it —
    // promoted converges to 0 with no duplicate active rows, while
    // alreadyActive (computed above, BEFORE this UPDATE runs) reports how
    // many rows didn't need promoting because a prior run already handled
    // them.
    const updateResult = await db.execute(sql`
      UPDATE subscriptions
      SET
        is_shadow = false,
        promoted_at = NOW(),
        promotion_reason = 'domain_match_controlled_activation',
        promotion_evidence = 'resolutionMethod=' || resolution_method ||
          ', merchantConfidence=' || COALESCE(merchant_confidence::text, 'unknown')
      WHERE ${this.shadowPromotionEligibilityWhere(userId)}
      RETURNING id
    `);

    const promoted = updateResult.rowCount ?? 0;
    const totalShadow = Number((totalShadowResult.rows[0] as any)?.count ?? 0);
    const alreadyActive = Number((alreadyActiveResult.rows[0] as any)?.count ?? 0);

    return { promoted, skipped: totalShadow - promoted, alreadyActive };
  }

  async previewShadowSubscriptionPromotion(userId?: string): Promise<{
    eligible: ShadowSubscription[];
    ineligible: Array<{ subscription: ShadowSubscription; reason: string }>;
    alreadyActive: ShadowSubscription[];
  }> {
    const userScope = userId ? sql`AND user_id = ${userId}` : sql``;

    const eligibleResult = await db.execute(sql`
      SELECT * FROM subscriptions WHERE ${this.shadowPromotionEligibilityWhere(userId)}
    `);

    // Mirrors the same conditions as shadowPromotionEligibilityWhere() but
    // as a CASE expression instead of a boolean filter, so every ineligible
    // shadow row comes back with a specific, human-readable reason rather
    // than a bare exclusion.
    const ineligibleResult = await db.execute(sql`
      SELECT *,
        CASE
          WHEN resolution_status != 'resolved' THEN 'resolutionStatus is ' || resolution_status || ', not resolved'
          WHEN resolution_method != 'domain_match' THEN 'resolutionMethod is ' || resolution_method || ', not domain_match'
          WHEN canonical_merchant_domain IS NULL THEN 'no canonical merchant domain'
          WHEN potential_false_merge = true THEN 'flagged as a potential false merge'
          WHEN EXISTS (
            SELECT 1 FROM subscriptions s2
            WHERE s2.user_id = subscriptions.user_id
              AND s2.canonical_merchant_domain = subscriptions.canonical_merchant_domain
              AND s2.is_shadow = false
          ) THEN 'an active subscription already exists for this user+domain'
          ELSE 'ineligible'
        END AS reason
      FROM subscriptions
      WHERE is_shadow = true
        AND NOT (${this.shadowPromotionEligibilityWhere(userId)})
        ${userScope}
    `);

    const alreadyActiveResult = await db.execute(sql`
      SELECT * FROM subscriptions WHERE is_shadow = false ${userScope}
    `);

    return {
      eligible: eligibleResult.rows.map((r) => this.mapSubscriptionRow(r)),
      ineligible: ineligibleResult.rows.map((r: any) => ({
        subscription: this.mapSubscriptionRow(r),
        reason: r.reason as string,
      })),
      alreadyActive: alreadyActiveResult.rows.map((r) => this.mapSubscriptionRow(r)),
    };
  }

  private mapSubscriptionRow(r: any): ShadowSubscription {
    return {
      id: r.id,
      userId: r.user_id,
      entityKey: r.entity_key,
      canonicalMerchantName: r.canonical_merchant_name,
      canonicalMerchantDomain: r.canonical_merchant_domain,
      merchantConfidence: r.merchant_confidence,
      resolutionMethod: r.resolution_method,
      resolutionStatus: r.resolution_status,
      planName: r.plan_name,
      subscriptionStatus: r.subscription_status,
      amount: r.amount,
      currency: r.currency,
      billingInterval: r.billing_interval,
      billingIntervalSource: r.billing_interval_source,
      billingIntervalConfidence: r.billing_interval_confidence,
      nextBillingDate: r.next_billing_date,
      lastBillingDate: r.last_billing_date,
      sourceCanonicalEventId: r.source_canonical_event_id,
      isShadow: r.is_shadow,
      potentialFalseMerge: r.potential_false_merge,
      potentialFalseSplit: r.potential_false_split,
      promotedAt: r.promoted_at,
      promotionReason: r.promotion_reason,
      promotionEvidence: r.promotion_evidence,
      lastPriceChangeAt: r.last_price_change_at,
      lastPriceChangeType: r.last_price_change_type,
      lastPriceChangeAbsolute: r.last_price_change_absolute,
      lastPriceChangePercentage: r.last_price_change_percentage,
      lastPriceChangeAnnualImpact: r.last_price_change_annual_impact,
      userConfirmed: r.user_confirmed,
      userConfirmedAt: r.user_confirmed_at,
      userDismissed: r.user_dismissed,
      userDismissedAt: r.user_dismissed_at,
      lastEventEmailConnectionId: r.last_event_email_connection_id,
      crossAccountConflict: r.cross_account_conflict,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ── Phase 3B.8: subscription lifecycle engine ────────────────────────────────
  //
  // "resolve existing subscription (by userId + canonicalMerchantDomain)" —
  // if canonicalMerchantDomain is null (processor-only/no-domain events) or
  // no matching subscriptions row exists, this is a deliberate no-op: entity
  // resolution owns creation, this engine only ever updates something that
  // already exists (STEP 2's explicit rule).
  // Phase 3D: live wiring for the entity-resolution -> Vault creation step.
  // resolveEntity()/isEligibleForShadowSubscription()/deriveShadowSubscription()
  // (server/entityResolver.ts) and upsertShadowSubscription() (above in this
  // file) have existed since Phase 3B.4/3B.5 but were never actually invoked
  // from the live scan path — audit confirmed upsertShadowSubscription() had
  // zero callers anywhere in the codebase, so every `subscriptions` row in
  // production was created by a one-time manual run, not an ongoing
  // pipeline. This is the ONLY live trigger, called from
  // applyLifecycleEventToSubscription() exactly once, the moment a
  // genuinely new merchant (no existing subscriptions row for this
  // userId+domain) is seen. Reuses the exact same pure resolver functions
  // and the exact same upsertShadowSubscription() write path the shadow-mode
  // dashboard already relied on — no parallel resolver, no new eligibility
  // rule, no bypass of canonical merchant identity, no change to the
  // (userId, entityKey) ownership model.
  //
  // Deliberately re-resolves against ALL of this user's canonical events for
  // this domain (not just the one new event) — resolveEntity() groups by
  // evidence across the whole history, so a merchant that only becomes
  // eligible once a SECOND corroborating event arrives (e.g. name_match,
  // which requires events.length >= 2) is correctly picked up the moment
  // that second event lands, not just on a domain_match's very first event.
  private async attemptShadowSubscriptionCreation(event: LifecycleRelevantEvent): Promise<ShadowSubscription | undefined> {
    const domainEvents = await db
      .select()
      .from(subscriptionEvents)
      .where(and(
        eq(subscriptionEvents.userId, event.userId),
        // Safe: the only caller (applyLifecycleEventToSubscription) already
        // returns early when canonicalMerchantDomain is null, before this
        // method is ever reached.
        eq(subscriptionEvents.canonicalMerchantDomain, event.canonicalMerchantDomain!),
        eq(subscriptionEvents.isCanonical, true)
      ));

    const groups = resolveEntity(domainEvents);
    const group = groups.find((g) => g.events.some((e) => e.id === event.id));
    if (!group || !isEligibleForShadowSubscription(group)) {
      return undefined;
    }

    const candidate = deriveShadowSubscription(group);
    if (!candidate) return undefined;

    // Never fabricate provenance: this is exactly the connection this event
    // itself already carried (resolved by the caller before
    // createSubscriptionEvent() ran), or null if none was available —
    // never guessed, never backfilled from unrelated history.
    const created = await this.upsertShadowSubscription({
      ...candidate,
      lastEventEmailConnectionId: event.emailConnectionId ?? null,
    });
    console.log(`[Lifecycle] created new Vault subscription for ${created.canonicalMerchantName} (${created.resolutionMethod}, entityKey=${created.entityKey})`);
    return created;
  }

  async applyLifecycleEventToSubscription(event: LifecycleRelevantEvent): Promise<{
    applied: boolean;
    transition?: LifecycleTransitionResult;
    subscription?: ShadowSubscription;
  }> {
    if (!event.canonicalMerchantDomain) {
      return { applied: false };
    }

    const [existingRow] = await db
      .select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, event.userId),
        eq(subscriptions.canonicalMerchantDomain, event.canonicalMerchantDomain)
      ))
      .limit(1);

    let existing: ShadowSubscription | undefined = existingRow;

    // Phase 3D: no subscriptions/Vault row exists yet for this user+domain —
    // attempt to create one via the SAME entity-resolution pipeline the
    // shadow-mode dashboard has always used (resolveEntity() ->
    // isEligibleForShadowSubscription() -> deriveShadowSubscription() ->
    // upsertShadowSubscription(), all in ./entityResolver and above in this
    // file). This is the ONLY live trigger for that pipeline — see
    // attemptShadowSubscriptionCreation()'s own comment for why it was
    // previously never invoked. If the evidence isn't eligible yet (e.g. a
    // single low-confidence event, an ambiguous platform name), this
    // correctly creates nothing — the exact same conservative bar the
    // shadow-mode dashboard always enforced, unchanged.
    if (!existing) {
      existing = await this.attemptShadowSubscriptionCreation(event);
    }

    if (!existing) {
      return { applied: false };
    }

    // Phase 3B.9.6A Step 3: immediately stamp this canonical event with the
    // subscription it resolved to — every future event now gets an
    // authoritative FK at write time, rather than relying on the
    // userId+domain/name heuristic that getCanonicalEventsForSubscription()
    // still needs as a fallback for the historical backlog (see
    // server/migrate.ts's one-time backfill for those). Safe to run
    // unconditionally on every call (not just when something else changes):
    // the value is stable once set, so re-setting it to the same id is a
    // harmless no-op write.
    await db.update(subscriptionEvents)
      .set({ subscriptionId: existing.id })
      .where(eq(subscriptionEvents.id, event.id));

    // Account Isolation architecture, PHASES D/E/F: both the cross-account
    // conflict protection (RULE 1-4, in applyEventToSubscription itself) and
    // the late-scan protection below (RULE 6) are gated behind the SAME
    // controlled-beta flag as the rest of Subscription Intelligence V1 — a
    // non-beta user's lifecycle updates behave EXACTLY as they did before
    // this architecture existed. See shared/schema.ts's
    // subscriptionIntelligenceEnabled comment for why this flag is the
    // right reuse rather than a new one.
    const user = await this.getUserById(event.userId);
    const crossAccountProtectionEnabled = !!user?.subscriptionIntelligenceEnabled;

    let isKnownDifferentAccount: boolean | null = null;

    if (crossAccountProtectionEnabled && event.emailConnectionId) {
      const [eventConnection] = await db
        .select()
        .from(emailConnections)
        .where(eq(emailConnections.id, event.emailConnectionId))
        .limit(1);

      // RULE 6: a late-committing scan writing AFTER its own connection was
      // disconnected must not mutate the live subscription. The event row
      // itself is already durably stored (createSubscriptionEvent() already
      // ran, before this function is ever called) — evidence is never
      // lost, only the billing-state APPLICATION is skipped.
      if (eventConnection && eventConnection.disconnectedAt !== null) {
        console.log(`[Lifecycle] event ${event.id} came from a now-disconnected connection (${eventConnection.id}) — evidence retained, billing state NOT applied`);
        return { applied: false };
      }

      if (existing.lastEventEmailConnectionId) {
        if (event.emailConnectionId === existing.lastEventEmailConnectionId) {
          isKnownDifferentAccount = false; // literally the same connection row
        } else {
          const [lastConnection] = await db
            .select()
            .from(emailConnections)
            .where(eq(emailConnections.id, existing.lastEventEmailConnectionId))
            .limit(1);
          if (eventConnection?.providerAccountId && lastConnection?.providerAccountId) {
            // Compare STABLE account identity, not the session row id —
            // reconnecting the SAME Gmail account must never look like a
            // switch just because it's a new connection row.
            isKnownDifferentAccount = eventConnection.providerAccountId !== lastConnection.providerAccountId;
          } else {
            // providerAccountId unavailable on one/both sides (a
            // pre-PHASE-B connection whose identity was never captured) —
            // the raw connection ids are the only signal available, and
            // they're already known to differ.
            isKnownDifferentAccount = true;
          }
        }
      }
    }

    const { transition, fields, billingIntervalChange } = applyEventToSubscription(
      event,
      existing,
      crossAccountProtectionEnabled,
      isKnownDifferentAccount
    );

    if (Object.keys(fields).length === 0) {
      // no_op, or a data_update whose event carried no actual new data —
      // nothing to write, but still report the transition for logging.
      if (transition.kind === "state_change") {
        console.log(`[Lifecycle] ${existing.canonicalMerchantName}: ${transition.from} -> ${transition.to} (${transition.reason})`);
      }
      // Phase 3B.9.3: billing intelligence still runs even when the base
      // lifecycle update itself was a no-op — new evidence for interval
      // inference accumulates regardless of whether THIS event also
      // triggered a state/data change.
      const withBillingIntel = await this.runBillingIntelligence(existing);
      const withPriceChange = await this.runPriceChangeDetection(withBillingIntel);
      return { applied: transition.kind !== "no_op", transition, subscription: withPriceChange };
    }

    const [updated] = await db
      .update(subscriptions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(subscriptions.id, existing.id))
      .returning();

    if (transition.kind === "state_change") {
      console.log(`[Lifecycle] ${existing.canonicalMerchantName}: ${transition.from} -> ${transition.to} (${transition.reason})`);
    } else {
      console.log(`[Lifecycle] ${existing.canonicalMerchantName}: ${transition.kind} (${transition.reason})`);
    }
    if (billingIntervalChange) {
      console.log(`[Lifecycle] billingInterval updated: ${billingIntervalChange.from ?? "null"} -> ${billingIntervalChange.to}`);
    }
    if (fields.crossAccountConflict === true) {
      console.log(`[Lifecycle] ${existing.canonicalMerchantName}: cross-account conflict detected — existing billing facts preserved, new evidence retained but not applied`);
    }

    const withBillingIntel = await this.runBillingIntelligence(updated);
    const withPriceChange = await this.runPriceChangeDetection(withBillingIntel);
    return { applied: true, transition, subscription: withPriceChange };
  }

  // ── Phase 3B.9.3: billing intelligence orchestration ──────────────────────────
  //
  // Runs Tiers 1/3/4 (inferBillingInterval(), against EVERY canonical event
  // for this subscription — not just the one that just came in, since
  // recurrence inference needs the full history) and falls back to Tier 2
  // (merchant knowledge) ONLY when that comes back "unknown" — the literal
  // STEP 3/4 rule ("only apply merchant knowledge when billingInterval is
  // currently null/unknown"). Never writes anything when
  // shouldUpdateBillingIntelligence() says the existing tier already beats
  // or matches the candidate, and never writes a null interval over a
  // known one (the tier-0 "unknown" candidate can only ever match an
  // already-unknown current state, per the tier ranking, so this is
  // structurally guaranteed, not just conventionally followed).
  private async runBillingIntelligence(subscription: ShadowSubscription): Promise<ShadowSubscription> {
    const canonicalEvents = await db
      .select()
      .from(subscriptionEvents)
      .where(and(
        eq(subscriptionEvents.userId, subscription.userId),
        eq(subscriptionEvents.canonicalMerchantDomain, subscription.canonicalMerchantDomain ?? ""),
        eq(subscriptionEvents.isCanonical, true)
      ));

    let candidate = inferBillingInterval(canonicalEvents);

    if (candidate.billingIntervalSource === "unknown") {
      const known = lookupMerchantKnowledge(subscription.canonicalMerchantDomain);
      if (known) {
        candidate = {
          billingInterval: known.billingInterval,
          billingIntervalSource: "merchant_knowledge",
          billingIntervalConfidence: known.confidence,
          evidenceCount: 0,
          inferenceMethod: `known merchant billing pattern (${known.planName ?? known.domain})`,
        };
      }
    }

    if (candidate.billingInterval === null) return subscription;

    const currentSource: BillingIntervalSource = (subscription.billingIntervalSource as BillingIntervalSource) || "unknown";
    if (!shouldUpdateBillingIntelligence({ source: currentSource }, { source: candidate.billingIntervalSource })) {
      return subscription;
    }

    const [updated] = await db
      .update(subscriptions)
      .set({
        billingInterval: candidate.billingInterval,
        billingIntervalSource: candidate.billingIntervalSource,
        billingIntervalConfidence: candidate.billingIntervalConfidence,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id))
      .returning();

    console.log(
      `[Lifecycle] billing intelligence: ${subscription.canonicalMerchantName} -> ${candidate.billingInterval} ` +
      `(${candidate.billingIntervalSource}, ${candidate.billingIntervalConfidence} confidence, ${candidate.inferenceMethod})`
    );

    return updated;
  }

  // ── Phase 3B.9.8: price change detection orchestration ────────────────────────
  //
  // Per the approved architectural decision for this phase, price
  // observations are INDEPENDENT of subscriptions.amount and Phase 3B.8's
  // lifecycle state machine: this method NEVER writes subscriptions.amount
  // (that stays owned entirely by applyEventToSubscription()'s existing
  // BILLING_DATA_EVENT_TYPES rule, untouched here) — it only records the
  // most recent DETECTED change as its own separate lastPriceChange*
  // fields. Runs against EVERY canonical event for this subscription
  // (same query shape as runBillingIntelligence() above, deliberately not
  // filtered by eventType) so a one_time_purchase event's price
  // contributes to the observation timeline exactly like any other event —
  // it still never causes a lifecycle transition or touches `amount`,
  // per STEP 1's hard rule.
  private async runPriceChangeDetection(subscription: ShadowSubscription): Promise<ShadowSubscription> {
    const canonicalEvents = await db
      .select()
      .from(subscriptionEvents)
      .where(and(
        eq(subscriptionEvents.userId, subscription.userId),
        eq(subscriptionEvents.canonicalMerchantDomain, subscription.canonicalMerchantDomain ?? ""),
        eq(subscriptionEvents.isCanonical, true)
      ));

    const priceHistory = buildPriceHistory(canonicalEvents);
    const priceChanges = detectPriceChanges(priceHistory);

    if (!priceChanges.latestChange) return subscription;

    const change = priceChanges.latestChange;

    const [updated] = await db
      .update(subscriptions)
      .set({
        lastPriceChangeAt: new Date(change.detectedAt),
        lastPriceChangeType: change.changeType,
        lastPriceChangeAbsolute: String(change.absoluteChange),
        lastPriceChangePercentage: String(change.percentageChange),
        lastPriceChangeAnnualImpact: String(change.annualImpact),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id))
      .returning();

    console.log(
      `[Lifecycle] price change detected for ${subscription.canonicalMerchantName}: ` +
      `${change.previousAmount}${change.previousCurrency} -> ${change.newAmount}${change.newCurrency} (${change.percentageChange}%)`
    );

    // Price Increase Notification: creates an idempotent notification
    // record for a genuine increase only (buildPriceIncreaseNotificationRecord
    // returns null for decrease/currency_change/interval_change — the same
    // classification priceChangeDetector.ts already made, never
    // re-derived). Isolated in its own try/catch, same convention as the
    // AI-enrichment queueing in gmail.ts: a failure here must never affect
    // the price-change detection/persistence above, which has already
    // committed by this point. onConflictDoNothing on the occurrence's
    // unique constraint is what makes this safe to call every time
    // runPriceChangeDetection() re-runs for the same underlying event data.
    try {
      const record = buildPriceIncreaseNotificationRecord(change, subscription.id, subscription.userId);
      if (record) {
        await db.insert(priceIncreaseNotifications).values(record).onConflictDoNothing({
          target: [
            priceIncreaseNotifications.subscriptionId,
            priceIncreaseNotifications.detectedAt,
            priceIncreaseNotifications.previousAmount,
            priceIncreaseNotifications.newAmount,
          ],
        });
      }
    } catch (err) {
      console.error(`[PriceIncreaseNotification] failed to create notification record for ${subscription.canonicalMerchantName}:`, err);
    }

    return updated ?? subscription;
  }

  // "Check for existing reminders before creating (no duplicates)" is
  // enforced by the (subscription_id, type) unique constraint +
  // onConflictDoNothing — idempotent under concurrent/repeated calls, not
  // just sequential ones. Scoped to one subscription when subscriptionId is
  // given, otherwise runs across every eligible subscription.
  //
  // Phase 4.1: eligibility is now decided by evaluateReminderEligibility()
  // (subscriptionLifecycle.ts) instead of the separate
  // isEligibleForReminder()/computeSubscriptionReminderPlan() calls this
  // used before — same underlying date math and lifecycle-state checks
  // (nothing here got stricter or looser on those), plus the userDismissed
  // exclusion and explicit ineligibility reasons that function documents.
  // Active Connection Isolation filtering (unchanged, added in the prior
  // phase) still runs first, since it's the DB-dependent check.
  async generateRemindersForEligibleSubscriptions(subscriptionId?: string): Promise<{ created: number; skipped: number }> {
    const candidates = subscriptionId
      ? await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId))
      : await db.select().from(subscriptions);

    let created = 0;
    let skipped = 0;

    for (const sub of candidates) {
      // Active Connection Isolation safety fix: this method only creates
      // reminder ROWS — it never sends anything itself (see
      // getDueSubscriptionReminders()/deliverDueSubscriptionReminders()-style
      // delivery methods below for Phase 4.2's actual sending path, which
      // re-checks this same ownership independently right before send). A
      // subscription no longer visible in the user's active Subscription
      // Intelligence view must not accumulate reminder rows in the first
      // place.
      const [visible] = await this.filterByActiveConnection(sub.userId, [sub]);
      if (!visible) {
        skipped++;
        continue;
      }

      const user = await db.select().from(users).where(eq(users.id, sub.userId)).limit(1);
      const owner = user[0];

      // Phase 4.4: the reminder preference is a separate concept from the
      // Subscription Intelligence beta gate (checked above via
      // filterByActiveConnection's own subscriptionIntelligenceEnabled
      // branch) — a user with reminders turned off must never accumulate
      // new PENDING rows, regardless of beta status.
      if (owner && !owner.subscriptionRemindersEnabled) {
        skipped++;
        continue;
      }

      const timezone = owner?.timezone || "UTC";
      const evaluation = evaluateReminderEligibility(sub, new Date(), timezone);
      if (!evaluation.eligible) {
        skipped++;
        continue;
      }

      for (const plan of evaluation.plans) {
        const inserted = await db.insert(subscriptionReminders).values({
          subscriptionId: sub.id,
          userId: sub.userId,
          remindAt: plan.remindAt,
          type: plan.type,
        })
          .onConflictDoNothing({ target: [subscriptionReminders.subscriptionId, subscriptionReminders.type] })
          .returning({ id: subscriptionReminders.id });

        if (inserted.length > 0) created++;
        else skipped++;
      }
    }

    return { created, skipped };
  }

  // ── Phase 4.2: subscription-reminder DELIVERY ──────────────────────────
  //
  // Mirrors the legacy trial-reminder delivery methods (getDueReminders/
  // claimAndSendReminder/markReminderSent/markReminderFailed) exactly in
  // spirit — same atomic-claim-via-conditional-UPDATE pattern, same
  // separation between "load candidates," "claim," and "finalize." The one
  // deliberate difference: claiming moves status to SENDING (not straight to
  // SENT) — see shared/schema.ts's reminderStatusEnum comment and this
  // phase's implementation report for why: it makes a crash between claim
  // and the actual provider call an OBSERVABLE stuck state
  // (status='SENDING') instead of a silent false-positive SENT with no
  // email ever sent.
  //
  // Retry policy: FAILED rows are treated as due again on every subsequent
  // cron tick (see the status filter below), forever, with no attempt
  // counter, no backoff, no cap — the smallest mechanism that satisfies
  // "a transient failure must not permanently lose the reminder." This is
  // deliberately unable to distinguish a transient network blip from a
  // permanently-broken address; both retry identically. lastError remains
  // visible on the row throughout, so a persistently-FAILED reminder is
  // still observable for manual follow-up. A smarter policy (attempt caps,
  // backoff, permanent-vs-transient classification) is explicitly out of
  // scope for this phase.
  // Phase 4.3 (Reminder UX): read-only fetch of one subscription's OWN
  // reminder rows, scoped by BOTH subscriptionId and userId together (same
  // ownership pattern as getShadowSubscriptionById) — a cross-user
  // subscriptionId returns an empty array, never another user's rows. Used
  // only to DISPLAY real reminder state (server/reminderPresentation.ts);
  // never touches status, never claims/sends anything.
  async getRemindersForSubscription(subscriptionId: string, userId: string): Promise<SubscriptionReminder[]> {
    return db
      .select()
      .from(subscriptionReminders)
      .where(and(eq(subscriptionReminders.subscriptionId, subscriptionId), eq(subscriptionReminders.userId, userId)));
  }

  async getDueSubscriptionReminders(now: Date): Promise<(SubscriptionReminder & { subscription: ShadowSubscription; user: User })[]> {
    const results = await db
      .select({ reminder: subscriptionReminders, subscription: subscriptions, user: users })
      .from(subscriptionReminders)
      .innerJoin(subscriptions, eq(subscriptionReminders.subscriptionId, subscriptions.id))
      .innerJoin(users, eq(subscriptionReminders.userId, users.id))
      .where(and(
        inArray(subscriptionReminders.status, ["PENDING", "FAILED"]),
        lte(subscriptionReminders.remindAt, now)
      ));

    return results.map((r) => ({ ...r.reminder, subscription: r.subscription, user: r.user }));
  }

  // The atomic claim: a single conditional UPDATE is what actually prevents
  // two concurrent cron workers from both sending the same reminder — the
  // SELECT in getDueSubscriptionReminders() above is just candidate
  // discovery and confers no ownership by itself. Whichever caller's UPDATE
  // commits first flips status away from PENDING/FAILED, so the other
  // caller's WHERE clause matches zero rows and gets back undefined.
  async claimSubscriptionReminderForSending(reminderId: string): Promise<SubscriptionReminder | undefined> {
    const [row] = await db.update(subscriptionReminders)
      .set({ status: "SENDING", claimedAt: new Date() })
      .where(and(
        eq(subscriptionReminders.id, reminderId),
        inArray(subscriptionReminders.status, ["PENDING", "FAILED"])
      ))
      .returning();
    return row;
  }

  async markSubscriptionReminderSent(reminderId: string, providerMessageId?: string): Promise<void> {
    await db.update(subscriptionReminders)
      .set({
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: providerMessageId || null,
        lastError: null,
        claimedAt: null,
      })
      .where(eq(subscriptionReminders.id, reminderId));
  }

  async markSubscriptionReminderFailed(reminderId: string, error: string): Promise<void> {
    await db.update(subscriptionReminders)
      .set({
        status: "FAILED",
        lastError: error,
        claimedAt: null,
      })
      .where(eq(subscriptionReminders.id, reminderId));
  }

  // SKIPPED is terminal (never retried) — distinct from FAILED, which IS
  // retried. Used when a re-eligibility check at delivery time finds the
  // reminder no longer applicable (dismissed, hidden by active-connection
  // isolation, status no longer active/trial, date became invalid) — a
  // deliberate decision not to send, not a delivery error. Reuses the
  // existing lastError column for the human-readable reason rather than
  // adding a new column.
  async markSubscriptionReminderSkipped(reminderId: string, reason: string): Promise<void> {
    await db.update(subscriptionReminders)
      .set({
        status: "SKIPPED",
        lastError: reason,
        claimedAt: null,
      })
      .where(eq(subscriptionReminders.id, reminderId));
  }

  // ── Phase 4.4: reminder preference ─────────────────────────────────────
  //
  // Separate from subscriptionIntelligenceEnabled by design (the task's own
  // explicit instruction) — a reminder preference and controlled-beta
  // access are different concepts. Defaults true (see shared/schema.ts's
  // column comment).
  async toggleSubscriptionReminders(userId: string, enabled: boolean): Promise<User> {
    const [user] = await db.update(users).set({ subscriptionRemindersEnabled: enabled }).where(eq(users.id, userId)).returning();
    return user;
  }

  // Called immediately when a user turns reminders OFF — the delivery-time
  // re-check (decideReminderDeliveryAction) is the truly authoritative
  // enforcement (it runs on every attempt regardless), but this makes the
  // change visible immediately (the detail Sheet, and any due-but-unclaimed
  // reminder) instead of waiting for the next delivery pass to discover it.
  // Never touches SENT (already delivered, historical) or SENDING (already
  // in-flight — let that attempt finish, the stale-recovery path handles it
  // if it never does). Reuses the SKIPPED status and the exact
  // REMINDERS_DISABLED_SKIP_REASON marker — never a raw delete.
  async skipPendingRemindersForDisabledUser(userId: string): Promise<number> {
    const result = await db.update(subscriptionReminders)
      .set({ status: "SKIPPED", lastError: REMINDERS_DISABLED_SKIP_REASON, claimedAt: null })
      .where(and(
        eq(subscriptionReminders.userId, userId),
        inArray(subscriptionReminders.status, ["PENDING", "FAILED"])
      ))
      .returning({ id: subscriptionReminders.id });
    return result.length;
  }

  // Called immediately when a user turns reminders back ON. Only ever
  // touches rows this exact mechanism skipped (matched by the EXACT
  // REMINDERS_DISABLED_SKIP_REASON string, never a fuzzy/partial match) —
  // a row skipped for any other reason (dismissed subscription, hidden by
  // active-connection isolation, an invalid date) is left untouched, since
  // turning reminders back on doesn't change any of those other facts.
  // Recomputes remindAt fresh via evaluateReminderEligibility()'s own plan
  // (Phase 4.1) rather than reusing the row's old, now-stale remindAt — an
  // offset whose window has already fully passed while reminders were off
  // is correctly left SKIPPED, not resurrected with a backdated time.
  async reviveSkippedRemindersForUser(userId: string, now: Date): Promise<number> {
    const candidates = await db
      .select({ reminder: subscriptionReminders, subscription: subscriptions })
      .from(subscriptionReminders)
      .innerJoin(subscriptions, eq(subscriptionReminders.subscriptionId, subscriptions.id))
      .where(and(
        eq(subscriptionReminders.userId, userId),
        eq(subscriptionReminders.status, "SKIPPED"),
        eq(subscriptionReminders.lastError, REMINDERS_DISABLED_SKIP_REASON)
      ));

    if (candidates.length === 0) return 0;

    const owner = await this.getUserById(userId);
    const timezone = owner?.timezone || "UTC";
    let revived = 0;

    for (const { reminder, subscription } of candidates) {
      const isActive = await this.isSubscriptionCurrentlyActive(subscription);
      if (!isActive) continue; // still hidden -- leave it skipped, let the normal pipeline pick it up once visible again

      const evaluation = evaluateReminderEligibility(subscription, now, timezone);
      if (!evaluation.eligible) continue;
      const freshPlan = evaluation.plans.find((p) => p.type === reminder.type);
      if (!freshPlan) continue; // this specific offset's window has already passed

      await db.update(subscriptionReminders)
        .set({ status: "PENDING", remindAt: freshPlan.remindAt, lastError: null })
        .where(eq(subscriptionReminders.id, reminder.id));
      revived++;
    }

    return revived;
  }

  // ── Phase 4.4: stale-SENDING recovery ───────────────────────────────────
  //
  // A single atomic UPDATE: any row still SENDING after `timeoutMinutes`
  // (configured via SUBSCRIPTION_REMINDER_SENDING_TIMEOUT_MINUTES, read by
  // the caller in routes.ts) is treated as an abandoned claim — the process
  // that claimed it almost certainly crashed or was killed before it could
  // call the provider. Recovered rows go back to PENDING so the NORMAL
  // delivery pipeline (which re-checks eligibility, active-connection
  // ownership, and the reminder preference on every attempt) picks them up
  // on its very next pass within the SAME cron invocation — no duplicate
  // ownership/eligibility logic is implemented here.
  //
  // Honest tradeoff (documented per the task's explicit requirement): this
  // is an AT-LEAST-ONCE recovery, not exactly-once. If the original process
  // is somehow still alive and completes its send AFTER this recovery marks
  // the row PENDING again, a duplicate email is possible — the installed
  // Resend SDK has no idempotency-key support (verified in Phase 4.2), so
  // there is no provider-level guard against this. This is judged
  // acceptable because: (1) the cron that claims reminders is a one-shot
  // HTTP-triggered process with restartPolicyType: NEVER (see
  // railway.cron-reminders.json), not a long-lived daemon, so a claim still
  // "in flight" past a conservative multi-minute timeout is overwhelmingly
  // more likely dead than genuinely slow; (2) the cron itself only runs
  // once per day (0 9 * * *), so the realistic duplicate-window is between
  // one day's run and the next, not between rapid retries.
  async recoverStaleSendingReminders(timeoutMinutes: number, now: Date): Promise<number> {
    const cutoff = computeStaleSendingCutoff(now, timeoutMinutes);
    const result = await db.update(subscriptionReminders)
      .set({
        status: "PENDING",
        claimedAt: null,
        lastError: "recovered from a stale SENDING state (previous delivery attempt never completed)",
      })
      .where(and(
        eq(subscriptionReminders.status, "SENDING"),
        lt(subscriptionReminders.claimedAt, cutoff)
      ))
      .returning({ id: subscriptionReminders.id });
    return result.length;
  }

  // ── Price Increase Notification: DELIVERY ──────────────────────────────
  //
  // Mirrors the subscription-reminder delivery methods immediately above,
  // method-for-method — same atomic-claim-via-conditional-UPDATE pattern
  // (claimSubscriptionReminderForSending), same PENDING/SENDING/SENT/FAILED
  // vocabulary, same stale-SENDING recovery shape
  // (recoverStaleSendingReminders). No parallel delivery mechanism
  // invented; only the table and the notification-specific content differ.
  async getPendingPriceIncreaseNotifications(): Promise<(PriceIncreaseNotification & { subscription: ShadowSubscription; user: User })[]> {
    const results = await db
      .select({ notification: priceIncreaseNotifications, subscription: subscriptions, user: users })
      .from(priceIncreaseNotifications)
      .innerJoin(subscriptions, eq(priceIncreaseNotifications.subscriptionId, subscriptions.id))
      .innerJoin(users, eq(priceIncreaseNotifications.userId, users.id))
      .where(inArray(priceIncreaseNotifications.status, ["PENDING", "FAILED"]));

    return results.map((r) => ({ ...r.notification, subscription: r.subscription, user: r.user }));
  }

  // The atomic claim: identical reasoning to claimSubscriptionReminderForSending
  // — a single conditional UPDATE is what actually prevents two concurrent
  // cron workers from both sending the same notification.
  async claimPriceIncreaseNotificationForSending(id: string): Promise<PriceIncreaseNotification | undefined> {
    const [row] = await db.update(priceIncreaseNotifications)
      .set({ status: "SENDING", claimedAt: new Date() })
      .where(and(
        eq(priceIncreaseNotifications.id, id),
        inArray(priceIncreaseNotifications.status, ["PENDING", "FAILED"])
      ))
      .returning();
    return row;
  }

  async markPriceIncreaseNotificationSent(id: string, providerMessageId?: string): Promise<void> {
    await db.update(priceIncreaseNotifications)
      .set({
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: providerMessageId || null,
        lastError: null,
        claimedAt: null,
      })
      .where(eq(priceIncreaseNotifications.id, id));
  }

  async markPriceIncreaseNotificationFailed(id: string, error: string): Promise<void> {
    await db.update(priceIncreaseNotifications)
      .set({
        status: "FAILED",
        lastError: error,
        claimedAt: null,
      })
      .where(eq(priceIncreaseNotifications.id, id));
  }

  // SKIPPED is terminal here — deliberately, unlike subscription reminders'
  // SKIPPED-for-disabled-preference rows (which reviveSkippedRemindersForUser
  // resurrects on re-enable). A subscription reminder is about a FUTURE
  // date whose relevance survives the preference being off temporarily; a
  // price-increase notification is about a specific PAST detected event —
  // silently emailing a backlog of old increases when a user re-enables the
  // preference later would be surprising and stale, not helpful. No revival
  // path exists for this table, by design.
  async markPriceIncreaseNotificationSkipped(id: string, reason: string): Promise<void> {
    await db.update(priceIncreaseNotifications)
      .set({
        status: "SKIPPED",
        lastError: reason,
        claimedAt: null,
      })
      .where(eq(priceIncreaseNotifications.id, id));
  }

  async recoverStalePriceIncreaseNotificationSending(timeoutMinutes: number, now: Date): Promise<number> {
    const cutoff = computeStaleSendingCutoff(now, timeoutMinutes);
    const result = await db.update(priceIncreaseNotifications)
      .set({
        status: "PENDING",
        claimedAt: null,
        lastError: "recovered from a stale SENDING state (previous delivery attempt never completed)",
      })
      .where(and(
        eq(priceIncreaseNotifications.status, "SENDING"),
        lt(priceIncreaseNotifications.claimedAt, cutoff)
      ))
      .returning({ id: priceIncreaseNotifications.id });
    return result.length;
  }

  // Separate preference from subscriptionRemindersEnabled — same precedent
  // toggleSubscriptionReminders itself follows.
  async togglePriceIncreaseNotifications(userId: string, enabled: boolean): Promise<User> {
    const [user] = await db.update(users).set({ priceIncreaseNotificationsEnabled: enabled }).where(eq(users.id, userId)).returning();
    return user;
  }

  // Called immediately when a user turns this preference OFF — makes the
  // change visible immediately for any already-created PENDING/FAILED
  // notification, rather than waiting for the next delivery pass. Never
  // touches SENT or SENDING (already delivered, or already in-flight — let
  // that attempt finish). Reuses the SKIPPED status and the exact
  // PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON marker.
  async skipPendingPriceIncreaseNotificationsForDisabledUser(userId: string): Promise<number> {
    const result = await db.update(priceIncreaseNotifications)
      .set({ status: "SKIPPED", lastError: PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON, claimedAt: null })
      .where(and(
        eq(priceIncreaseNotifications.userId, userId),
        inArray(priceIncreaseNotifications.status, ["PENDING", "FAILED"])
      ))
      .returning({ id: priceIncreaseNotifications.id });
    return result.length;
  }

  async getSuggestedTrials(userId: string): Promise<SuggestedTrial[]> {
    return db.select().from(suggestedTrials).where(
      and(eq(suggestedTrials.userId, userId), eq(suggestedTrials.status, "new"))
    ).orderBy(desc(suggestedTrials.confidence));
  }

  async getSuggestedTrialById(id: string, userId: string): Promise<SuggestedTrial | undefined> {
    const [row] = await db.select().from(suggestedTrials).where(
      and(eq(suggestedTrials.id, id), eq(suggestedTrials.userId, userId))
    ).limit(1);
    return row;
  }

  async upsertSuggestedTrial(data: Omit<SuggestedTrial, "id" | "createdAt" | "status"> & { userId: string }): Promise<void> {
    await db.insert(suggestedTrials).values({
      userId: data.userId,
      provider: data.provider,
      messageId: data.messageId,
      fromEmail: data.fromEmail,
      fromDomain: data.fromDomain,
      subject: data.subject,
      receivedAt: data.receivedAt,
      serviceGuess: data.serviceGuess,
      startDateGuess: (data as any).startDateGuess ?? null,
      startDateSource: (data as any).startDateSource ?? null,
      endDateGuess: data.endDateGuess,
      amountGuess: data.amountGuess,
      currencyGuess: data.currencyGuess,
      confidence: data.confidence,
      status: "new",
    } as any).onConflictDoNothing();
  }

  async markSuggestedTrialAdded(id: string, userId: string): Promise<SuggestedTrial | undefined> {
    const [row] = await db.update(suggestedTrials).set({ status: "added" }).where(
      and(eq(suggestedTrials.id, id), eq(suggestedTrials.userId, userId))
    ).returning();
    return row;
  }

  async markSuggestedTrialIgnored(id: string, userId: string): Promise<SuggestedTrial | undefined> {
    const [row] = await db.update(suggestedTrials).set({ status: "ignored" }).where(
      and(eq(suggestedTrials.id, id), eq(suggestedTrials.userId, userId))
    ).returning();
    return row;
  }

  async createPasswordResetToken(userId: string, token: string, expiresAt: Date): Promise<PasswordResetToken> {
    const [row] = await db.insert(passwordResetTokens).values({ userId, token, expiresAt }).returning();
    return row;
  }

  async getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined> {
    const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.token, token)).limit(1);
    return row;
  }

  async consumePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean> {
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [claimed] = await tx.update(passwordResetTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokens.token, token),
            sql`${passwordResetTokens.usedAt} IS NULL`,
            sql`${passwordResetTokens.expiresAt} > ${now}`
          )
        )
        .returning();
      if (!claimed) return false;
      await tx.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, claimed.userId));
      return true;
    });
    return result;
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }
}

export const storage = new DatabaseStorage();
