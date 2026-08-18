import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, date, decimal, pgEnum, integer, boolean, unique } from "drizzle-orm/pg-core";
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
  emailScanningEnabled: boolean("email_scanning_enabled").notNull().default(false),
  gmailConnected: boolean("gmail_connected").notNull().default(false),
  gmailAccessToken: text("gmail_access_token"),
  gmailRefreshToken: text("gmail_refresh_token"),
  gmailTokenExpiry: timestamp("gmail_token_expiry"),
  lastEmailScanAt: timestamp("last_email_scan_at"),
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
  startDate: date("start_date"),
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
  startDate: z.string().optional().or(z.literal("")).or(z.null()),
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

export const suggestedTrialStatusEnum = pgEnum("suggested_trial_status", ["new", "added", "ignored"]);

export const suggestedTrials = pgTable("suggested_trials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull().default("gmail"),
  messageId: text("message_id").notNull(),
  fromEmail: text("from_email"),
  fromDomain: text("from_domain"),
  subject: text("subject"),
  receivedAt: timestamp("received_at"),
  serviceGuess: text("service_guess"),
  startDateGuess: date("start_date_guess"),
  startDateSource: text("start_date_source"),
  endDateGuess: date("end_date_guess"),
  amountGuess: decimal("amount_guess", { precision: 10, scale: 2 }),
  currencyGuess: text("currency_guess"),
  confidence: integer("confidence").notNull().default(50),
  status: suggestedTrialStatusEnum("status").notNull().default("new"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSuggestedTrialSchema = createInsertSchema(suggestedTrials).omit({
  id: true,
  createdAt: true,
  status: true,
});

export type SuggestedTrial = typeof suggestedTrials.$inferSelect;
export type InsertSuggestedTrial = z.infer<typeof insertSuggestedTrialSchema>;

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

export const processedPurchaseEvents = pgTable("processed_purchase_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  checkoutSessionId: text("checkout_session_id").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ProcessedPurchaseEvent = typeof processedPurchaseEvents.$inferSelect;

// Phase 2 (Subscription Intelligence, PHASE1_AUDIT.md §3-4): evidence log only.
// No `subscriptions` table yet — subscriptionId stays nullable/unreferenced
// until that table exists.
//
// Phase 3B.1/3B.2 added subscription_invoice/one_time_purchase/
// subscription_cancelled/payment_failed to the taxonomy detectSubscriptionEvent()
// actually produces (see server/gmail.ts). The original Phase 2 values —
// subscription_started, payment_received, invoice_received,
// cancellation_requested, cancellation_confirmed, subscription_expired,
// subscription_paused — are kept in the enum permanently even though the
// classifier no longer produces them: 205 real production rows (153
// invoice_received, plus others) already use these values, and Postgres
// enum values can't be safely removed once real data depends on them.
export const subscriptionEventTypeEnum = pgEnum("subscription_event_type", [
  "trial_started", "trial_ending", "subscription_started", "subscription_renewed",
  "payment_received", "invoice_received", "price_changed", "cancellation_requested",
  "cancellation_confirmed", "subscription_expired", "subscription_paused",
  "unknown_subscription_event",
  "subscription_invoice", "one_time_purchase", "subscription_cancelled", "payment_failed",
]);

// Phase 3B.3: server/merchantResolver.ts's output status. Nullable/no
// default on the columns below (not just this enum) is deliberate: NULL
// means merchant resolution never ran for that row (e.g. rows written
// before this phase), distinct from an actual "unknown" resolution result.
export const merchantResolutionStatusEnum = pgEnum("merchant_resolution_status", [
  "resolved", "ambiguous", "unknown",
]);

export const subscriptionEvents = pgTable("subscription_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriptionId: varchar("subscription_id"),
  userId: varchar("user_id").notNull().references(() => users.id),
  eventType: subscriptionEventTypeEnum("event_type").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  extractedPrice: decimal("extracted_price", { precision: 10, scale: 2 }),
  extractedCurrency: text("extracted_currency"),
  extractedDate: date("extracted_date"),
  extractedMerchant: text("extracted_merchant"),
  previousPrice: decimal("previous_price", { precision: 10, scale: 2 }),
  newPrice: decimal("new_price", { precision: 10, scale: 2 }),
  confidence: integer("confidence").notNull().default(0),
  detectionSource: text("detection_source").notNull().default("deterministic"),
  aiModel: text("ai_model"),
  canonicalMerchantName: text("canonical_merchant_name"),
  canonicalMerchantDomain: text("canonical_merchant_domain"),
  paymentProcessor: text("payment_processor"),
  merchantConfidence: integer("merchant_confidence"),
  merchantResolutionStatus: merchantResolutionStatusEnum("merchant_resolution_status"),
  // Phase 3B.5: canonical event identity. When the same (userId,
  // sourceMessageId) is reclassified under a different eventType, BOTH rows
  // are preserved (never deleted) — the old row gets isCanonical=false +
  // supersededBy, the new row becomes the canonical one. canonicalEventId
  // is shared by every row in a reclassification chain and always equals
  // the id of whichever row is CURRENTLY canonical, so any row in the
  // chain resolves to "what's current" in one lookup. No self-referencing
  // FK declared here at the Drizzle level (self-references need the
  // AnyPgColumn callback pattern and add complexity for no real benefit
  // here) — the real FK constraint is added via raw SQL in migrate.ts,
  // consistent with how every other constraint in this file is enforced.
  canonicalEventId: varchar("canonical_event_id"),
  classificationGeneration: integer("classification_generation").notNull().default(1),
  isCanonical: boolean("is_canonical").notNull().default(true),
  supersededBy: varchar("superseded_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("subscription_events_user_message_type_unique").on(
    table.userId, table.sourceMessageId, table.eventType
  ),
]);

export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type InsertSubscriptionEvent = typeof subscriptionEvents.$inferInsert;

// Phase 3B.4: SHADOW MODE ONLY. server/entityResolver.ts's proposed
// groupings, written here for observation only — nothing in the app reads
// this table to change user-facing behavior, no subscriptions table
// exists, and this does not influence reminders in any way.
export const entityResolutionStatusEnum = pgEnum("entity_resolution_status", [
  "resolved", "ambiguous", "conflict", "unresolved",
]);

export const entityResolutionCandidates = pgTable("entity_resolution_candidates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  proposedSubscriptionId: varchar("proposed_subscription_id").notNull(),
  canonicalMerchantName: text("canonical_merchant_name").notNull(),
  canonicalMerchantDomain: text("canonical_merchant_domain"),
  paymentProcessor: text("payment_processor"),
  eventIds: varchar("event_ids").array().notNull(),
  resolutionConfidence: integer("resolution_confidence").notNull(),
  resolutionMethod: text("resolution_method").notNull(),
  resolutionStatus: entityResolutionStatusEnum("resolution_status").notNull(),
  potentialFalseMerge: boolean("potential_false_merge").notNull().default(false),
  potentialFalseSplit: boolean("potential_false_split").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EntityResolutionCandidate = typeof entityResolutionCandidates.$inferSelect;
export type InsertEntityResolutionCandidate = typeof entityResolutionCandidates.$inferInsert;

// Phase 3B.5: SHADOW SUBSCRIPTIONS ONLY. isShadow is always true today —
// nothing in the app reads this table to affect trials, reminders, or any
// production UX. entityKey exists purely to make idempotent upserts
// possible via a plain 2-column unique constraint (userId, entityKey)
// instead of a Postgres expression index — it's
// COALESCE(canonicalMerchantDomain, canonicalMerchantName) computed at
// write time, not a new independent piece of evidence.
export const shadowSubscriptionStatusEnum = pgEnum("shadow_subscription_status", [
  "active", "trial", "past_due", "canceled", "unknown",
]);

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  entityKey: text("entity_key").notNull(),
  canonicalMerchantName: text("canonical_merchant_name").notNull(),
  canonicalMerchantDomain: text("canonical_merchant_domain"),
  merchantConfidence: integer("merchant_confidence"),
  resolutionMethod: text("resolution_method").notNull(),
  resolutionStatus: entityResolutionStatusEnum("resolution_status").notNull(),
  planName: text("plan_name"),
  subscriptionStatus: shadowSubscriptionStatusEnum("subscription_status").notNull().default("unknown"),
  amount: decimal("amount", { precision: 10, scale: 2 }),
  currency: text("currency"),
  billingInterval: text("billing_interval"),
  nextBillingDate: date("next_billing_date"),
  lastBillingDate: date("last_billing_date"),
  sourceCanonicalEventId: varchar("source_canonical_event_id").notNull().references(() => subscriptionEvents.id),
  isShadow: boolean("is_shadow").notNull().default(true),
  potentialFalseMerge: boolean("potential_false_merge").notNull().default(false),
  potentialFalseSplit: boolean("potential_false_split").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("subscriptions_user_entity_key_unique").on(table.userId, table.entityKey),
]);

export type ShadowSubscription = typeof subscriptions.$inferSelect;
export type InsertShadowSubscription = typeof subscriptions.$inferInsert;

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
