// ─── AI Savings Analyst — Claude Haiku, structured-data-only Q&A (Phase 3C.3) ──
//
// Architecture: subscription data (structured) -> user question -> Claude
// Haiku (given ONLY the structured context below, never a raw email) ->
// natural-language answer -> displayed to the user, never persisted.
//
// This is a DIFFERENT Claude integration path from server/aiEnrichment.ts's
// (Phase 3B.9.9) extraction pipeline — deliberately so:
//   - aiEnrichment.ts reads raw email text and extracts structured facts,
//     consumes AI credits, and writes results back to subscription_events.
//   - This module reads ALREADY-structured facts (subscriptions, savings
//     opportunities, price changes, renewals — all pure data this app has
//     already computed), never touches a raw email body/subject, never
//     consumes AI credits, and never writes anything back to the DB. The
//     answer is ephemeral — shown once, never saved.
// Reusing callClaudeHaiku() would conflate these two concerns (its request/
// response shape is JSON-schema-bound to AIEnrichmentSchema, not free-text
// Q&A), so this module makes its own minimal Claude call instead, reusing
// only the error-classification types aiEnrichment.ts already defines.

import { AIProviderError, AITimeoutError, AIRateLimitError } from "./aiEnrichment";
import type { SubscriptionWithCost, SubscriptionCostSummary, UpcomingCharge } from "./subscriptionCostEngine";
import type { SavingsAnalysis } from "./savingsIntelligence";
import type { PriceChangeResult } from "./priceChangeDetector";

// ─── Context (structured data only — see buildAnalystContext()'s own note
// on why this can never carry a raw email field) ────────────────────────────

export type AnalystContext = {
  subscriptions: {
    merchant: string;
    amount: string | null;
    currency: string | null;
    billingInterval: string | null;
    status: string;
    nextBillingDate: string | null;
    userConfirmed: boolean;
  }[];
  savingsOpportunities: {
    merchant: string;
    score: number;
    classification: string;
    annualCost: number | null;
    reasons: string[];
  }[];
  summary: {
    totalSubscriptions: number;
    monthlyRecurringCost: number | null;
    annualRecurringCost: number | null;
    byCurrency: Record<string, { monthly: number; annual: number }>;
  };
  priceChanges: {
    merchant: string;
    previousAmount: string;
    newAmount: string;
    percentageChange: number;
    changeType: string;
  }[];
  upcomingRenewals: {
    merchant: string;
    dueDate: string;
    amount: string | null;
    currency: string | null;
  }[];
};

export type AnalystResponse = {
  answer: string;
  disclaimer: string;
};

export const ANALYST_DISCLAIMER =
  "RecallTrial's AI analyst uses email-detected subscription data which may be incomplete.";

/**
 * buildAnalystContext(): pure assembly from data this app has ALREADY
 * computed elsewhere (server/subscriptionCostEngine.ts's cost/upcoming-charge
 * engine, server/savingsIntelligence.ts's opportunity scoring, server/
 * priceChangeDetector.ts's change detection) — no DB access, no recomputation
 * of any of it, and structurally incapable of carrying a raw email field:
 * every output field is a plain string/number/boolean picked from types
 * (SubscriptionWithCost, SavingsOpportunity, PriceChangeResult, UpcomingCharge)
 * that don't have a body/subject/snippet field to begin with.
 */
export function buildAnalystContext(params: {
  subscriptions: SubscriptionWithCost[];
  savingsAnalysis: SavingsAnalysis;
  priceChangesBySubscriptionId: Record<string, PriceChangeResult>;
  upcomingCharges: UpcomingCharge[];
  costSummary: SubscriptionCostSummary;
}): AnalystContext {
  const { subscriptions, savingsAnalysis, priceChangesBySubscriptionId, upcomingCharges, costSummary } = params;
  const merchantById = new Map(subscriptions.map((s) => [s.id, s.canonicalMerchantName]));

  return {
    subscriptions: subscriptions.map((s) => ({
      merchant: s.canonicalMerchantName,
      amount: s.amount,
      currency: s.currency,
      billingInterval: s.billingInterval,
      status: s.subscriptionStatus,
      nextBillingDate: s.nextBillingDate,
      userConfirmed: s.userConfirmed,
    })),
    savingsOpportunities: savingsAnalysis.opportunities.map((o) => ({
      merchant: o.merchant,
      score: o.score,
      classification: o.classification,
      annualCost: o.annualCost,
      reasons: o.reasons,
    })),
    summary: {
      totalSubscriptions: costSummary.totalSubscriptions,
      monthlyRecurringCost: costSummary.monthlyRecurringCost,
      annualRecurringCost: costSummary.annualRecurringCost,
      byCurrency: costSummary.byCurrency,
    },
    priceChanges: Object.entries(priceChangesBySubscriptionId)
      .filter(([, result]) => result.latestChange !== null)
      .map(([subscriptionId, result]) => {
        const change = result.latestChange!;
        return {
          merchant: merchantById.get(subscriptionId) ?? "Unknown",
          previousAmount: change.previousAmount,
          newAmount: change.newAmount,
          percentageChange: change.percentageChange,
          changeType: change.changeType,
        };
      }),
    upcomingRenewals: upcomingCharges.map((c) => ({
      merchant: c.merchant,
      dueDate: c.dueDate,
      amount: c.amount,
      currency: c.currency,
    })),
  };
}

// ─── Question validation (pure) ─────────────────────────────────────────────

const MAX_QUESTION_CHARS = 500;

export function validateQuestion(question: unknown): { valid: true } | { valid: false; error: string } {
  if (typeof question !== "string" || question.trim().length === 0) {
    return { valid: false, error: "Question cannot be empty" };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return { valid: false, error: `Question must be ${MAX_QUESTION_CHARS} characters or fewer` };
  }
  return { valid: true };
}

// ─── Rate limiting (pure, in-memory) ────────────────────────────────────────
//
// "simple in-memory... counter" per spec — resets on process restart, which
// is an acceptable tradeoff for an abuse guard on a low-volume feature (not
// a billing-accuracy guarantee, unlike server/aiCredits.ts's DB-backed
// ledger). Keyed by userId, sliding 1-hour window.

const RATE_LIMIT_MAX_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type RateLimiter = {
  /** Returns true if the request is allowed (and records it); false if the caller is over the limit. */
  checkAndRecord(userId: string, now?: Date): boolean;
};

export function createRateLimiter(): RateLimiter {
  const requestTimestampsByUser = new Map<string, number[]>();
  return {
    checkAndRecord(userId: string, now: Date = new Date()): boolean {
      const nowMs = now.getTime();
      const recent = (requestTimestampsByUser.get(userId) ?? []).filter((t) => nowMs - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length >= RATE_LIMIT_MAX_PER_HOUR) {
        requestTimestampsByUser.set(userId, recent);
        return false;
      }
      recent.push(nowMs);
      requestTimestampsByUser.set(userId, recent);
      return true;
    },
  };
}

// Single shared instance the route imports — request volume for this
// feature doesn't warrant per-request instantiation, and a module-level
// singleton is what makes "10 per user per hour" actually mean something
// across requests.
export const savingsAnalystRateLimiter = createRateLimiter();

// ─── Claude call (free-text Q&A, not the JSON-schema extraction path) ──────

const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_MAX_OUTPUT_TOKENS = 500;
const CLAUDE_TIMEOUT_MS = 30_000;
// Soft budget for (system prompt + context JSON + question). No tokenizer is
// available here, so this is an approximate 4-chars-per-token estimate — the
// same order-of-magnitude approximation server/aiEnrichment.ts's
// MAX_AI_BODY_CHARS uses for the same reason. Caps array sizes rather than
// truncating the JSON string itself, so the context Claude sees always stays
// syntactically well-formed.
const MAX_CONTEXT_ITEMS_PER_ARRAY = 20;

export const ANALYST_SYSTEM_PROMPT =
  "You are RecallTrial's subscription analyst. Answer questions about the user's subscriptions using ONLY the structured data provided. \n" +
  "Rules:\n" +
  "- Only reference merchants, amounts, and dates that appear in the provided data\n" +
  "- Never invent subscription facts\n" +
  "- Never claim guaranteed savings — always say 'potential savings'\n" +
  "- Never say a subscription is 'unused' — say 'limited usage evidence detected'\n" +
  "- If asked about something not in the data, say 'I don't have that information yet'\n" +
  "- Keep answers concise and factual\n" +
  "- Format amounts with currency symbols\n" +
  "- Do not recommend specific actions beyond 'worth reviewing'";

export function isClaudeConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function capContext(context: AnalystContext): AnalystContext {
  return {
    subscriptions: context.subscriptions.slice(0, MAX_CONTEXT_ITEMS_PER_ARRAY),
    savingsOpportunities: context.savingsOpportunities.slice(0, MAX_CONTEXT_ITEMS_PER_ARRAY),
    summary: context.summary,
    priceChanges: context.priceChanges.slice(0, MAX_CONTEXT_ITEMS_PER_ARRAY),
    upcomingRenewals: context.upcomingRenewals.slice(0, MAX_CONTEXT_ITEMS_PER_ARRAY),
  };
}

async function callClaudeForAnalyst(userMessage: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIProviderError("ANTHROPIC_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_OUTPUT_TOKENS,
        system: ANALYST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new AITimeoutError();
    throw new AIProviderError(err?.message ?? "network error calling Claude");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) throw new AIRateLimitError();
  if (!response.ok) {
    throw new AIProviderError(`Claude API returned ${response.status}`);
  }

  const data: any = await response.json();
  const usage = data?.usage ?? {};
  const text: string = data?.content?.[0]?.text ?? "";
  if (!text.trim()) {
    throw new AIProviderError("Claude returned an empty response");
  }

  return {
    text: text.trim(),
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

/** Thrown for every Claude-layer failure (missing key, timeout, rate limit, empty response) — a single, uniformly "graceful" outward-facing error the route maps to 503, never a 500 crash. */
export class AnalystUnavailableError extends Error {
  constructor(message = "AI analyst temporarily unavailable.") {
    super(message);
    this.name = "AnalystUnavailableError";
  }
}

/**
 * askSavingsAnalyst(): the whole feature in one call. `userId` is never used
 * to read anything here (the caller already scoped `context` to one user
 * before calling this) — it exists only so the log line below can record
 * which user asked, without ever logging the question text or the answer
 * itself, matching aiEnrichment.ts's "counts/metadata only" logging
 * discipline.
 *
 * Deliberately short-circuits (no Claude call at all) when there is no
 * subscription data — nothing for the model to reason about, and a
 * deterministic "I don't have that information yet"-style answer is more
 * honest than letting a model improvise over an empty context.
 */
export async function askSavingsAnalyst(userId: string, question: string, context: AnalystContext): Promise<AnalystResponse> {
  if (context.subscriptions.length === 0) {
    return {
      answer: "I don't have any subscription data for your account yet.",
      disclaimer: ANALYST_DISCLAIMER,
    };
  }

  const cappedContext = capContext(context);
  const userMessage = `Subscription data (JSON):\n${JSON.stringify(cappedContext)}\n\nQuestion: ${question}`;

  try {
    const { text } = await callClaudeForAnalyst(userMessage);
    console.log(`[SavingsAnalyst] answered a question for user ${userId}`);
    return { answer: text, disclaimer: ANALYST_DISCLAIMER };
  } catch (err) {
    console.error(`[SavingsAnalyst] Claude call failed for user ${userId}: ${err instanceof Error ? err.name : "unknown error"}`);
    throw new AnalystUnavailableError();
  }
}
