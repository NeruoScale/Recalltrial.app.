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

  console.log("[migrate] Done.");
}
