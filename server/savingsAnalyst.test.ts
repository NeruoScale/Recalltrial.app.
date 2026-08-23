import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  askSavingsAnalyst,
  buildAnalystContext,
  validateQuestion,
  createRateLimiter,
  isClaudeConfigured,
  AnalystUnavailableError,
  ANALYST_DISCLAIMER,
  type AnalystContext,
} from "./savingsAnalyst";
import type { SubscriptionWithCost, SubscriptionCostSummary, UpcomingCharge } from "./subscriptionCostEngine";
import type { ShadowSubscription } from "@shared/schema";
import type { SavingsAnalysis } from "./savingsIntelligence";
import type { PriceChangeResult } from "./priceChangeDetector";

// Phase 3C.3: this file covers everything the pure/testable surface of this
// module is responsible for — question validation, rate limiting, context
// assembly, and askSavingsAnalyst()'s own branching (empty-context
// shortcut, Claude-mocked success, Claude-failure -> AnalystUnavailableError).
// Cross-user isolation for the REAL feature is enforced entirely at the
// route layer (server/routes.ts's POST /api/subscriptions/analyst builds
// `context` from storage.getShadowSubscriptionsForUser(req.session.userId!)
// — this module never touches the DB and has no userId-scoped query to get
// wrong) — verified live against production, same as every other DB-layer
// guarantee in this codebase (no DB-integration test infra exists here; see
// server/aiCredits.test.ts's identical note).

let idCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  idCounter++;
  return {
    id: `sub-${idCounter}`,
    userId: "user-1",
    entityKey: "example.com",
    canonicalMerchantName: "Example",
    canonicalMerchantDomain: "example.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: "19.99",
    currency: "USD",
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    nextBillingDate: null,
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-1",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-19T00:00:00.000Z"),
    promotionReason: "domain_match_controlled_activation",
    promotionEvidence: "resolutionMethod=domain_match, merchantConfidence=90",
    lastPriceChangeAt: null,
    lastPriceChangeType: null,
    lastPriceChangeAbsolute: null,
    lastPriceChangePercentage: null,
    lastPriceChangeAnnualImpact: null,
    userConfirmed: false,
    userConfirmedAt: null,
    userDismissed: false,
    userDismissedAt: null,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

function withCost(sub: ShadowSubscription, monthlyCost: number | null, annualCost: number | null): SubscriptionWithCost {
  return { ...sub, monthlyCost, annualCost, costConfidence: "High" };
}

const emptySavingsAnalysis: SavingsAnalysis = {
  opportunities: [],
  summary: { totalOpportunities: 0, potentialMonthlySavings: null, potentialAnnualSavings: null, byCurrency: {}, incompleteCostCount: 0, confidence: "medium" },
};

const emptyCostSummary: SubscriptionCostSummary = {
  totalSubscriptions: 0,
  activeSubscriptions: 0,
  monthlyRecurringCost: null,
  annualRecurringCost: null,
  byCurrency: {},
  incompleteBillingCount: 0,
  unknownCostCount: 0,
};

function makeContext(overrides: Partial<AnalystContext> = {}): AnalystContext {
  return {
    subscriptions: [{ merchant: "Anthropic", amount: "20.00", currency: "USD", billingInterval: "monthly", status: "past_due", nextBillingDate: "2026-09-15", userConfirmed: false }],
    savingsOpportunities: [],
    summary: { totalSubscriptions: 1, monthlyRecurringCost: 20, annualRecurringCost: 240, byCurrency: { USD: { monthly: 20, annual: 240 } } },
    priceChanges: [],
    upcomingRenewals: [],
    ...overrides,
  };
}

describe("Phase 3C.3: validateQuestion()", () => {
  it("accepts a normal question", () => {
    expect(validateQuestion("How much am I spending monthly?")).toEqual({ valid: true });
  });

  it("rejects an empty question", () => {
    const result = validateQuestion("");
    expect(result.valid).toBe(false);
  });

  it("rejects a whitespace-only question", () => {
    expect(validateQuestion("   ").valid).toBe(false);
  });

  it("rejects a question over 500 characters", () => {
    expect(validateQuestion("a".repeat(501)).valid).toBe(false);
  });

  it("accepts a question at exactly 500 characters", () => {
    expect(validateQuestion("a".repeat(500)).valid).toBe(true);
  });

  it("rejects a non-string question", () => {
    expect(validateQuestion(undefined).valid).toBe(false);
    expect(validateQuestion(42).valid).toBe(false);
  });
});

describe("Phase 3C.3: rate limiter", () => {
  it("allows exactly 10 requests per user per hour, rejects the 11th", () => {
    const limiter = createRateLimiter();
    const now = new Date("2026-08-23T00:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      expect(limiter.checkAndRecord("user-1", now)).toBe(true);
    }
    expect(limiter.checkAndRecord("user-1", now)).toBe(false);
  });

  it("is per-user — a rate-limited user does not affect a different user", () => {
    const limiter = createRateLimiter();
    const now = new Date("2026-08-23T00:00:00.000Z");
    for (let i = 0; i < 10; i++) limiter.checkAndRecord("user-1", now);
    expect(limiter.checkAndRecord("user-1", now)).toBe(false);
    expect(limiter.checkAndRecord("user-2", now)).toBe(true);
  });

  it("allows requests again once the 1-hour window has passed", () => {
    const limiter = createRateLimiter();
    const t0 = new Date("2026-08-23T00:00:00.000Z");
    for (let i = 0; i < 10; i++) limiter.checkAndRecord("user-1", t0);
    expect(limiter.checkAndRecord("user-1", t0)).toBe(false);
    const oneHourLater = new Date(t0.getTime() + 60 * 60 * 1000 + 1);
    expect(limiter.checkAndRecord("user-1", oneHourLater)).toBe(true);
  });
});

describe("Phase 3C.3: buildAnalystContext()", () => {
  it("assembles context from already-computed pieces without recomputation", () => {
    const sub = makeSub({ canonicalMerchantName: "Anthropic", amount: "20.00", currency: "USD" });
    const context = buildAnalystContext({
      subscriptions: [withCost(sub, 20, 240)],
      savingsAnalysis: emptySavingsAnalysis,
      priceChangesBySubscriptionId: {},
      upcomingCharges: [],
      costSummary: { ...emptyCostSummary, totalSubscriptions: 1, monthlyRecurringCost: 20, annualRecurringCost: 240, byCurrency: { USD: { monthly: 20, annual: 240 } } },
    });
    expect(context.subscriptions).toEqual([
      { merchant: "Anthropic", amount: "20.00", currency: "USD", billingInterval: "monthly", status: "active", nextBillingDate: null, userConfirmed: false },
    ]);
    expect(context.summary.monthlyRecurringCost).toBe(20);
  });

  it("only includes a price change entry when one was actually detected (latestChange !== null)", () => {
    const sub = makeSub({ canonicalMerchantName: "Netflix" });
    const noChange: PriceChangeResult = { changes: [], hasIncrease: false, hasDecrease: false, hasCurrencyChange: false, hasIntervalChange: false, latestChange: null, totalAnnualImpact: null };
    const context = buildAnalystContext({
      subscriptions: [withCost(sub, 15, 180)],
      savingsAnalysis: emptySavingsAnalysis,
      priceChangesBySubscriptionId: { [sub.id]: noChange },
      upcomingCharges: [],
      costSummary: emptyCostSummary,
    });
    expect(context.priceChanges).toEqual([]);
  });

  it("NEVER includes a raw email field — output is limited to the whitelisted keys, no matter what's on the input types", () => {
    const sub = makeSub({ canonicalMerchantName: "Spotify" });
    const context = buildAnalystContext({
      subscriptions: [withCost(sub, 10, 120)],
      savingsAnalysis: emptySavingsAnalysis,
      priceChangesBySubscriptionId: {},
      upcomingCharges: [{ subscriptionId: sub.id, merchant: "Spotify", amount: "10.00", currency: "USD", dueDate: "2026-09-01", status: "active" }],
      costSummary: emptyCostSummary,
    });
    const serialized = JSON.stringify(context).toLowerCase();
    for (const forbidden of ["bodytext", "sourcemessageid", "subject", "snippet", "\"body\""]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("Phase 3C.3: isClaudeConfigured()", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { process.env.ANTHROPIC_API_KEY = originalKey; });

  it("is false when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isClaudeConfigured()).toBe(false);
  });

  it("is true when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(isClaudeConfigured()).toBe(true);
  });
});

describe("Phase 3C.3: askSavingsAnalyst()", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalKey;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchOnce(impl: () => Promise<Response> | Response) {
    global.fetch = vi.fn().mockImplementation(impl) as any;
  }

  it("returns Claude's answer verbatim, plus the disclaimer, for a valid question with context", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: "You're spending $20.00/month across 1 subscription." }],
      usage: { input_tokens: 300, output_tokens: 20 },
    }), { status: 200 }));

    const result = await askSavingsAnalyst("user-1", "How much am I spending monthly?", makeContext());
    expect(result.answer).toBe("You're spending $20.00/month across 1 subscription.");
    expect(result.disclaimer).toBe(ANALYST_DISCLAIMER);
  });

  it("with no subscriptions in context, returns a deterministic answer WITHOUT calling Claude at all", async () => {
    mockFetchOnce(() => { throw new Error("should not be called"); });
    const result = await askSavingsAnalyst("user-1", "What am I paying for?", makeContext({ subscriptions: [] }));
    expect(result.answer).toContain("don't have any subscription data");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("the disclaimer is present on every response, including the no-subscriptions shortcut", async () => {
    const result = await askSavingsAnalyst("user-1", "q", makeContext({ subscriptions: [] }));
    expect(result.disclaimer).toBe(ANALYST_DISCLAIMER);
  });

  it("never invents content beyond what Claude returned — the answer is passed through unmodified, not augmented", async () => {
    const claudeText = "Anthropic is $20.00/month, your only tracked subscription.";
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: claudeText }],
      usage: { input_tokens: 200, output_tokens: 15 },
    }), { status: 200 }));
    const result = await askSavingsAnalyst("user-1", "What am I paying for?", makeContext());
    expect(result.answer).toBe(claudeText);
  });

  it("ANTHROPIC_API_KEY not set -> rejects with AnalystUnavailableError, a graceful typed error, never an uncaught crash", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(askSavingsAnalyst("user-1", "How much am I spending?", makeContext())).rejects.toBeInstanceOf(AnalystUnavailableError);
  });

  it("a Claude timeout also surfaces as AnalystUnavailableError, not a raw AITimeoutError", async () => {
    mockFetchOnce(() => {
      const err: any = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(askSavingsAnalyst("user-1", "q", makeContext())).rejects.toBeInstanceOf(AnalystUnavailableError);
  });

  it("a Claude 429 also surfaces as AnalystUnavailableError", async () => {
    mockFetchOnce(async () => new Response("{}", { status: 429 }));
    await expect(askSavingsAnalyst("user-1", "q", makeContext())).rejects.toBeInstanceOf(AnalystUnavailableError);
  });

  it("PRIVACY: the question and answer text are never logged — only counts/user id, matching aiEnrichment.ts's discipline", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => { logs.push(String(msg)); });
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: "SECRET_ANSWER_MARKER_x91" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));
    await askSavingsAnalyst("user-1", "SECRET_QUESTION_MARKER_y42", makeContext());
    for (const line of logs) {
      expect(line).not.toContain("SECRET_ANSWER_MARKER_x91");
      expect(line).not.toContain("SECRET_QUESTION_MARKER_y42");
    }
  });
});
