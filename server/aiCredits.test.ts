import { describe, it, expect, vi } from "vitest";

// This file only tests the pure exports (creditsForPlan, isMonthlyGrantDue,
// decideCreditBucket, balanceFromUser) — but aiCredits.ts's top-level
// imports pull in server/db.ts (throws at import time without a live
// DATABASE_URL) and @shared/schema's VALUE exports (users, aiCreditLedger
// table objects, which need real module resolution vitest's config
// doesn't provide — type-only imports are erased and don't hit this, but
// value imports do). Both are mocked away at the module boundary, the same
// pattern server/backfillBodyExtraction.test.ts and
// server/aiEnrichmentQueue.test.ts already use for the identical reason.
//
// Everything else in this module — grantMonthlyCredits, reserveCredit,
// refundCredit, grantPurchasedCredits, getCreditBalance — is fundamentally
// a DB-atomicity/idempotency guarantee (row-level locking under
// concurrency, UNIQUE-constraint-based onConflictDoNothing) that cannot be
// honestly verified against a mock; this codebase has no DB-integration
// test infrastructure anywhere (every existing *.test.ts file tests a pure
// function only). Those guarantees were verified live against the real
// production database instead, the same way every other DB-layer
// guarantee in this feature line has been (Phase 3B.9.6A's subscriptionId
// backfill, Phase 3B.9.7-PATCH's source-aware conflict resolution, Phase
// 3B.9.9's job-claiming logic) — see the Phase 3B.9.10 deployment report
// for the live reservation/refund/idempotency/cross-user results.
vi.mock("./db", () => ({ db: {} }));
vi.mock("@shared/schema", () => ({ users: {}, aiCreditLedger: {} }));

import { creditsForPlan, isMonthlyGrantDue, decideCreditBucket, balanceFromUser } from "./aiCredits";

describe("Phase 3B.9.10: creditsForPlan()", () => {
  it("Free gets 0 credits", () => {
    expect(creditsForPlan("FREE")).toBe(0);
  });

  it("Plus gets 100 credits", () => {
    expect(creditsForPlan("PLUS")).toBe(100);
  });

  it("Pro gets 200 credits", () => {
    expect(creditsForPlan("PRO")).toBe(200);
  });

  it("Premium is treated as Pro-tier (200) rather than silently getting 0", () => {
    expect(creditsForPlan("PREMIUM")).toBe(200);
  });

  it("an unrecognized plan string defaults to 0, never a guess", () => {
    expect(creditsForPlan("SOMETHING_NEW")).toBe(0);
  });
});

describe("Phase 3B.9.10: isMonthlyGrantDue()", () => {
  it("null (never granted) is always due", () => {
    expect(isMonthlyGrantDue(null)).toBe(true);
  });

  it("is NOT due before 30 days have elapsed", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const resetAt = new Date("2026-01-15T00:00:00Z"); // 17 days ago
    expect(isMonthlyGrantDue(resetAt, now)).toBe(false);
  });

  it("is due once 30+ days have elapsed", () => {
    const now = new Date("2026-02-15T00:00:00Z");
    const resetAt = new Date("2026-01-15T00:00:00Z"); // exactly 31 days ago
    expect(isMonthlyGrantDue(resetAt, now)).toBe(true);
  });

  it("is due at exactly 30 days (boundary, inclusive)", () => {
    const resetAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(isMonthlyGrantDue(resetAt, now)).toBe(true);
  });

  it("is not due one millisecond before the 30-day mark", () => {
    const resetAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000 - 1);
    expect(isMonthlyGrantDue(resetAt, now)).toBe(false);
  });
});

describe("Phase 3B.9.10: decideCreditBucket() — pure mirror of reserveCredit()'s SQL preference order", () => {
  it("consumes included before purchased when both are available", () => {
    expect(decideCreditBucket(5, 10)).toBe("included");
  });

  it("falls back to purchased when included is exhausted", () => {
    expect(decideCreditBucket(0, 10)).toBe("purchased");
  });

  it("returns null when both balances are exhausted (the no_credits case)", () => {
    expect(decideCreditBucket(0, 0)).toBe(null);
  });

  it("never treats a negative balance as available", () => {
    expect(decideCreditBucket(-1, 5)).toBe("purchased");
    expect(decideCreditBucket(-1, -1)).toBe(null);
  });
});

describe("Phase 3B.9.10: balanceFromUser()", () => {
  it("returns the correct included/purchased/total split", () => {
    const balance = balanceFromUser({ aiCreditsIncluded: 40, aiCreditsPurchased: 1000, aiCreditsResetAt: null } as any);
    expect(balance).toEqual({ included: 40, purchased: 1000, total: 1040, resetAt: null });
  });

  it("defaults to all-zero for an undefined user rather than throwing", () => {
    expect(balanceFromUser(undefined)).toEqual({ included: 0, purchased: 0, total: 0, resetAt: null });
  });

  it("purchased credits are counted in the total independently of included — never expire on their own", () => {
    const balance = balanceFromUser({ aiCreditsIncluded: 0, aiCreditsPurchased: 250, aiCreditsResetAt: new Date("2026-01-01") } as any);
    expect(balance.purchased).toBe(250);
    expect(balance.total).toBe(250);
  });
});
