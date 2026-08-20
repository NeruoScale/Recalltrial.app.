import { describe, it, expect, vi } from "vitest";

// This file only tests the pure exports (planFieldUpdatesFromBody,
// needsBodyFetch) — but backfillBodyExtraction.ts's top-level imports pull
// in server/db.ts (which throws at import time without a live
// DATABASE_URL) and server/gmail.ts (which imports googleapis). Neither the
// DB pool nor the Gmail SDK is ever exercised by the tests below, so both
// are mocked away at the module boundary, matching the same pattern
// server/gmail.test.ts already uses for "./storage".
vi.mock("./db", () => ({ db: {} }));
vi.mock("./storage", () => ({ storage: {} }));
vi.mock("@shared/schema", () => ({ subscriptionEvents: {}, users: {} }));
vi.mock("./gmail", () => ({
  buildGmailClient: vi.fn(),
  fetchMessageBody: vi.fn(),
  extractAmount: vi.fn(),
  extractBillingInterval: vi.fn(),
  extractDate: vi.fn(),
}));

import { planFieldUpdatesFromBody, needsBodyFetch, type ExistingEventFields, type BodyExtractionResult } from "./backfillBodyExtraction";

// Phase 3B.9.7-PATCH: planFieldUpdatesFromBody() and needsBodyFetch() are
// the pure decision logic backfillCanonicalEventBodies() is built on — same
// "pure mirror, fully unit-tested; the DB/network orchestration around it
// is verified live against production" split established by
// server/subscriptionIdBackfill.ts (Phase 3B.9.6A) and reused throughout
// this feature line, since this codebase has no DB-integration test
// infrastructure. Cross-user isolation and dryRun=true's "no DB write"
// guarantee are both structural properties of backfillCanonicalEventBodies()
// itself (scoped WHERE clause; db.update() only called when !dryRun) —
// verified live during the production dry-run/backfill run rather than
// re-implemented here as a DB mock.

function makeExisting(overrides: Partial<ExistingEventFields> = {}): ExistingEventFields {
  return {
    extractedPrice: null,
    extractedCurrency: null,
    amountSource: null,
    billingInterval: null,
    intervalSource: null,
    extractedDate: null,
    dateSource: null,
    ...overrides,
  };
}

function makeBody(overrides: Partial<BodyExtractionResult> = {}): BodyExtractionResult {
  return { amount: null, currency: "USD", interval: null, date: null, ...overrides };
}

describe("Phase 3B.9.7-PATCH: planFieldUpdatesFromBody()", () => {
  it("higher quality source upgrades lower quality: body > snippet -> update", () => {
    const existing = makeExisting({ extractedPrice: "9.99", extractedCurrency: "USD", amountSource: "snippet" });
    const body = makeBody({ amount: "15.00", currency: "GBP" });
    const plan = planFieldUpdatesFromBody(existing, body);
    expect(plan.amountImproved).toBe(true);
    expect(plan.updates.extractedPrice).toBe("15.00");
    expect(plan.updates.extractedCurrency).toBe("GBP");
    expect(plan.updates.amountSource).toBe("body");
  });

  it("null source always upgrades: null -> body -> update", () => {
    const existing = makeExisting({ amountSource: null });
    const body = makeBody({ amount: "15.00", currency: "GBP" });
    const plan = planFieldUpdatesFromBody(existing, body);
    expect(plan.amountImproved).toBe(true);
    expect(plan.updates.amountSource).toBe("body");
  });

  it("same source updates when the value genuinely differs: body -> body (fresher data)", () => {
    const existing = makeExisting({ extractedPrice: "15.00", extractedCurrency: "GBP", amountSource: "body" });
    const body = makeBody({ amount: "18.00", currency: "GBP" }); // price changed since the last body fetch
    const plan = planFieldUpdatesFromBody(existing, body);
    expect(plan.amountImproved).toBe(true);
    expect(plan.updates.extractedPrice).toBe("18.00");
  });

  it("AI source is never downgraded by body data", () => {
    const existing = makeExisting({ extractedPrice: "15.00", extractedCurrency: "GBP", amountSource: "ai" });
    const body = makeBody({ amount: "999.00", currency: "USD" });
    const plan = planFieldUpdatesFromBody(existing, body);
    expect(plan.amountImproved).toBe(false);
    expect(plan.updates.extractedPrice).toBeUndefined();
  });

  it("fields are updated independently: amount improves without touching interval, and vice versa", () => {
    const existing = makeExisting({ amountSource: "body", extractedPrice: "15.00", extractedCurrency: "GBP", intervalSource: "snippet", billingInterval: "annual" });
    const body = makeBody({ amount: "15.00", currency: "GBP", interval: "monthly" }); // amount unchanged, interval upgraded
    const plan = planFieldUpdatesFromBody(existing, body);
    expect(plan.amountImproved).toBe(false);
    expect(plan.updates.extractedPrice).toBeUndefined();
    expect(plan.intervalImproved).toBe(true);
    expect(plan.updates.billingInterval).toBe("monthly");
  });

  it("idempotent: running the identical body extraction twice only improves on the first pass", () => {
    const initial = makeExisting();
    const body = makeBody({ amount: "15.00", currency: "GBP", interval: "monthly", date: "2026-09-01" });

    const firstPass = planFieldUpdatesFromBody(initial, body);
    expect(firstPass.amountImproved).toBe(true);
    expect(firstPass.intervalImproved).toBe(true);
    expect(firstPass.dateImproved).toBe(true);

    // Simulate the DB row after the first pass's updates were applied.
    const afterFirstPass: ExistingEventFields = {
      extractedPrice: firstPass.updates.extractedPrice!,
      extractedCurrency: firstPass.updates.extractedCurrency!,
      amountSource: firstPass.updates.amountSource!,
      billingInterval: firstPass.updates.billingInterval!,
      intervalSource: firstPass.updates.intervalSource!,
      extractedDate: firstPass.updates.extractedDate!,
      dateSource: firstPass.updates.dateSource!,
    };

    const secondPass = planFieldUpdatesFromBody(afterFirstPass, body);
    expect(secondPass.amountImproved).toBe(false);
    expect(secondPass.intervalImproved).toBe(false);
    expect(secondPass.dateImproved).toBe(false);
    expect(secondPass.updates).toEqual({});
  });

  it("does not fabricate a value the body doesn't actually have (null stays null, nothing improved)", () => {
    const existing = makeExisting();
    const plan = planFieldUpdatesFromBody(existing, makeBody());
    expect(plan.amountImproved).toBe(false);
    expect(plan.intervalImproved).toBe(false);
    expect(plan.dateImproved).toBe(false);
    expect(plan.updates).toEqual({});
  });
});

describe("Phase 3B.9.7-PATCH: needsBodyFetch()", () => {
  it("lower quality source does not downgrade / needs no fetch when already better: existing body-tier data does not request another fetch on its own", () => {
    // All three fields already at body tier -> nothing left for a body fetch to add.
    expect(needsBodyFetch(makeExisting({ amountSource: "body", intervalSource: "body", dateSource: "body" }))).toBe(false);
  });

  it("an ai-tier field also counts as already at/above body quality", () => {
    expect(needsBodyFetch(makeExisting({ amountSource: "ai", intervalSource: "ai", dateSource: "ai" }))).toBe(false);
  });

  it("needs a fetch when ANY field is still below body tier", () => {
    expect(needsBodyFetch(makeExisting({ amountSource: "body", intervalSource: "snippet", dateSource: "body" }))).toBe(true);
    expect(needsBodyFetch(makeExisting({ amountSource: null, intervalSource: "ai", dateSource: "ai" }))).toBe(true);
  });

  it("a brand-new event with no source data anywhere needs a fetch", () => {
    expect(needsBodyFetch(makeExisting())).toBe(true);
  });
});
