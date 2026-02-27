import { eq, and, lte, sql, count, desc } from "drizzle-orm";
import { db } from "./db";
import { users, trials, reminders, analyticsEvents, reviews, suggestedTrials, type User, type Trial, type Reminder, type Review, type SuggestedTrial } from "@shared/schema";

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
  updateLastEmailScan(userId: string): Promise<void>;
  getProUsersWithScanningEnabled(): Promise<User[]>;

  getSuggestedTrials(userId: string): Promise<SuggestedTrial[]>;
  upsertSuggestedTrial(data: Omit<SuggestedTrial, "id" | "createdAt" | "status"> & { userId: string }): Promise<void>;
  markSuggestedTrialAdded(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  markSuggestedTrialIgnored(id: string, userId: string): Promise<SuggestedTrial | undefined>;
  getSuggestedTrialById(id: string, userId: string): Promise<SuggestedTrial | undefined>;
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

  async updateLastEmailScan(userId: string): Promise<void> {
    await db.update(users).set({ lastEmailScanAt: new Date() }).where(eq(users.id, userId));
  }

  async getProUsersWithScanningEnabled(): Promise<User[]> {
    return db.select().from(users).where(
      and(
        eq(users.emailScanningEnabled, true),
        eq(users.gmailConnected, true),
      )
    );
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
}

export const storage = new DatabaseStorage();
