import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isEligibleForAI,
  buildAIPayload,
  AIEnrichmentSchema,
  applyAIEnrichment,
  callClaudeHaiku,
  AITimeoutError,
  AIRateLimitError,
  AISchemaValidationError,
  AIProviderError,
  type ApplicableEventFields,
} from "./aiEnrichment";

// ─── 2A. isEligibleForAI() ───────────────────────────────────────────────────

function makeEligibleEvent(overrides: Partial<Parameters<typeof isEligibleForAI>[0]> = {}) {
  return {
    isCanonical: true,
    bodyFetched: true,
    extractedPrice: null,
    extractedCurrency: null,
    billingInterval: null,
    eventType: "subscription_invoice",
    ...overrides,
  };
}

describe("Phase 3B.9.9: isEligibleForAI()", () => {
  it("true when all conditions are met", () => {
    expect(isEligibleForAI(makeEligibleEvent(), { aiScanningEnabled: true })).toBe(true);
  });

  it("false when aiScanningEnabled=false", () => {
    expect(isEligibleForAI(makeEligibleEvent(), { aiScanningEnabled: false })).toBe(false);
  });

  it("false when bodyFetched=false", () => {
    expect(isEligibleForAI(makeEligibleEvent({ bodyFetched: false }), { aiScanningEnabled: true })).toBe(false);
  });

  it("false when isCanonical=false (superseded event)", () => {
    expect(isEligibleForAI(makeEligibleEvent({ isCanonical: false }), { aiScanningEnabled: true })).toBe(false);
  });

  it("false when all key fields are already known (nothing for AI to add)", () => {
    const event = makeEligibleEvent({ extractedPrice: "9.99", extractedCurrency: "USD", billingInterval: "monthly" });
    expect(isEligibleForAI(event, { aiScanningEnabled: true })).toBe(false);
  });

  it("false for one_time_purchase, even with a gap and AI enabled", () => {
    const event = makeEligibleEvent({ eventType: "one_time_purchase" });
    expect(isEligibleForAI(event, { aiScanningEnabled: true })).toBe(false);
  });

  it("true when only billingInterval is missing (price/currency both known)", () => {
    const event = makeEligibleEvent({ extractedPrice: "9.99", extractedCurrency: "USD", billingInterval: null });
    expect(isEligibleForAI(event, { aiScanningEnabled: true })).toBe(true);
  });
});

// ─── 2B. buildAIPayload() ─────────────────────────────────────────────────────

describe("Phase 3B.9.9: buildAIPayload()", () => {
  it("truncates body to MAX 4000 chars", () => {
    const longBody = "A".repeat(9000);
    const payload = buildAIPayload({ subject: "s", from: "f", date: "d", bodyText: longBody });
    expect(payload.bodyText.length).toBe(4000);
  });

  it("never includes userId or internal IDs — only subject/from/date/bodyText survive", () => {
    const payload = buildAIPayload({ subject: "Your receipt", from: "billing@x.com", date: "Mon, 01 Jan 2026", bodyText: "hi" });
    expect(Object.keys(payload).sort()).toEqual(["bodyText", "date", "from", "subject"]);
    expect(JSON.stringify(payload)).not.toMatch(/userId|subscriptionId|sourceMessageId|accessToken|refreshToken/i);
  });

  it("passes subject/from/date through unmodified", () => {
    const payload = buildAIPayload({ subject: "Your Anthropic receipt", from: "billing@anthropic.com", date: "Mon, 01 Jan 2026", bodyText: "short body" });
    expect(payload.subject).toBe("Your Anthropic receipt");
    expect(payload.from).toBe("billing@anthropic.com");
    expect(payload.date).toBe("Mon, 01 Jan 2026");
    expect(payload.bodyText).toBe("short body");
  });
});

// ─── 2C. AIEnrichmentSchema ───────────────────────────────────────────────────

function validAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    merchantName: "Anthropic",
    amount: 15.0,
    currency: "GBP",
    billingInterval: "monthly",
    nextBillingDate: "2026-09-01",
    subscriptionId: null,
    cancellationUrl: null,
    eventType: "subscription_invoice",
    confidence: 0.9,
    ...overrides,
  };
}

describe("Phase 3B.9.9: AIEnrichmentSchema", () => {
  it("accepts a valid response", () => {
    expect(AIEnrichmentSchema.safeParse(validAIResponse()).success).toBe(true);
  });

  it("rejects an invalid eventType", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ eventType: "made_up_event_type" }));
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ confidence: 1.5 }));
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ confidence: -0.1 }));
    expect(result.success).toBe(false);
  });

  it("rejects an invalid URL in cancellationUrl", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ cancellationUrl: "not-a-url" }));
    expect(result.success).toBe(false);
  });

  it("accepts a null cancellationUrl", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ cancellationUrl: null }));
    expect(result.success).toBe(true);
  });

  it("rejects an invalid billingInterval", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ billingInterval: "fortnightly" }));
    expect(result.success).toBe(false);
  });

  it("rejects a currency longer than 3 characters", () => {
    const result = AIEnrichmentSchema.safeParse(validAIResponse({ currency: "DOLLARS" }));
    expect(result.success).toBe(false);
  });
});

// ─── 2E. applyAIEnrichment() ───────────────────────────────────────────────────

function makeApplicableEvent(overrides: Partial<ApplicableEventFields> = {}): ApplicableEventFields {
  return {
    extractedPrice: null,
    extractedCurrency: null,
    amountSource: null,
    billingInterval: null,
    intervalSource: null,
    ...overrides,
  };
}

describe("Phase 3B.9.9: applyAIEnrichment()", () => {
  it("AI amount accepted when extractedPrice=null", () => {
    const event = makeApplicableEvent({ amountSource: null });
    const updates = applyAIEnrichment(event, validAIResponse() as any);
    expect(updates.extractedPrice).toBe("15.00");
    expect(updates.extractedCurrency).toBe("GBP");
  });

  it("AI amount rejected when body amount already known (CRITICAL BOUNDARY: never replace body evidence)", () => {
    const event = makeApplicableEvent({ extractedPrice: "20.00", extractedCurrency: "USD", amountSource: "body" });
    const updates = applyAIEnrichment(event, validAIResponse({ amount: 999, currency: "EUR" }) as any);
    expect(updates.extractedPrice).toBeUndefined();
    expect(updates.extractedCurrency).toBeUndefined();
    expect(updates.amountSource).toBeUndefined();
  });

  it("AI amount rejected when existing source is already 'ai' (no re-derivation)", () => {
    const event = makeApplicableEvent({ extractedPrice: "20.00", extractedCurrency: "USD", amountSource: "ai" });
    const updates = applyAIEnrichment(event, validAIResponse({ amount: 999, currency: "EUR" }) as any);
    expect(updates.extractedPrice).toBeUndefined();
  });

  it("AI amount accepted when existing source is 'snippet' (below body tier)", () => {
    const event = makeApplicableEvent({ extractedPrice: "9.99", extractedCurrency: "USD", amountSource: "snippet" });
    const updates = applyAIEnrichment(event, validAIResponse({ amount: 15, currency: "GBP" }) as any);
    expect(updates.extractedPrice).toBe("15.00");
  });

  it("sets amountSource='ai' correctly", () => {
    const event = makeApplicableEvent();
    const updates = applyAIEnrichment(event, validAIResponse() as any);
    expect(updates.amountSource).toBe("ai");
  });

  it("sets intervalSource='ai' correctly, independent of the amount field", () => {
    const event = makeApplicableEvent({ extractedPrice: "20.00", extractedCurrency: "USD", amountSource: "body", billingInterval: null, intervalSource: null });
    const updates = applyAIEnrichment(event, validAIResponse({ billingInterval: "monthly" }) as any);
    expect(updates.billingInterval).toBe("monthly");
    expect(updates.intervalSource).toBe("ai");
    // Amount stayed body-sourced and untouched.
    expect(updates.extractedPrice).toBeUndefined();
  });

  it("does not apply billingInterval='unknown' or 'one_time' (not real intervals)", () => {
    const event = makeApplicableEvent();
    expect(applyAIEnrichment(event, validAIResponse({ billingInterval: "unknown" }) as any).billingInterval).toBeUndefined();
    expect(applyAIEnrichment(event, validAIResponse({ billingInterval: "one_time" }) as any).billingInterval).toBeUndefined();
  });

  it("never fabricates an amount when AI itself returns null", () => {
    const event = makeApplicableEvent();
    const updates = applyAIEnrichment(event, validAIResponse({ amount: null, currency: null }) as any);
    expect(updates.extractedPrice).toBeUndefined();
  });
});

// ─── 2D. callClaudeHaiku() ─────────────────────────────────────────────────────

const SECRET_BODY_MARKER = "SECRET_BODY_CONTENT_9f3a1c";

describe("Phase 3B.9.9: callClaudeHaiku()", () => {
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

  it("parses a valid Claude response and returns token counts", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: JSON.stringify(validAIResponse()) }],
      usage: { input_tokens: 512, output_tokens: 64 },
    }), { status: 200 }));

    const { result, inputTokens, outputTokens } = await callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: SECRET_BODY_MARKER });
    expect(result.merchantName).toBe("Anthropic");
    expect(inputTokens).toBe(512);
    expect(outputTokens).toBe(64);
  });

  it("strips a fenced code block before parsing", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: "```json\n" + JSON.stringify(validAIResponse()) + "\n```" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200 }));

    const { result } = await callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" });
    expect(result.eventType).toBe("subscription_invoice");
  });

  it("throws AIRateLimitError on 429", async () => {
    mockFetchOnce(async () => new Response("{}", { status: 429 }));
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AIRateLimitError);
  });

  it("throws AITimeoutError when the request aborts", async () => {
    mockFetchOnce(() => {
      const err: any = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AITimeoutError);
  });

  it("throws AIProviderError on a 500", async () => {
    mockFetchOnce(async () => new Response("{}", { status: 500 }));
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AIProviderError);
  });

  it("throws AIProviderError when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AIProviderError);
  });

  it("throws AISchemaValidationError when Claude's JSON doesn't match the schema (not retried)", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: JSON.stringify({ merchantName: "X" }) }], // missing every other required field
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AISchemaValidationError);
  });

  it("throws AISchemaValidationError when Claude's response is not valid JSON at all", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: "not json at all" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));
    await expect(callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: "x" })).rejects.toBeInstanceOf(AISchemaValidationError);
  });

  it("PRIVACY: the raw body never appears in any thrown error's message, across every error path", async () => {
    const attempts: Array<() => Promise<Response> | Response> = [
      () => new Response("{}", { status: 429 }),
      () => new Response("{}", { status: 500 }),
      () => new Response(JSON.stringify({ content: [{ text: "not json" }], usage: {} }), { status: 200 }),
      () => new Response(JSON.stringify({ content: [{ text: JSON.stringify({ bad: "shape" }) }], usage: {} }), { status: 200 }),
    ];
    for (const impl of attempts) {
      mockFetchOnce(async () => impl());
      try {
        await callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: SECRET_BODY_MARKER });
      } catch (err: any) {
        expect(err.message).not.toContain(SECRET_BODY_MARKER);
        expect(String(err.stack ?? "")).not.toContain(SECRET_BODY_MARKER);
      }
    }
  });

  it("PRIVACY: never logs the request body via console.log/console.error", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchOnce(async () => new Response(JSON.stringify({
      content: [{ text: JSON.stringify(validAIResponse()) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }));

    await callClaudeHaiku({ subject: "s", from: "f", date: "d", bodyText: SECRET_BODY_MARKER });

    const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
    expect(allCalls).not.toContain(SECRET_BODY_MARKER);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ─── API key never reaches client-side code ────────────────────────────────────

describe("Phase 3B.9.9: ANTHROPIC_API_KEY never reaches the client bundle", () => {
  it("no file under client/src references ANTHROPIC_API_KEY", () => {
    const clientSrcDir = path.resolve(__dirname, "..", "client", "src");
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const content = fs.readFileSync(full, "utf-8");
          if (content.includes("ANTHROPIC_API_KEY")) offenders.push(full);
        }
      }
    }

    walk(clientSrcDir);
    expect(offenders).toEqual([]);
  });
});
