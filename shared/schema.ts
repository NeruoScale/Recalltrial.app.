import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, date, decimal, pgEnum, integer, boolean, unique, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const trialStatusEnum = pgEnum("trial_status", ["ACTIVE", "CANCELED"]);
export const reminderTypeEnum = pgEnum("reminder_type", ["THREE_DAYS", "TWO_DAYS", "ONE_DAY", "TWENTY_FOUR_HOURS", "THREE_HOURS", "SIX_HOURS", "ONE_HOUR"]);
// SENDING (Phase 4.2): the atomic claim state for subscription_reminders
// delivery — a row transitions PENDING -> SENDING via a single conditional
// UPDATE ... WHERE status='PENDING', which is what makes the claim atomic
// under concurrent cron workers. Added here (not a separate enum) because
// this type is shared with the legacy `reminders` (trial) table; the trial
// delivery path is untouched and never produces this value.
export const reminderStatusEnum = pgEnum("reminder_status", ["PENDING", "SENDING", "SENT", "SKIPPED", "FAILED"]);
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
  // Pre-3B.9.9 Privacy Gate: separate from emailScanningEnabled (which only
  // gates deterministic keyword-based Gmail scanning, already live). This
  // one specifically gates sending email content to an external AI
  // provider — a materially different privacy decision that needs its own
  // explicit opt-in, never inferred from the existing scanning toggle.
  // Defaults false: no user gets AI scanning without deliberately turning
  // it on. Deployed ahead of the AI enrichment engine itself (Phase
  // 3B.9.9) so the consent surface exists before there's anything for it
  // to gate.
  aiScanningEnabled: boolean("ai_scanning_enabled").notNull().default(false),
  gmailConnected: boolean("gmail_connected").notNull().default(false),
  gmailAccessToken: text("gmail_access_token"),
  gmailRefreshToken: text("gmail_refresh_token"),
  gmailTokenExpiry: timestamp("gmail_token_expiry"),
  lastEmailScanAt: timestamp("last_email_scan_at"),
  // Phase 3B.7.2: messagesProcessed from the most recent scan's ScanResult
  // (see server/gmail.ts) — persisted so the Phase 3B.7.3 dashboard can show
  // "Detected from X emails scanned" without re-deriving it from
  // subscription_events (which would only count messages that produced a
  // candidate, undercounting true scan volume).
  lastScanMessagesProcessed: integer("last_scan_messages_processed"),
  // Phase 3B.9.10: AI credit balances. aiCreditsIncluded is a monthly
  // allowance that RESETS (overwrites, does not accumulate) on each grant —
  // "use it or lose it," matching RECALLTRIAL_ROADMAP.md's "reset monthly"
  // language. aiCreditsPurchased is a separate, never-expiring balance from
  // Stripe top-up packs; the monthly reset must never touch it. Both are
  // authoritative current balances — server/aiCreditLedger.ts's ledger
  // table is the append-only audit trail of every change to them, not the
  // other way around.
  aiCreditsIncluded: integer("ai_credits_included").notNull().default(0),
  aiCreditsPurchased: integer("ai_credits_purchased").notNull().default(0),
  aiCreditsResetAt: timestamp("ai_credits_reset_at"),
  // Consent record for sending email content to an external AI provider —
  // separate from the aiScanningEnabled boolean toggle itself (Pre-3B.9.9
  // Privacy Gate): this captures WHEN and under WHICH version of the
  // consent text the user agreed, for auditability if the consent language
  // ever changes.
  aiScanningConsentAt: timestamp("ai_scanning_consent_at"),
  aiScanningConsentVersion: text("ai_scanning_consent_version"),
  // Phase 3C.2: freeform per-user UI preferences that don't warrant their
  // own column — starting with dismissedSavingsOpportunities (subscription
  // ids the user has dismissed from the savings section). Never read by any
  // lifecycle/billing/reminder logic — display-only.
  preferences: jsonb("preferences").$type<{ dismissedSavingsOpportunities?: string[] }>().notNull().default({}),
  // Subscription Intelligence V1 controlled-beta gate (Phase 3C.1-3C.4:
  // Savings, Recommendations, AI Analyst, Track/Confirm). Same shape as
  // emailScanningEnabled/aiScanningEnabled — a per-user opt-in boolean,
  // defaults false. Deliberately does NOT gate the underlying subscription
  // detection/vault (Phase 3B, already fully launched) — only the
  // intelligence layer built on top of it. No self-serve toggle route
  // exists yet; enabled per-user by direct operator action during the beta.
  subscriptionIntelligenceEnabled: boolean("subscription_intelligence_enabled").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Email connection isolation architecture (Gmail Account Switching audit,
// PHASE A) ────────────────────────────────────────────────────────────────
//
// COMPATIBILITY LAYER, not a replacement: users.gmailAccessToken/
// RefreshToken/Expiry/Connected/lastEmailScanAt remain the live source of
// truth for the existing connect/disconnect/scan flow (unchanged, still
// single-slot) — this table is written ALONGSIDE them (dual-write), never
// instead of them, per the explicit approved-design constraint. It exists
// so evidence (subscription_events, eventually) can be scoped to WHICH
// connection produced it, and so a user's connection HISTORY survives
// across disconnect/reconnect, neither of which the single-slot users
// columns can represent.
//
// providerAccountId (Google's stable `sub` claim) and emailAddress are
// nullable because Phase A ships before Phase B's OAuth scope change
// actually supplies them — a row can exist with only tokens+timestamps
// until the identity fields are backfilled by a subsequent reconnect.
export const emailConnections = pgTable("email_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull().default("google"),
  providerAccountId: text("provider_account_id"),
  emailAddress: text("email_address"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  connectedAt: timestamp("connected_at").defaultNow().notNull(),
  // NULL = currently active. A partial unique index enforcing "at most one
  // active connection per (userId, provider)" is added via raw SQL in
  // migrate.ts (Drizzle's table-builder unique() can't express a WHERE
  // clause) — historical (disconnected) rows for the same provider are
  // expected and unrestricted.
  disconnectedAt: timestamp("disconnected_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EmailConnection = typeof emailConnections.$inferSelect;
export type InsertEmailConnection = typeof emailConnections.$inferInsert;

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
  // PHASE C (Account Isolation): which email_connections row produced this
  // event — captured once at scan start (same moment the token snapshot is
  // captured) and stamped on every event that scan writes. NULL for every
  // historical row written before this phase, and deliberately left NULL
  // forever for them — there is no reliable way to reconstruct which Gmail
  // account a pre-existing row came from, so this is never backfilled/guessed.
  emailConnectionId: varchar("email_connection_id"),
  eventType: subscriptionEventTypeEnum("event_type").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  extractedPrice: decimal("extracted_price", { precision: 10, scale: 2 }),
  extractedCurrency: text("extracted_currency"),
  extractedDate: date("extracted_date"),
  extractedMerchant: text("extracted_merchant"),
  previousPrice: decimal("previous_price", { precision: 10, scale: 2 }),
  newPrice: decimal("new_price", { precision: 10, scale: 2 }),
  // Phase 3B.9.2A: extracted directly from message text (server/gmail.ts's
  // extractBillingInterval()) — never guessed from price or merchant.
  billingInterval: text("billing_interval"),
  // Phase 3B.9.3: provenance for THIS event's own billingInterval value —
  // always 'confirmed_email' when non-null (this column is only ever
  // written by extractBillingInterval(), the Tier 1 evidence source; see
  // server/billingIntelligence.ts for the full tier model applied at the
  // subscription level, not the individual-event level).
  billingIntervalSource: text("billing_interval_source"),
  billingIntervalConfidence: text("billing_interval_confidence"),
  // Phase 3B.9.7: which extraction layer supplied extractedPrice/
  // billingInterval/extractedDate on THIS row — 'snippet' (metadata+snippet,
  // Layer 1) or 'body' (second-stage full-body fetch, Layer 2). Null means
  // that field itself is null (nothing found in either layer) or this row
  // predates Phase 3B.9.7 (written before these columns existed).
  amountSource: text("amount_source"),
  intervalSource: text("interval_source"),
  dateSource: text("date_source"),
  // Phase 3B.9.9: whether a full-body fetch was actually AVAILABLE for this
  // event at write time — distinct from amountSource/intervalSource/
  // dateSource being 'body' (which only means the body supplied THAT
  // specific field). A body can be fetched successfully yet supply nothing
  // new (e.g. every field was already snippet-sourced, or the body simply
  // didn't mention them) — isEligibleForAI() needs to know "did we already
  // give deterministic extraction its best shot at the full email," not
  // "did the body happen to win any individual field."
  bodyFetched: boolean("body_fetched").notNull().default(false),
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

// Phase 3B.9.9: AI enrichment job queue. One row per subscription_events
// row ever queued for AI enrichment — the unique constraint on
// subscriptionEventId is what makes queueing idempotent (ON CONFLICT DO
// NOTHING at the storage layer, not a pre-check SELECT). 'failed' is a
// RETRYABLE terminal-for-now state (transient errors — timeout, rate
// limit — set this, and a later cron pass may re-claim it once its
// backoff window elapses and attempts < maxAttempts); 'dead_letter' is a
// truly terminal state (attempts exhausted, or a non-retryable error like
// a Zod schema violation that would never succeed on retry).
export const aiEnrichmentJobStatusEnum = pgEnum("ai_enrichment_job_status", [
  "pending", "processing", "completed", "failed", "dead_letter",
  // Phase 3B.9.10: terminal, non-retryable — the user's credit balance was
  // exhausted at claim time. Distinct from 'failed' (a Claude-side error)
  // since retrying without new credits would just fail the same way again;
  // if the user tops up later, a fresh scan queues a fresh job rather than
  // this one being resurrected.
  "no_credits",
]);

export const aiEnrichmentJobs = pgTable("ai_enrichment_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  subscriptionEventId: varchar("subscription_event_id").notNull().references(() => subscriptionEvents.id),
  status: aiEnrichmentJobStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull().default("claude-haiku-4-5"),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  // Distinguishes retryable transient failures ('timeout', 'rate_limited')
  // from non-retryable ones ('schema_validation_failed',
  // 'ai_scanning_disabled', 'claude_error') — see server/aiEnrichmentQueue.ts's
  // RETRYABLE_ERROR_CODES, which the cron re-fetch query keys off of.
  errorCode: text("error_code"),
  inputTokenCount: integer("input_token_count"),
  outputTokenCount: integer("output_token_count"),
  estimatedCostUsd: decimal("estimated_cost_usd", { precision: 10, scale: 6 }),
  fieldsImproved: text("fields_improved").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("ai_enrichment_jobs_subscription_event_id_unique").on(table.subscriptionEventId),
]);

export type AIEnrichmentJob = typeof aiEnrichmentJobs.$inferSelect;
export type InsertAIEnrichmentJob = typeof aiEnrichmentJobs.$inferInsert;

// Phase 3B.9.10: append-only audit trail for every change to
// users.aiCreditsIncluded/aiCreditsPurchased — the users-table columns are
// the authoritative CURRENT balance (every mutation goes through
// server/aiCredits.ts, which updates both the balance and this ledger in
// the same operation), this table exists purely for observability/
// auditability, never as a second source of truth to sum on the fly.
//
// The unique constraint on (referenceId, type) is what makes usage/refund/
// purchase entries idempotent at the DB level (onConflictDoNothing, not a
// pre-check SELECT — the same "let the constraint own it" pattern used
// throughout this feature line). referenceId is nullable and Postgres
// treats every NULL as distinct for uniqueness purposes, so monthly_grant/
// adjustment entries (referenceId always null, idempotency instead owned
// by users.aiCreditsResetAt's own 30-day check) are never constrained by
// this index. referenceId for a 'usage'/'refund' pair is scoped to a
// single AI-enrichment ATTEMPT (`${jobId}:${attemptNumber}`, see
// server/aiEnrichmentQueue.ts), not the job as a whole — a retried job
// legitimately reserves and (on failure) refunds a fresh credit on each
// attempt, so the referenceId must be attempt-scoped or a second attempt's
// genuine new reservation would collide with the first attempt's.
export const aiCreditLedgerTypeEnum = pgEnum("ai_credit_ledger_type", [
  "monthly_grant", "purchase", "usage", "refund", "adjustment", "expiration",
]);

export const aiCreditLedger = pgTable("ai_credit_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  type: aiCreditLedgerTypeEnum("type").notNull(),
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("ai_credit_ledger_reference_type_unique").on(table.referenceId, table.type),
]);

export type AICreditLedgerEntry = typeof aiCreditLedger.$inferSelect;
export type InsertAICreditLedgerEntry = typeof aiCreditLedger.$inferInsert;

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
// Phase 3B.8: added "expired" as a reachable lifecycle state (see
// server/subscriptionLifecycle.ts). Deliberately keeps the existing
// "canceled" (single-L) spelling rather than renaming to match the task's
// prose spelling of "cancelled" — an ALTER TYPE RENAME VALUE on an enum
// with live production rows is unnecessary risk for a cosmetic spelling
// difference; the STATE this represents is unambiguous either way.
export const shadowSubscriptionStatusEnum = pgEnum("shadow_subscription_status", [
  "active", "trial", "past_due", "canceled", "expired", "unknown",
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
  // Phase 3B.9.3: provenance for the subscription's CURRENT billingInterval
  // — see server/billingIntelligence.ts for the 4-tier evidence model
  // (confirmed_email > merchant_knowledge > inferred > unknown) that
  // decides these two fields. Never downgraded: a higher tier is never
  // overwritten by a lower one, even as new events arrive.
  billingIntervalSource: text("billing_interval_source"),
  billingIntervalConfidence: text("billing_interval_confidence"),
  nextBillingDate: date("next_billing_date"),
  lastBillingDate: date("last_billing_date"),
  sourceCanonicalEventId: varchar("source_canonical_event_id").notNull().references(() => subscriptionEvents.id),
  isShadow: boolean("is_shadow").notNull().default(true),
  potentialFalseMerge: boolean("potential_false_merge").notNull().default(false),
  potentialFalseSplit: boolean("potential_false_split").notNull().default(false),
  // Phase 3B.7.4: controlled production activation. promotedAt is set the
  // instant isShadow flips true -> false; promotionReason/promotionEvidence
  // record why, for auditability. All three stay null for rows that have
  // never been promoted (still shadow, or shadow forever if ineligible).
  promotedAt: timestamp("promoted_at"),
  promotionReason: text("promotion_reason"),
  promotionEvidence: text("promotion_evidence"),
  // Phase 3B.9.8: most recent price-change DETECTION result — server/
  // priceChangeDetector.ts's output, written by server/subscriptionLifecycle.ts
  // after processing an event. Purely observational (never read by
  // computeReminders()/trials, never mutates `amount` itself — `amount`
  // stays owned entirely by Phase 3B.8's existing lifecycle rules).
  lastPriceChangeAt: timestamp("last_price_change_at"),
  lastPriceChangeType: text("last_price_change_type"),
  lastPriceChangeAbsolute: decimal("last_price_change_absolute", { precision: 10, scale: 2 }),
  lastPriceChangePercentage: decimal("last_price_change_percentage", { precision: 6, scale: 2 }),
  lastPriceChangeAnnualImpact: decimal("last_price_change_annual_impact", { precision: 10, scale: 2 }),
  // Phase 3C.2: explicit user acknowledgement, independent of isShadow/
  // promotion. A subscription can be userConfirmed even with amount=null —
  // "yes this is mine" is a statement about identity, not about billing
  // data completeness. Never read by lifecycle/reminder/billing logic.
  userConfirmed: boolean("user_confirmed").notNull().default(false),
  userConfirmedAt: timestamp("user_confirmed_at"),
  // userDismissed hides a subscription from the main list (GET /api/subscriptions
  // filters it out by default) without deleting it — preserved for audit,
  // recoverable via ?showDismissed=true. Distinct from savings-opportunity
  // dismissal (users.preferences.dismissedSavingsOpportunities), which only
  // hides a subscription from the SAVINGS section, not the main list.
  userDismissed: boolean("user_dismissed").notNull().default(false),
  userDismissedAt: timestamp("user_dismissed_at"),
  // PHASE D (Account Isolation): which email_connections row most recently
  // supplied this subscription's billing facts (amount/currency/
  // nextBillingDate) — NOT the same as sourceCanonicalEventId (that's fixed
  // at row creation and never refreshed; this one IS refreshed on every
  // applied billing update). NULL for rows predating this phase, or
  // whenever the supplying event itself had no known connection.
  lastEventEmailConnectionId: varchar("last_event_email_connection_id"),
  // Set true when a DIFFERENT connection's evidence conflicted with the
  // current known billing facts and was deliberately NOT applied (RULE 3) —
  // never cleared automatically except by a later non-conflicting update
  // from a different connection (RULE 2). Purely observational: never read
  // by lifecycle/reminder/billing logic, matches lastPriceChange*'s own
  // "observational only" precedent above.
  crossAccountConflict: boolean("cross_account_conflict").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("subscriptions_user_entity_key_unique").on(table.userId, table.entityKey),
]);

export type ShadowSubscription = typeof subscriptions.$inferSelect;
export type InsertShadowSubscription = typeof subscriptions.$inferInsert;

// Phase 3B.8 Step 5: subscription-native reminders — deliberately a SEPARATE
// table from `reminders`, not a reuse of it. `reminders.trialId` is
// NOT NULL with a hard FK to `trials.id` (shared/schema.ts's original
// table); loosening that constraint to support non-trial-linked reminders
// would be exactly the kind of change to existing trial/reminder behavior
// this phase's boundaries forbid. This also matches PHASE1_AUDIT.md §9's
// own explicit recommendation: subscription-native alerts must be a
// "distinct notification type" from trial reminders, not a shared row
// shape, specifically so the two systems can never collide/double-remind
// for the same date. Reuses reminderTypeEnum/reminderStatusEnum (same
// THREE_DAYS/TWO_DAYS/ONE_DAY vocabulary, same PENDING/SENT/SKIPPED/FAILED
// lifecycle) since those concepts are identical — only the "what this
// reminder is about" foreign key differs.
export const subscriptionReminders = pgTable("subscription_reminders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subscriptionId: varchar("subscription_id").notNull().references(() => subscriptions.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  remindAt: timestamp("remind_at").notNull(),
  type: reminderTypeEnum("type").notNull(),
  status: reminderStatusEnum("status").notNull().default("PENDING"),
  sentAt: timestamp("sent_at"),
  provider: text("provider").default("resend"),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("subscription_reminders_sub_type_unique").on(table.subscriptionId, table.type),
]);

export type SubscriptionReminder = typeof subscriptionReminders.$inferSelect;
export type InsertSubscriptionReminder = typeof subscriptionReminders.$inferInsert;

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
