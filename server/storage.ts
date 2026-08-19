import { randomUUID } from "node:crypto";
import { eq, and, lte, sql, count, desc, inArray } from "drizzle-orm";
import { db } from "./db";
import { users, trials, reminders, analyticsEvents, reviews, suggestedTrials, passwordResetTokens, processedPurchaseEvents, subscriptionEvents, entityResolutionCandidates, subscriptions, subscriptionReminders, type User, type Trial, type Reminder, type Review, type SuggestedTrial, type PasswordResetToken, type InsertSubscriptionEvent, type SubscriptionEvent, type InsertEntityResolutionCandidate, type InsertShadowSubscription, type ShadowSubscription, type SubscriptionReminder } from "@shared/schema";
import { decideCanonicalization } from "./canonicalEvents";
import { applyEventToSubscription, isEligibleForReminder, computeSubscriptionReminderPlan, type LifecycleRelevantEvent, type LifecycleTransitionResult } from "./subscriptionLifecycle";

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
  createSubscriptionEvent(data: InsertSubscriptionEvent): Promise<boolean>;
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
  getShadowSubscriptionsForUser(userId: string): Promise<ShadowSubscription[]>;
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
  toggleEmailScanning(userId: string, enabled: boolean): Promise<User>;
  updateLastEmailScan(userId: string, messagesProcessed?: number): Promise<void>;
  getProUsersWithScanningEnabled(): Promise<User[]>;

  getSuggestedTrials(userId: string): Promise<SuggestedTrial[]>;
  upsertSuggestedTrial(data: Omit<SuggestedTrial, "id" | "createdAt" | "status"> & { userId: string }): Promise<void>;
  markSuggestedTrialAdded(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  markSuggestedTrialIgnored(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  getSuggestedTrialById(id: string, userId: string): Promise<SuggestedTrial | undefined>;

  createPasswordResetToken(userId: string, token: string, expiresAt: Date): Promise<PasswordResetToken>;
  getPasswordResetToken(token: string): Promise<PasswordResetToken | undefined>;
  consumePasswordResetToken(token: string, newPasswordHash: string): Promise<boolean>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
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

  async clearUserGmailTokens(userId: string): Promise<void> {
    await db.update(users).set({
      gmailAccessToken: null,
      gmailRefreshToken: null,
      gmailTokenExpiry: null,
      gmailConnected: false,
    }).where(eq(users.id, userId));
  }

  async toggleEmailScanning(userId: string, enabled: boolean): Promise<User> {
    const [user] = await db.update(users).set({ emailScanningEnabled: enabled }).where(eq(users.id, userId)).returning();
    return user;
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

  async createSubscriptionEvent(data: InsertSubscriptionEvent): Promise<boolean> {
    // Phase 3B.3 note: a re-scan of a message already classified with the
    // same (userId, sourceMessageId, eventType) — expected whenever the
    // classifier itself hasn't changed since the last scan — used to be a
    // silent no-op (onConflictDoNothing), which meant new columns added
    // after a row already existed (like Phase 3B.3's merchant-resolution
    // fields) could never backfill onto it. Now upserts, but ONLY the
    // merchant-resolution columns on conflict — eventType/extractedPrice/
    // extractedDate/confidence/etc, established by Phase 3B.1/3B.2's
    // classification, are deliberately left untouched on conflict rather
    // than silently re-applied from a later scan.
    //
    // Phase 3B.5: a re-scan that lands on a DIFFERENT eventType than the
    // message's current canonical row is a reclassification, not an
    // independent event — see server/canonicalEvents.ts for the decision
    // logic. This whole method runs in a transaction so the "old row
    // superseded + new row canonical" state change is atomic.
    const written = await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(subscriptionEvents)
        .where(and(eq(subscriptionEvents.userId, data.userId), eq(subscriptionEvents.sourceMessageId, data.sourceMessageId)));

      const decision = decideCanonicalization(existingRows, data.eventType);

      if (decision.kind === "same_classification") {
        const result = await tx.insert(subscriptionEvents).values(data)
          .onConflictDoUpdate({
            target: [subscriptionEvents.userId, subscriptionEvents.sourceMessageId, subscriptionEvents.eventType],
            set: {
              canonicalMerchantName: data.canonicalMerchantName,
              canonicalMerchantDomain: data.canonicalMerchantDomain,
              paymentProcessor: data.paymentProcessor,
              merchantConfidence: data.merchantConfidence,
              merchantResolutionStatus: data.merchantResolutionStatus,
            },
          })
          .returning({ id: subscriptionEvents.id });
        return result.length > 0;
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
            classificationGeneration: generation,
            isCanonical: true,
            canonicalEventId: sql`${subscriptionEvents.id}`,
            supersededBy: null,
            canonicalMerchantName: data.canonicalMerchantName,
            canonicalMerchantDomain: data.canonicalMerchantDomain,
            paymentProcessor: data.paymentProcessor,
            merchantConfidence: data.merchantConfidence,
            merchantResolutionStatus: data.merchantResolutionStatus,
          },
        })
        .returning({ id: subscriptionEvents.id });

      if (!canonicalRow) return false;

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

      return true;
    });

    // Phase 3B.8: the lifecycle engine runs AFTER the event write commits,
    // in its own try/catch — a lifecycle failure must never affect whether
    // the underlying subscription_event write succeeded or roll it back.
    // Same isolation pattern as gmail.ts's sub-detector write relative to
    // the trial-suggestion pipeline.
    if (written) {
      try {
        await this.applyLifecycleEventToSubscription({
          eventType: data.eventType,
          extractedPrice: data.extractedPrice ?? null,
          extractedCurrency: data.extractedCurrency ?? null,
          extractedDate: data.extractedDate ?? null,
          userId: data.userId,
          canonicalMerchantDomain: data.canonicalMerchantDomain ?? null,
          billingInterval: data.billingInterval ?? null,
        });
      } catch (err) {
        console.error("[Lifecycle] failed to apply event to subscription:", err);
      }
    }

    return written;
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
  async getShadowSubscriptionsForUser(userId: string): Promise<ShadowSubscription[]> {
    return db
      .select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.resolutionStatus, "resolved")
      ))
      .orderBy(subscriptions.canonicalMerchantName);
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
      nextBillingDate: r.next_billing_date,
      lastBillingDate: r.last_billing_date,
      sourceCanonicalEventId: r.source_canonical_event_id,
      isShadow: r.is_shadow,
      potentialFalseMerge: r.potential_false_merge,
      potentialFalseSplit: r.potential_false_split,
      promotedAt: r.promoted_at,
      promotionReason: r.promotion_reason,
      promotionEvidence: r.promotion_evidence,
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
  async applyLifecycleEventToSubscription(event: LifecycleRelevantEvent): Promise<{
    applied: boolean;
    transition?: LifecycleTransitionResult;
    subscription?: ShadowSubscription;
  }> {
    if (!event.canonicalMerchantDomain) {
      return { applied: false };
    }

    const [existing] = await db
      .select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, event.userId),
        eq(subscriptions.canonicalMerchantDomain, event.canonicalMerchantDomain)
      ))
      .limit(1);

    if (!existing) {
      return { applied: false };
    }

    const { transition, fields, billingIntervalChange } = applyEventToSubscription(event, existing);

    if (Object.keys(fields).length === 0) {
      // no_op, or a data_update whose event carried no actual new data —
      // nothing to write, but still report the transition for logging.
      if (transition.kind === "state_change") {
        console.log(`[Lifecycle] ${existing.canonicalMerchantName}: ${transition.from} -> ${transition.to} (${transition.reason})`);
      }
      return { applied: transition.kind !== "no_op", transition, subscription: existing };
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

    return { applied: true, transition, subscription: updated };
  }

  // "Check for existing reminders before creating (no duplicates)" is
  // enforced by the (subscription_id, type) unique constraint +
  // onConflictDoNothing — idempotent under concurrent/repeated calls, not
  // just sequential ones. Scoped to one subscription when subscriptionId is
  // given, otherwise runs across every eligible subscription.
  async generateRemindersForEligibleSubscriptions(subscriptionId?: string): Promise<{ created: number; skipped: number }> {
    const candidates = subscriptionId
      ? await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId))
      : await db.select().from(subscriptions);

    let created = 0;
    let skipped = 0;

    for (const sub of candidates) {
      if (!isEligibleForReminder(sub)) {
        skipped++;
        continue;
      }

      const user = await db.select().from(users).where(eq(users.id, sub.userId)).limit(1);
      const timezone = user[0]?.timezone || "UTC";
      const plans = computeSubscriptionReminderPlan(sub.nextBillingDate!, new Date(), timezone);

      for (const plan of plans) {
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
