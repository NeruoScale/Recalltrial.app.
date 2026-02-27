import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, date, decimal, pgEnum, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const trialStatusEnum = pgEnum("trial_status", ["ACTIVE", "CANCELED"]);
export const reminderTypeEnum = pgEnum("reminder_type", ["THREE_DAYS", "TWO_DAYS", "ONE_DAY", "TWENTY_FOUR_HOURS", "THREE_HOURS", "SIX_HOURS", "ONE_HOUR"]);
export const reminderStatusEnum = pgEnum("reminder_status", ["PENDING", "SENT", "SKIPPED", "FAILED"]);
export const planEnum = pgEnum("plan", ["FREE", "PLUS", "PRO", "PREMIUM"]);
export const userSubStatusEnum = pgEnum("user_sub_status", ["ACTIVE", "CANCELED", "PAST_DUE", "INCOMPLETE"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  timezone: text("timezone").notNull().default("Asia/Qatar"),
  plan: planEnum("plan").notNull().default("FREE"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  subscriptionStatus: userSubStatusEnum("user_sub_status"),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const trials = pgTable("trials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  serviceName: text("service_name").notNull(),
  serviceUrl: text("service_url").notNull(),
  domain: text("domain").notNull(),
  iconUrl: text("icon_url"),
  cancelUrl: text("cancel_url"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  renewalPrice: decimal("renewal_price", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  status: trialStatusEnum("status").notNull().default("ACTIVE"),
  canceledAt: timestamp("canceled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reminders = pgTable("reminders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  trialId: varchar("trial_id").notNull().references(() => trials.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  remindAt: timestamp("remind_at").notNull(),
  type: reminderTypeEnum("type").notNull(),
  status: reminderStatusEnum("status").notNull().default("PENDING"),
  sentAt: timestamp("sent_at"),
  provider: text("provider").default("resend"),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const signupSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const insertTrialSchema = createInsertSchema(trials).omit({
  id: true,
  userId: true,
  domain: true,
  iconUrl: true,
  status: true,
  canceledAt: true,
  createdAt: true,
}).extend({
  serviceName: z.string().min(1, "Service name is required"),
  serviceUrl: z.string().url("Please enter a valid URL"),
  cancelUrl: z.string().url("Please enter a valid URL").optional().or(z.literal("")),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().min(1, "End date is required"),
  renewalPrice: z.string().optional().or(z.literal("")),
  currency: z.string().default("USD"),
});

export const analyticsEvents = pgTable("analytics_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  event: text("event").notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reviewSourceEnum = pgEnum("review_source", ["manual", "in_app", "import"]);

export const reviews = pgTable("reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  rating: integer("rating").notNull(),
  text: text("text").notNull(),
  name: text("name"),
  location: text("location"),
  source: reviewSourceEnum("source").notNull().default("manual"),
  isApproved: boolean("is_approved").notNull().default(false),
  isFeatured: boolean("is_featured").notNull().default(false),
  userId: varchar("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReviewSchema = createInsertSchema(reviews).omit({
  id: true,
  isApproved: true,
  isFeatured: true,
  createdAt: true,
}).extend({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(10, "Review must be at least 10 characters").max(300, "Review must be under 300 characters"),
  name: z.string().max(60).optional().or(z.literal("")),
  location: z.string().max(60).optional().or(z.literal("")),
});

export type Review = typeof reviews.$inferSelect;
export type InsertReview = z.infer<typeof insertReviewSchema>;

export const insertReminderSchema = createInsertSchema(reminders).omit({
  id: true,
  status: true,
  sentAt: true,
  provider: true,
  providerMessageId: true,
  lastError: true,
  createdAt: true,
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Trial = typeof trials.$inferSelect;
export type InsertTrial = z.infer<typeof insertTrialSchema>;
export type Reminder = typeof reminders.$inferSelect;
export type InsertReminder = z.infer<typeof insertReminderSchema>;

export const CURRENCIES = ["USD", "QAR", "EUR", "GBP"] as const;

export const POPULAR_SERVICES = [
  { name: "Netflix", url: "https://www.netflix.com", cancelUrl: "https://www.netflix.com/cancelplan" },
  { name: "Spotify", url: "https://www.spotify.com", cancelUrl: "https://www.spotify.com/account/subscription/" },
  { name: "YouTube Premium", url: "https://www.youtube.com", cancelUrl: "https://myaccount.google.com/subscriptions" },
  { name: "Disney+", url: "https://www.disneyplus.com", cancelUrl: "https://www.disneyplus.com/account/subscription" },
  { name: "Amazon Prime", url: "https://www.amazon.com", cancelUrl: "https://www.amazon.com/mc/pipelines/cancelPrime" },
  { name: "Apple TV+", url: "https://tv.apple.com", cancelUrl: "https://support.apple.com/en-us/HT202039" },
  { name: "Hulu", url: "https://www.hulu.com", cancelUrl: "https://secure.hulu.com/account" },
  { name: "HBO Max", url: "https://www.max.com", cancelUrl: "https://www.max.com/account" },
  { name: "Canva Pro", url: "https://www.canva.com", cancelUrl: "https://www.canva.com/settings/billing" },
  { name: "Notion", url: "https://www.notion.so", cancelUrl: "https://www.notion.so/my-account" },
  { name: "ChatGPT Plus", url: "https://chat.openai.com", cancelUrl: "https://chat.openai.com/#settings/subscription" },
  { name: "Adobe Creative Cloud", url: "https://www.adobe.com", cancelUrl: "https://account.adobe.com/plans" },
  { name: "Figma", url: "https://www.figma.com", cancelUrl: "https://www.figma.com/settings" },
  { name: "Slack Pro", url: "https://slack.com", cancelUrl: "https://slack.com/admin/billing" },
  { name: "Zoom Pro", url: "https://zoom.us", cancelUrl: "https://zoom.us/account" },
  { name: "Dropbox", url: "https://www.dropbox.com", cancelUrl: "https://www.dropbox.com/account/plan" },
  { name: "LinkedIn Premium", url: "https://www.linkedin.com", cancelUrl: "https://www.linkedin.com/psettings/cancel-premium" },
  { name: "Grammarly", url: "https://www.grammarly.com", cancelUrl: "https://account.grammarly.com/subscription" },
  { name: "Paramount+", url: "https://www.paramountplus.com", cancelUrl: "https://www.paramountplus.com/account/" },
  { name: "Peacock", url: "https://www.peacocktv.com", cancelUrl: "https://www.peacocktv.com/account/subscription" },
];
