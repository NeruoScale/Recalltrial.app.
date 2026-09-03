import { db } from "./db";
import { sql } from "drizzle-orm";

export async function runMigrations(): Promise<void> {
  console.log("[migrate] Running startup migrations...");

  try {
    await db.execute(sql`
      ALTER TABLE suggested_trials ADD COLUMN IF NOT EXISTS start_date_guess date;
    `);
    console.log("[migrate] suggested_trials.start_date_guess OK");
  } catch (err: any) {
    console.error("[migrate] start_date_guess:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE suggested_trials ADD COLUMN IF NOT EXISTS start_date_source text;
    `);
    console.log("[migrate] suggested_trials.start_date_source OK");
  } catch (err: any) {
    console.error("[migrate] start_date_source:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE trials ALTER COLUMN start_date DROP NOT NULL;
    `);
    console.log("[migrate] trials.start_date nullable OK");
  } catch (err: any) {
    if (err.message?.includes("column") && err.message?.includes("not exist")) {
      console.log("[migrate] trials.start_date already nullable (skipped)");
    } else {
      console.error("[migrate] trials.start_date:", err.message);
    }
  }

  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'TWO_DAYS'
            AND enumtypid = 'reminder_type'::regtype
        ) THEN
          ALTER TYPE reminder_type ADD VALUE 'TWO_DAYS';
        END IF;
      END $$;
    `);
    console.log("[migrate] reminder_type.TWO_DAYS OK");
  } catch (err: any) {
    console.error("[migrate] TWO_DAYS enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        token text NOT NULL UNIQUE,
        expires_at timestamp NOT NULL,
        used_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log("[migrate] password_reset_tokens table OK");
  } catch (err: any) {
    console.error("[migrate] password_reset_tokens:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS processed_purchase_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        checkout_session_id text NOT NULL UNIQUE,
        created_at timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log("[migrate] processed_purchase_events table OK");
  } catch (err: any) {
    console.error("[migrate] processed_purchase_events:", err.message);
  }

  // Phase 2 (Subscription Intelligence, PHASE1_AUDIT.md): subscription_events only.
  // subscriptions table intentionally NOT created yet. subscription_id stays
  // nullable with no FK until that table exists in a later step.
  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_event_type') THEN
          CREATE TYPE subscription_event_type AS ENUM (
            'trial_started', 'trial_ending', 'subscription_started', 'subscription_renewed',
            'payment_received', 'invoice_received', 'price_changed', 'cancellation_requested',
            'cancellation_confirmed', 'subscription_expired', 'subscription_paused',
            'unknown_subscription_event'
          );
        END IF;
      END $$;
    `);
    console.log("[migrate] subscription_event_type enum OK");
  } catch (err: any) {
    console.error("[migrate] subscription_event_type enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS subscription_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id varchar,
        user_id varchar NOT NULL REFERENCES users(id),
        event_type subscription_event_type NOT NULL,
        source_message_id text NOT NULL,
        extracted_price decimal(10, 2),
        extracted_currency text,
        extracted_date date,
        previous_price decimal(10, 2),
        new_price decimal(10, 2),
        confidence integer NOT NULL DEFAULT 0,
        detection_source text NOT NULL DEFAULT 'deterministic',
        ai_model text,
        created_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT subscription_events_user_message_type_unique UNIQUE (user_id, source_message_id, event_type)
      );
    `);
    console.log("[migrate] subscription_events table OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events:", err.message);
  }

  // Phase 3B.1/3B.2: broaden the event-type taxonomy. Additive only — the
  // original 12 enum values stay forever (205 real rows already use them,
  // e.g. 153 invoice_received); these 4 new values are what
  // detectSubscriptionEvent() actually produces going forward.
  // DO $$ ... $$ blocks can't take bind parameters (PostgreSQL limitation,
  // not a driver quirk — a DO block's body is opaque PL/pgSQL, not plain
  // SQL, so ${value}-style parameterization silently fails at bind time).
  // sql.raw() is safe here since `value` only ever comes from this
  // hardcoded local array, never external input.
  for (const value of ["subscription_invoice", "one_time_purchase", "subscription_cancelled", "payment_failed"]) {
    try {
      await db.execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumlabel = '${sql.raw(value)}'
              AND enumtypid = 'subscription_event_type'::regtype
          ) THEN
            ALTER TYPE subscription_event_type ADD VALUE '${sql.raw(value)}';
          END IF;
        END $$;
      `);
      console.log(`[migrate] subscription_event_type.${value} OK`);
    } catch (err: any) {
      console.error(`[migrate] subscription_event_type.${value}:`, err.message);
    }
  }

  try {
    await db.execute(sql`
      ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS extracted_merchant text;
    `);
    console.log("[migrate] subscription_events.extracted_merchant OK");
  } catch (err: any) {
    console.error("[migrate] extracted_merchant:", err.message);
  }

  // Phase 3B.3: merchant/processor normalization columns.
  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'merchant_resolution_status') THEN
          CREATE TYPE merchant_resolution_status AS ENUM ('resolved', 'ambiguous', 'unknown');
        END IF;
      END $$;
    `);
    console.log("[migrate] merchant_resolution_status enum OK");
  } catch (err: any) {
    console.error("[migrate] merchant_resolution_status enum:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE subscription_events
        ADD COLUMN IF NOT EXISTS canonical_merchant_name text,
        ADD COLUMN IF NOT EXISTS canonical_merchant_domain text,
        ADD COLUMN IF NOT EXISTS payment_processor text,
        ADD COLUMN IF NOT EXISTS merchant_confidence integer,
        ADD COLUMN IF NOT EXISTS merchant_resolution_status merchant_resolution_status;
    `);
    console.log("[migrate] subscription_events merchant columns OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events merchant columns:", err.message);
  }

  // Phase 3B.4: entity resolution SHADOW MODE table. No subscriptions
  // table, nothing reads this to change user-facing behavior — observation
  // only, per server/entityResolver.ts's header comment.
  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_resolution_status') THEN
          CREATE TYPE entity_resolution_status AS ENUM ('resolved', 'ambiguous', 'conflict', 'unresolved');
        END IF;
      END $$;
    `);
    console.log("[migrate] entity_resolution_status enum OK");
  } catch (err: any) {
    console.error("[migrate] entity_resolution_status enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS entity_resolution_candidates (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        proposed_subscription_id varchar NOT NULL,
        canonical_merchant_name text NOT NULL,
        canonical_merchant_domain text,
        payment_processor text,
        event_ids varchar[] NOT NULL,
        resolution_confidence integer NOT NULL,
        resolution_method text NOT NULL,
        resolution_status entity_resolution_status NOT NULL,
        potential_false_merge boolean NOT NULL DEFAULT false,
        potential_false_split boolean NOT NULL DEFAULT false,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log("[migrate] entity_resolution_candidates table OK");
  } catch (err: any) {
    console.error("[migrate] entity_resolution_candidates:", err.message);
  }

  // ── Phase 3B.5 Step 1: canonical event identity columns ──
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events
        ADD COLUMN IF NOT EXISTS canonical_event_id varchar,
        ADD COLUMN IF NOT EXISTS classification_generation integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS superseded_by varchar;
    `);
    console.log("[migrate] subscription_events canonical-identity columns OK");
  } catch (err: any) {
    console.error("[migrate] canonical-identity columns:", err.message);
  }

  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'subscription_events_superseded_by_fkey'
        ) THEN
          ALTER TABLE subscription_events
            ADD CONSTRAINT subscription_events_superseded_by_fkey
            FOREIGN KEY (superseded_by) REFERENCES subscription_events(id);
        END IF;
      END $$;
    `);
    console.log("[migrate] subscription_events.superseded_by FK OK");
  } catch (err: any) {
    console.error("[migrate] superseded_by FK:", err.message);
  }

  // ── Phase 3B.5 Step 2/3: shadow subscriptions table + idempotency constraint ──
  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shadow_subscription_status') THEN
          CREATE TYPE shadow_subscription_status AS ENUM ('active', 'trial', 'past_due', 'canceled', 'unknown');
        END IF;
      END $$;
    `);
    console.log("[migrate] shadow_subscription_status enum OK");
  } catch (err: any) {
    console.error("[migrate] shadow_subscription_status enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        entity_key text NOT NULL,
        canonical_merchant_name text NOT NULL,
        canonical_merchant_domain text,
        merchant_confidence integer,
        resolution_method text NOT NULL,
        resolution_status entity_resolution_status NOT NULL,
        plan_name text,
        subscription_status shadow_subscription_status NOT NULL DEFAULT 'unknown',
        amount decimal(10, 2),
        currency text,
        billing_interval text,
        next_billing_date date,
        last_billing_date date,
        source_canonical_event_id varchar NOT NULL REFERENCES subscription_events(id),
        is_shadow boolean NOT NULL DEFAULT true,
        potential_false_merge boolean NOT NULL DEFAULT false,
        potential_false_split boolean NOT NULL DEFAULT false,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT subscriptions_user_entity_key_unique UNIQUE (user_id, entity_key)
      );
    `);
    console.log("[migrate] subscriptions (shadow) table OK");
  } catch (err: any) {
    console.error("[migrate] subscriptions table:", err.message);
  }

  // ── Phase 3B.5 Step 5: canonicalize existing multi-generation groups ──
  // Idempotent by construction: scoped to WHERE canonical_event_id IS NULL,
  // so already-processed rows (including every row touched by a previous
  // run of this same migration) are left untouched on re-runs. Handles
  // single-row groups too (they just get canonical_event_id set to their
  // own id, generation stays 1, is_canonical stays true) — no special-casing
  // needed for "was this message ever reclassified or not."
  try {
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (PARTITION BY user_id, source_message_id ORDER BY created_at ASC) AS gen,
          COUNT(*) OVER (PARTITION BY user_id, source_message_id) AS total,
          FIRST_VALUE(id) OVER (PARTITION BY user_id, source_message_id ORDER BY created_at DESC) AS latest_id
        FROM subscription_events
        WHERE canonical_event_id IS NULL
      )
      UPDATE subscription_events se
      SET
        classification_generation = ranked.gen,
        is_canonical = (ranked.gen = ranked.total),
        superseded_by = CASE WHEN ranked.gen = ranked.total THEN NULL ELSE ranked.latest_id END,
        canonical_event_id = ranked.latest_id
      FROM ranked
      WHERE se.id = ranked.id;
    `);
    console.log(`[migrate] Phase 3B.5 canonicalization backfill: ${result.rowCount ?? 0} rows processed`);
  } catch (err: any) {
    console.error("[migrate] canonicalization backfill:", err.message);
  }

  // ── Phase 3B.7.2: persisted "last scan's message count" for the 3B.7.3 dashboard ──
  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_scan_messages_processed integer;
    `);
    console.log("[migrate] users.last_scan_messages_processed OK");
  } catch (err: any) {
    console.error("[migrate] last_scan_messages_processed:", err.message);
  }

  // ── Phase 3B.7.4: controlled promotion columns on subscriptions ──
  try {
    await db.execute(sql`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS promoted_at timestamp,
        ADD COLUMN IF NOT EXISTS promotion_reason text,
        ADD COLUMN IF NOT EXISTS promotion_evidence text;
    `);
    console.log("[migrate] subscriptions promotion columns OK");
  } catch (err: any) {
    console.error("[migrate] promotion columns:", err.message);
  }

  // ── Phase 3B.8: lifecycle "expired" state + subscription-native reminders ──
  try {
    // ALTER TYPE ... ADD VALUE cannot run inside a DO $$ ... $$ block in
    // Postgres (unlike CREATE TYPE above) — IF NOT EXISTS as a plain
    // top-level statement is the correct idempotent form here.
    await db.execute(sql`
      ALTER TYPE shadow_subscription_status ADD VALUE IF NOT EXISTS 'expired';
    `);
    console.log("[migrate] shadow_subscription_status.expired OK");
  } catch (err: any) {
    console.error("[migrate] shadow_subscription_status.expired:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS subscription_reminders (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id varchar NOT NULL REFERENCES subscriptions(id),
        user_id varchar NOT NULL REFERENCES users(id),
        remind_at timestamp NOT NULL,
        type reminder_type NOT NULL,
        status reminder_status NOT NULL DEFAULT 'PENDING',
        sent_at timestamp,
        provider text DEFAULT 'resend',
        provider_message_id text,
        last_error text,
        created_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT subscription_reminders_sub_type_unique UNIQUE (subscription_id, type)
      );
    `);
    console.log("[migrate] subscription_reminders table OK");
  } catch (err: any) {
    console.error("[migrate] subscription_reminders table:", err.message);
  }

  // ── Phase 3B.9.2A: extracted billing interval on subscription_events ──
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS billing_interval TEXT;
    `);
    console.log("[migrate] subscription_events.billing_interval OK");
  } catch (err: any) {
    console.error("[migrate] billing_interval column:", err.message);
  }

  // ── Phase 3B.9.3: billing intelligence provenance columns ──
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events
        ADD COLUMN IF NOT EXISTS billing_interval_source text,
        ADD COLUMN IF NOT EXISTS billing_interval_confidence text;
    `);
    console.log("[migrate] subscription_events billing intelligence columns OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events billing intelligence columns:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS billing_interval_source text,
        ADD COLUMN IF NOT EXISTS billing_interval_confidence text;
    `);
    console.log("[migrate] subscriptions billing intelligence columns OK");
  } catch (err: any) {
    console.error("[migrate] subscriptions billing intelligence columns:", err.message);
  }

  // ── Phase 3B.9.6A: subscriptionId FK backfill ──
  // Idempotent by construction: scoped to WHERE is_canonical = true AND
  // subscription_id IS NULL, so already-backfilled rows (from a previous
  // run of this same migration, or from Step 3's live wiring populating it
  // going forward) are excluded on every subsequent run — nothing left to
  // update once the eligible backlog is cleared. Only links a row when
  // EXACTLY ONE subscription matches (HAVING COUNT(*) = 1) — ambiguous
  // (2+) and unmatched (0) rows are silently left alone, never guessed.
  try {
    const result = await db.execute(sql`
      WITH eligible AS (
        SELECT id, user_id, canonical_merchant_domain, canonical_merchant_name
        FROM subscription_events
        WHERE is_canonical = true AND subscription_id IS NULL
      ),
      matches AS (
        SELECT e.id AS event_id, s.id AS subscription_id
        FROM eligible e
        JOIN subscriptions s
          ON s.user_id = e.user_id
          AND (
            (e.canonical_merchant_domain IS NOT NULL AND s.canonical_merchant_domain = e.canonical_merchant_domain)
            OR
            (e.canonical_merchant_domain IS NULL AND s.canonical_merchant_name = e.canonical_merchant_name)
          )
      ),
      unique_matches AS (
        SELECT event_id, MIN(subscription_id) AS subscription_id
        FROM matches
        GROUP BY event_id
        HAVING COUNT(*) = 1
      )
      UPDATE subscription_events se
      SET subscription_id = um.subscription_id
      FROM unique_matches um
      WHERE se.id = um.event_id;
    `);
    console.log(`[migrate] subscriptionId FK backfill: ${result.rowCount ?? 0} rows linked`);
  } catch (err: any) {
    console.error("[migrate] subscriptionId FK backfill:", err.message);
  }

  // ── Pre-3B.9.9 Privacy Gate: AI scanning opt-in ──
  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_scanning_enabled BOOLEAN DEFAULT FALSE;
    `);
    console.log("[migrate] users.ai_scanning_enabled OK");
  } catch (err: any) {
    console.error("[migrate] users.ai_scanning_enabled:", err.message);
  }

  // ── Phase 3B.9.8: price-change detection fields on subscriptions ──
  try {
    await db.execute(sql`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS last_price_change_at timestamp,
        ADD COLUMN IF NOT EXISTS last_price_change_type text,
        ADD COLUMN IF NOT EXISTS last_price_change_absolute decimal(10, 2),
        ADD COLUMN IF NOT EXISTS last_price_change_percentage decimal(6, 2),
        ADD COLUMN IF NOT EXISTS last_price_change_annual_impact decimal(10, 2);
    `);
    console.log("[migrate] subscriptions price-change columns OK");
  } catch (err: any) {
    console.error("[migrate] subscriptions price-change columns:", err.message);
  }

  // ── Phase 3B.9.7: extraction-layer provenance columns ──
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events
        ADD COLUMN IF NOT EXISTS amount_source text,
        ADD COLUMN IF NOT EXISTS interval_source text,
        ADD COLUMN IF NOT EXISTS date_source text;
    `);
    console.log("[migrate] subscription_events extraction provenance columns OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events extraction provenance columns:", err.message);
  }

  // ── Phase 3B.9.9: body_fetched column (see shared/schema.ts for why this
  // is distinct from amountSource/intervalSource/dateSource being 'body') ──
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS body_fetched boolean NOT NULL DEFAULT false;
    `);
    console.log("[migrate] subscription_events.body_fetched OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events.body_fetched:", err.message);
  }

  // ── Phase 3B.9.9: AI enrichment job queue ──
  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_enrichment_job_status') THEN
          CREATE TYPE ai_enrichment_job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead_letter');
        END IF;
      END $$;
    `);
    console.log("[migrate] ai_enrichment_job_status enum OK");
  } catch (err: any) {
    console.error("[migrate] ai_enrichment_job_status enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_enrichment_jobs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        subscription_event_id varchar NOT NULL REFERENCES subscription_events(id),
        status ai_enrichment_job_status NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        provider text NOT NULL DEFAULT 'anthropic',
        model text NOT NULL DEFAULT 'claude-haiku-4-5',
        requested_at timestamp DEFAULT now() NOT NULL,
        started_at timestamp,
        completed_at timestamp,
        error_code text,
        input_token_count integer,
        output_token_count integer,
        estimated_cost_usd decimal(10, 6),
        fields_improved text[],
        created_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT ai_enrichment_jobs_subscription_event_id_unique UNIQUE (subscription_event_id)
      );
    `);
    console.log("[migrate] ai_enrichment_jobs table OK");
  } catch (err: any) {
    console.error("[migrate] ai_enrichment_jobs table:", err.message);
  }

  // ── Phase 3B.9.10: AI credits & monetization ──

  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'no_credits' AND enumtypid = 'ai_enrichment_job_status'::regtype
        ) THEN
          ALTER TYPE ai_enrichment_job_status ADD VALUE 'no_credits';
        END IF;
      END $$;
    `);
    console.log("[migrate] ai_enrichment_job_status.no_credits OK");
  } catch (err: any) {
    console.error("[migrate] ai_enrichment_job_status.no_credits:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS ai_credits_included integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ai_credits_purchased integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ai_credits_reset_at timestamp,
        ADD COLUMN IF NOT EXISTS ai_scanning_consent_at timestamp,
        ADD COLUMN IF NOT EXISTS ai_scanning_consent_version text;
    `);
    console.log("[migrate] users AI credit columns OK");
  } catch (err: any) {
    console.error("[migrate] users AI credit columns:", err.message);
  }

  try {
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_credit_ledger_type') THEN
          CREATE TYPE ai_credit_ledger_type AS ENUM ('monthly_grant', 'purchase', 'usage', 'refund', 'adjustment', 'expiration');
        END IF;
      END $$;
    `);
    console.log("[migrate] ai_credit_ledger_type enum OK");
  } catch (err: any) {
    console.error("[migrate] ai_credit_ledger_type enum:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_credit_ledger (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        type ai_credit_ledger_type NOT NULL,
        amount integer NOT NULL,
        balance_after integer NOT NULL,
        reference_id text,
        metadata jsonb,
        created_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT ai_credit_ledger_reference_type_unique UNIQUE (reference_id, type)
      );
    `);
    console.log("[migrate] ai_credit_ledger table OK");
  } catch (err: any) {
    console.error("[migrate] ai_credit_ledger table:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
    console.log("[migrate] users.preferences OK");
  } catch (err: any) {
    console.error("[migrate] users.preferences:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS user_confirmed boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS user_confirmed_at timestamp,
        ADD COLUMN IF NOT EXISTS user_dismissed boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS user_dismissed_at timestamp;
    `);
    console.log("[migrate] subscriptions userConfirmed/userDismissed columns OK");
  } catch (err: any) {
    console.error("[migrate] subscriptions userConfirmed/userDismissed columns:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_intelligence_enabled boolean NOT NULL DEFAULT false;
    `);
    console.log("[migrate] users.subscription_intelligence_enabled OK");
  } catch (err: any) {
    console.error("[migrate] users.subscription_intelligence_enabled:", err.message);
  }

  // ── Gmail Account Switching / Fresh-Data Isolation Architecture ───────────
  // PHASE A: email_connections foundation. Compatibility layer — the
  // existing users Gmail columns are NOT touched or removed by any of this.

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS email_connections (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id varchar NOT NULL REFERENCES users(id),
        provider text NOT NULL DEFAULT 'google',
        provider_account_id text,
        email_address text,
        access_token text NOT NULL,
        refresh_token text,
        token_expiry timestamp,
        connected_at timestamp DEFAULT now() NOT NULL,
        disconnected_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL
      );
    `);
    console.log("[migrate] email_connections table OK");
  } catch (err: any) {
    console.error("[migrate] email_connections table:", err.message);
  }

  try {
    // Partial unique index: at most one ACTIVE (disconnected_at IS NULL)
    // connection per (user, provider) — historical disconnected rows for
    // the same provider are unrestricted. Drizzle's table-builder unique()
    // can't express a WHERE clause, hence raw SQL here, same as every other
    // non-trivial constraint in this file.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS email_connections_one_active_per_provider
        ON email_connections (user_id, provider)
        WHERE disconnected_at IS NULL;
    `);
    console.log("[migrate] email_connections active-connection uniqueness index OK");
  } catch (err: any) {
    console.error("[migrate] email_connections active-connection uniqueness index:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS email_connections_user_id_idx ON email_connections (user_id);
    `);
    console.log("[migrate] email_connections.user_id index OK");
  } catch (err: any) {
    console.error("[migrate] email_connections.user_id index:", err.message);
  }

  // PHASE C: event provenance. Nullable — historical rows stay NULL forever
  // (their originating Gmail account cannot be reliably reconstructed).
  try {
    await db.execute(sql`
      ALTER TABLE subscription_events ADD COLUMN IF NOT EXISTS email_connection_id varchar;
    `);
    console.log("[migrate] subscription_events.email_connection_id OK");
  } catch (err: any) {
    console.error("[migrate] subscription_events.email_connection_id:", err.message);
  }

  // PHASE D: safe lifecycle protection fields.
  try {
    await db.execute(sql`
      ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS last_event_email_connection_id varchar,
        ADD COLUMN IF NOT EXISTS cross_account_conflict boolean NOT NULL DEFAULT false;
    `);
    console.log("[migrate] subscriptions lastEventEmailConnectionId/crossAccountConflict columns OK");
  } catch (err: any) {
    console.error("[migrate] subscriptions lastEventEmailConnectionId/crossAccountConflict columns:", err.message);
  }

  // Phase 4.2: additive enum value for the atomic subscription-reminder
  // delivery claim (PENDING -> SENDING -> SENT/FAILED). Shared reminder_status
  // enum with the legacy `reminders` (trial) table — that table's delivery
  // code is untouched and never writes this value, so this is a pure
  // additive change with zero effect on existing data/behavior.
  try {
    await db.execute(sql`
      ALTER TYPE reminder_status ADD VALUE IF NOT EXISTS 'SENDING';
    `);
    console.log("[migrate] reminder_status.SENDING OK");
  } catch (err: any) {
    console.error("[migrate] reminder_status.SENDING:", err.message);
  }

  // Phase 4.4: reminder preference (default true — preserves existing
  // behavior for every current user) and the stale-SENDING claim timestamp.
  // Both additive; no existing row is touched or deleted.
  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_reminders_enabled boolean NOT NULL DEFAULT true;
    `);
    console.log("[migrate] users.subscription_reminders_enabled OK");
  } catch (err: any) {
    console.error("[migrate] users.subscription_reminders_enabled:", err.message);
  }

  try {
    await db.execute(sql`
      ALTER TABLE subscription_reminders ADD COLUMN IF NOT EXISTS claimed_at timestamp;
    `);
    console.log("[migrate] subscription_reminders.claimed_at OK");
  } catch (err: any) {
    console.error("[migrate] subscription_reminders.claimed_at:", err.message);
  }

  // ── Price Increase Notification: completes 3B.9.8's remaining "Notify
  // user" piece. Additive only — reuses the existing reminder_status enum,
  // no existing table/column touched or altered.
  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS price_increase_notifications_enabled boolean NOT NULL DEFAULT true;
    `);
    console.log("[migrate] users.price_increase_notifications_enabled OK");
  } catch (err: any) {
    console.error("[migrate] users.price_increase_notifications_enabled:", err.message);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS price_increase_notifications (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id varchar NOT NULL REFERENCES subscriptions(id),
        user_id varchar NOT NULL REFERENCES users(id),
        detected_at date NOT NULL,
        previous_amount decimal(10,2) NOT NULL,
        previous_currency text NOT NULL,
        previous_interval text,
        new_amount decimal(10,2) NOT NULL,
        new_currency text NOT NULL,
        new_interval text,
        percentage_change decimal(6,2) NOT NULL,
        monthly_impact decimal(10,2) NOT NULL,
        annual_impact decimal(10,2) NOT NULL,
        status reminder_status NOT NULL DEFAULT 'PENDING',
        sent_at timestamp,
        provider text DEFAULT 'resend',
        provider_message_id text,
        last_error text,
        claimed_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL,
        CONSTRAINT price_increase_notifications_occurrence_unique UNIQUE (subscription_id, detected_at, previous_amount, new_amount)
      );
    `);
    console.log("[migrate] price_increase_notifications table OK");
  } catch (err: any) {
    console.error("[migrate] price_increase_notifications table:", err.message);
  }

  console.log("[migrate] Done.");
}
