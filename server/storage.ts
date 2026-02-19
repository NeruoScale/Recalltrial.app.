import { eq, and, lte, sql, count } from "drizzle-orm";
import { db } from "./db";
import { users, trials, reminders, analyticsEvents, type User, type Trial, type Reminder } from "@shared/schema";

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
  createReminder(data: { trialId: string; userId: string; remindAt: Date; type: "THREE_DAYS" | "ONE_DAY" }): Promise<Reminder>;
  getDueReminders(now: Date): Promise<(Reminder & { trial: Trial; user: User })[]>;
  claimAndSendReminder(reminderId: string): Promise<boolean>;
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

  async createReminder(data: { trialId: string; userId: string; remindAt: Date; type: "THREE_DAYS" | "ONE_DAY" }): Promise<Reminder> {
    const [reminder] = await db.insert(reminders).values({
      trialId: data.trialId,
      userId: data.userId,
      remindAt: data.remindAt,
      type: data.type,
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
}

export const storage = new DatabaseStorage();
