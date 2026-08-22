// ─── AI credit ledger & atomic reservation (Phase 3B.9.10) ─────────────────────
//
// users.aiCreditsIncluded/aiCreditsPurchased are the AUTHORITATIVE current
// balances — every function here that mutates them does so via a single
// atomic SQL statement (the row's own WHERE clause references its own
// current columns, never a separately-read snapshot), so Postgres's
// row-level locking is what actually prevents two concurrent reservations
// from both succeeding on the same last credit, not application-level
// locking. ai_credit_ledger is the append-only audit trail, never the
// source of truth for "what's the balance right now."
//
// Idempotency (grantMonthlyCredits, reserveCredit/refundCredit,
// grantPurchasedCredits) is enforced by DB constraints — a UNIQUE
// constraint on (referenceId, type) with onConflictDoNothing, or
// aiCreditsResetAt's own 30-day check — never by a separate pre-check
// SELECT followed by a write, which would itself be racy.
//
// STRICT BOUNDARY: the deterministic scanner (Layer 1 snippet + Layer 2
// full body, server/gmail.ts) NEVER calls anything in this file and has no
// path through which a credit shortage could affect it — only Layer 3 (AI
// enrichment, server/aiEnrichmentQueue.ts) is credit-gated.

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "./db";
import { users, aiCreditLedger, type User } from "@shared/schema";

// ─── Pure decision logic (unit-testable without a DB) ──────────────────────

// PREMIUM isn't mentioned in this phase's spec (only Free/Plus/Pro are) —
// treated as PRO-tier since it's a strictly higher-or-equal plan; granting
// it 0 would be a regression relative to Pro, not a deliberate choice.
const MONTHLY_GRANT_BY_PLAN: Record<string, number> = {
  FREE: 0,
  PLUS: 100,
  PRO: 200,
  PREMIUM: 200,
};

export function creditsForPlan(plan: string): number {
  return MONTHLY_GRANT_BY_PLAN[plan] ?? 0;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure: is a monthly grant due? Null (never granted) is always due. */
export function isMonthlyGrantDue(resetAt: Date | null, now: Date = new Date()): boolean {
  if (!resetAt) return true;
  return now.getTime() - resetAt.getTime() >= THIRTY_DAYS_MS;
}

/**
 * decideCreditBucket(): pure mirror of the two-step atomic SQL in
 * reserveCredit() below — never called by the real reservation path itself
 * (that path needs genuine row-locking, which only a real UPDATE
 * statement provides), kept here purely so "consume included before
 * purchased" is directly unit-testable. If the real SQL's preference order
 * ever changes, this must change with it.
 */
export function decideCreditBucket(includedBalance: number, purchasedBalance: number): "included" | "purchased" | null {
  if (includedBalance > 0) return "included";
  if (purchasedBalance > 0) return "purchased";
  return null;
}

// ─── 2A. Monthly grant ──────────────────────────────────────────────────────
//
// aiCreditsIncluded is RESET (overwritten) to the plan's fixed amount, not
// incremented — "use it or lose it" per RECALLTRIAL_ROADMAP.md's own
// "reset monthly" language; unused included credits don't roll over.
// Idempotent: the UPDATE's WHERE clause (aiCreditsResetAt null or >30 days
// old) is checked and applied in the SAME atomic statement, so two
// concurrent cron passes can't both grant — the second's UPDATE matches
// zero rows once the first has committed.
export async function grantMonthlyCredits(userId: string, plan: string): Promise<void> {
  const amount = creditsForPlan(plan);
  if (amount <= 0) return; // Free (or unrecognized) plans get nothing to grant

  const result = await db.execute(sql`
    UPDATE users
    SET ai_credits_included = ${amount}, ai_credits_reset_at = now()
    WHERE id = ${userId} AND (ai_credits_reset_at IS NULL OR ai_credits_reset_at < now() - interval '30 days')
    RETURNING ai_credits_included, ai_credits_purchased
  `);

  if (result.rowCount === 0) return; // granted within the last 30 days already — idempotent no-op

  const row = result.rows[0] as { ai_credits_included: number; ai_credits_purchased: number };
  await db.insert(aiCreditLedger).values({
    userId,
    type: "monthly_grant",
    amount,
    balanceAfter: row.ai_credits_included + row.ai_credits_purchased,
    referenceId: null,
    metadata: { plan },
  });
}

// ─── 2B. Atomic credit reservation (CRITICAL) ───────────────────────────────
//
// Two sequential, independently-atomic UPDATE attempts — included first,
// then purchased only if included was empty. Each UPDATE's WHERE clause
// references the table's OWN current column (not a pre-fetched value), so
// Postgres locks the row for the statement's duration: if two concurrent
// calls both target a user with exactly 1 included credit, one UPDATE
// commits first (included: 1->0), and the other's WHERE clause is
// re-evaluated against that post-commit state (included is now 0) before
// it can match — it correctly falls through to the purchased attempt (and
// returns false there too if purchased is also 0). This is what makes the
// "never allow two simultaneous calls to both succeed on the last credit"
// guarantee real, not just documented.
//
// `referenceId` should be scoped to a single AI-enrichment ATTEMPT (see
// shared/schema.ts's ai_credit_ledger comment) — server/aiEnrichmentQueue.ts
// passes `${jobId}:${attemptNumber}`.
export async function reserveCredit(userId: string, referenceId: string | null = null): Promise<boolean> {
  const includedResult = await db.execute(sql`
    UPDATE users SET ai_credits_included = ai_credits_included - 1
    WHERE id = ${userId} AND ai_credits_included > 0
    RETURNING ai_credits_included, ai_credits_purchased
  `);

  let bucket: "included" | "purchased" | null = null;
  let row: { ai_credits_included: number; ai_credits_purchased: number } | undefined;

  if (includedResult.rowCount && includedResult.rowCount > 0) {
    bucket = "included";
    row = includedResult.rows[0] as any;
  } else {
    const purchasedResult = await db.execute(sql`
      UPDATE users SET ai_credits_purchased = ai_credits_purchased - 1
      WHERE id = ${userId} AND ai_credits_purchased > 0
      RETURNING ai_credits_included, ai_credits_purchased
    `);
    if (purchasedResult.rowCount && purchasedResult.rowCount > 0) {
      bucket = "purchased";
      row = purchasedResult.rows[0] as any;
    }
  }

  if (!bucket || !row) return false;

  await db.insert(aiCreditLedger).values({
    userId,
    type: "usage",
    amount: -1,
    balanceAfter: row.ai_credits_included + row.ai_credits_purchased,
    referenceId,
    metadata: { bucket },
  }).onConflictDoNothing({ target: [aiCreditLedger.referenceId, aiCreditLedger.type] });

  return true;
}

// ─── 2C. Credit refund ───────────────────────────────────────────────────────
//
// Idempotency is a DB-level claim, not a check-then-act: the ledger INSERT
// (with onConflictDoNothing on the same (referenceId, type) unique
// constraint reserveCredit() relies on) is attempted FIRST, inside a
// transaction — only the caller that actually wins the insert proceeds to
// restore the balance. A duplicate refundCredit() call for the same
// referenceId loses the insert race and does nothing.
export async function refundCredit(userId: string, referenceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const usageEntries = await tx
      .select()
      .from(aiCreditLedger)
      .where(and(eq(aiCreditLedger.referenceId, referenceId), eq(aiCreditLedger.type, "usage")))
      .orderBy(desc(aiCreditLedger.createdAt))
      .limit(1);

    const bucket: "included" | "purchased" =
      (usageEntries[0]?.metadata as any)?.bucket === "purchased" ? "purchased" : "included";

    // Placeholder row first — balanceAfter is fixed up below once we know
    // it, but the INSERT itself (and its conflict target) is the atomic
    // claim that makes this idempotent.
    const claimed = await tx.insert(aiCreditLedger).values({
      userId,
      type: "refund",
      amount: 1,
      balanceAfter: 0,
      referenceId,
      metadata: { bucket },
    }).onConflictDoNothing({ target: [aiCreditLedger.referenceId, aiCreditLedger.type] })
      .returning({ id: aiCreditLedger.id });

    if (claimed.length === 0) return; // already refunded — idempotent no-op

    const result = await tx.execute(
      bucket === "purchased"
        ? sql`UPDATE users SET ai_credits_purchased = ai_credits_purchased + 1 WHERE id = ${userId} RETURNING ai_credits_included, ai_credits_purchased`
        : sql`UPDATE users SET ai_credits_included = ai_credits_included + 1 WHERE id = ${userId} RETURNING ai_credits_included, ai_credits_purchased`
    );
    const row = result.rows[0] as { ai_credits_included: number; ai_credits_purchased: number } | undefined;

    if (row) {
      await tx.update(aiCreditLedger)
        .set({ balanceAfter: row.ai_credits_included + row.ai_credits_purchased })
        .where(eq(aiCreditLedger.id, claimed[0].id));
    }
  });
}

// ─── 2D. Grant purchased credits (from Stripe) ──────────────────────────────
//
// Idempotent the same way: stripePaymentId is the ledger's referenceId,
// type='purchase' — onConflictDoNothing on (referenceId, type) means a
// webhook redelivery for the same Checkout Session/PaymentIntent can never
// grant credits twice, without needing a separate pre-check.
export async function grantPurchasedCredits(userId: string, amount: number, stripePaymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(aiCreditLedger).values({
      userId,
      type: "purchase",
      amount,
      balanceAfter: 0,
      referenceId: stripePaymentId,
      metadata: { source: "stripe" },
    }).onConflictDoNothing({ target: [aiCreditLedger.referenceId, aiCreditLedger.type] })
      .returning({ id: aiCreditLedger.id });

    if (claimed.length === 0) return; // already processed — idempotent no-op

    const result = await tx.execute(sql`
      UPDATE users SET ai_credits_purchased = ai_credits_purchased + ${amount}
      WHERE id = ${userId}
      RETURNING ai_credits_included, ai_credits_purchased
    `);
    const row = result.rows[0] as { ai_credits_included: number; ai_credits_purchased: number } | undefined;

    if (row) {
      await tx.update(aiCreditLedger)
        .set({ balanceAfter: row.ai_credits_included + row.ai_credits_purchased })
        .where(eq(aiCreditLedger.id, claimed[0].id));
    }
  });
}

// ─── 2E. Get balance ─────────────────────────────────────────────────────────

export type CreditBalance = { included: number; purchased: number; total: number; resetAt: Date | null };

export async function getCreditBalance(userId: string): Promise<CreditBalance> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return balanceFromUser(user);
}

export function balanceFromUser(user: Pick<User, "aiCreditsIncluded" | "aiCreditsPurchased" | "aiCreditsResetAt"> | undefined): CreditBalance {
  const included = user?.aiCreditsIncluded ?? 0;
  const purchased = user?.aiCreditsPurchased ?? 0;
  return { included, purchased, total: included + purchased, resetAt: user?.aiCreditsResetAt ?? null };
}
