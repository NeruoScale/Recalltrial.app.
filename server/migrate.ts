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

  console.log("[migrate] Done.");
}
