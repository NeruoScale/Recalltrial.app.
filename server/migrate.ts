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

  console.log("[migrate] Done.");
}
