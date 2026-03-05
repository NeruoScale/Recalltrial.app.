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

  console.log("[migrate] Done.");
}
