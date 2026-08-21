// ─── AI enrichment — Claude Haiku (Phase 3B.9.9) ───────────────────────────────
//
// AI is a LAST-RESORT enrichment layer for the specific fields deterministic
// extraction (Layer 1 snippet + Layer 2 full body, Phase 3B.9.7) still
// couldn't resolve — it never creates a subscription, never reclassifies an
// event's eventType, never touches entity resolution/canonicalization/
// lifecycle/promotion, and never overwrites evidence a stronger layer
// already supplied. Matches PHASE1_AUDIT.md §6's architecture exactly:
// deterministic parser first, AI only for what's left ambiguous, and the
// product is 100% functional without AI ever running.
//
// PRIVACY: this module never logs a raw email body or a raw Claude response
// anywhere — see callClaudeHaiku()'s own note. The only things ever written
// to a log line are counts/tokens/confidence, matching Phase 3B.9.7's Layer
// 2 discipline exactly.

import { z } from "zod";
import type { SubscriptionEvent, User } from "@shared/schema";
import { sourcePrecedence } from "./sourcePrecedence";

// ─── 2A. Eligibility (pure) ─────────────────────────────────────────────────
//
// Deliberately does NOT check "no existing ai_enrichment_job for this
// event" — that idempotency guarantee is enforced at the DB layer (a UNIQUE
// constraint on subscriptionEventId + ON CONFLICT DO NOTHING on insert, see
// server/gmail.ts's queueing call), not here. A pure function can't see the
// jobs table without becoming a DB call, and duplicating a "does a row
// exist" check here would just be a second source of truth for something
// the UNIQUE constraint already guarantees atomically — the same "let the
// constraint own it" reasoning used throughout this feature line's Phase
// 3B.5 canonicalization work.
const BODY_TIER = sourcePrecedence("body");

export function isEligibleForAI(
  event: Pick<SubscriptionEvent, "isCanonical" | "bodyFetched" | "extractedPrice" | "extractedCurrency" | "billingInterval" | "eventType">,
  user: Pick<User, "aiScanningEnabled">
): boolean {
  if (!event.isCanonical) return false;
  if (!event.bodyFetched) return false;
  if (!user.aiScanningEnabled) return false;
  // Mirrors gmail.ts's isSubscriptionEvidence() exactly (kept as a plain
  // inequality here rather than importing it, to avoid a narrower-type cast
  // against subscription_events.eventType's broader DB enum type).
  if (event.eventType === "one_time_purchase") return false;

  const hasGap = event.extractedPrice === null || event.extractedCurrency === null || event.billingInterval === null;
  return hasGap;
}

// ─── 2B. Data minimization (pure) ───────────────────────────────────────────
//
// Spec'd as taking a SubscriptionEvent, but subscription_events deliberately
// never stores subject/from/raw body (that's the whole point of this
// feature line's privacy model) — there is nothing on the stored row to
// build a payload FROM. The real raw fields are fetched fresh at enrichment
// time (server/aiEnrichmentQueue.ts, reusing the exact same
// fetchMessageBody()/gmail.users.messages.get() calls the original scan
// used) and handed to this function, whose actual job — the thing "data
// minimization" means here — is reducing that already-fetched raw message
// down to EXACTLY these 4 fields, nothing more, before it's allowed anywhere
// near an external API call.
export type RawMessageFields = {
  subject: string;
  from: string;
  date: string;
  bodyText: string;
};

export type AIPayload = {
  subject: string;
  from: string;
  date: string;
  bodyText: string;
};

const MAX_AI_BODY_CHARS = 4000;

export function buildAIPayload(raw: RawMessageFields): AIPayload {
  return {
    subject: raw.subject,
    from: raw.from,
    date: raw.date,
    bodyText: raw.bodyText.slice(0, MAX_AI_BODY_CHARS),
  };
}

// ─── 2C. Zod schema ──────────────────────────────────────────────────────────

export const AIEnrichmentSchema = z.object({
  merchantName: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().max(3).nullable(),
  billingInterval: z.enum(["weekly", "biweekly", "monthly", "quarterly", "semi_annual", "annual", "one_time", "unknown"]),
  nextBillingDate: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  cancellationUrl: z.string().url().nullable().or(z.literal(null)),
  eventType: z.enum([
    "subscription_invoice", "subscription_renewed", "payment_failed", "trial_started",
    "trial_ending", "subscription_cancelled", "price_changed", "one_time_purchase", "unknown",
  ]),
  confidence: z.number().min(0).max(1),
});

export type AIEnrichmentResult = z.infer<typeof AIEnrichmentSchema>;

/** Thrown when Claude's response doesn't match AIEnrichmentSchema — a NON-retryable failure (a malformed response won't fix itself on retry). */
export class AISchemaValidationError extends Error {
  constructor(zodError: z.ZodError) {
    super(`AI response failed schema validation: ${zodError.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")}`);
    this.name = "AISchemaValidationError";
  }
}

/** Thrown on a request timeout — RETRYABLE. */
export class AITimeoutError extends Error {
  constructor() {
    super("Claude API request timed out");
    this.name = "AITimeoutError";
  }
}

/** Thrown on a 429 — RETRYABLE. */
export class AIRateLimitError extends Error {
  constructor() {
    super("Claude API rate limited (429)");
    this.name = "AIRateLimitError";
  }
}

/** Any other Claude API failure (auth, 5xx, missing key) — NOT retried by default; a misconfigured key won't fix itself either. */
export class AIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderError";
  }
}

// ─── 2D. Claude call ─────────────────────────────────────────────────────────

const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_MAX_TOKENS = 500;
const CLAUDE_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You extract subscription billing facts from emails. Return only a JSON object matching the exact schema. " +
  "Do not invent facts not supported by the email. Return null for unknown fields.";

const RESPONSE_SCHEMA_DESCRIPTION = `{
  "merchantName": string | null,
  "amount": number | null,
  "currency": string | null (3-letter code),
  "billingInterval": "weekly" | "biweekly" | "monthly" | "quarterly" | "semi_annual" | "annual" | "one_time" | "unknown",
  "nextBillingDate": string | null (YYYY-MM-DD),
  "subscriptionId": string | null,
  "cancellationUrl": string | null (a full URL),
  "eventType": "subscription_invoice" | "subscription_renewed" | "payment_failed" | "trial_started" | "trial_ending" | "subscription_cancelled" | "price_changed" | "one_time_purchase" | "unknown",
  "confidence": number (0 to 1)
}`;

export type ClaudeCallResult = {
  result: AIEnrichmentResult;
  inputTokens: number;
  outputTokens: number;
};

/**
 * callClaudeHaiku(): PRIVACY — `payload.bodyText` (and the rest of
 * `payload`) is only ever used to build the request body below; it is never
 * passed to console.log/console.error, never included in a thrown error
 * message, and Claude's raw text response is parsed and discarded
 * immediately (only the validated structured result and token counts
 * survive past this function). The one log line this function is
 * responsible for is the caller's — see aiEnrichmentQueue.ts's own
 * `[AI] enrichment completed: inputTokens=X outputTokens=Y confidence=Z`.
 */
export async function callClaudeHaiku(payload: AIPayload): Promise<ClaudeCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIProviderError("ANTHROPIC_API_KEY is not configured");
  }

  const userMessage =
    `Extract subscription billing facts from this email. Respond with ONLY a JSON object matching this schema:\n${RESPONSE_SCHEMA_DESCRIPTION}\n\n` +
    `Subject: ${payload.subject}\nFrom: ${payload.from}\nDate: ${payload.date}\n\nBody:\n${payload.bodyText}`;

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
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
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
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  const rawText: string = data?.content?.[0]?.text ?? "";
  let parsedJson: unknown;
  try {
    // Claude occasionally wraps JSON in a fenced code block despite being
    // told to return only JSON — strip fences before parsing rather than
    // failing the whole enrichment over formatting.
    const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsedJson = JSON.parse(stripped);
  } catch {
    throw new AISchemaValidationError(new z.ZodError([{ code: "custom", path: [], message: "response was not valid JSON" }]));
  }

  const validation = AIEnrichmentSchema.safeParse(parsedJson);
  if (!validation.success) {
    throw new AISchemaValidationError(validation.error);
  }

  return { result: validation.data, inputTokens, outputTokens };
}

// ─── 2E. Apply AI results (pure) ─────────────────────────────────────────────
//
// CRITICAL BOUNDARY: "AI must NOT replace body-derived evidence with weaker
// inference." sourcePrecedence.ts ranks ai(4) above body(3) generically —
// that ranking exists for the LIVE re-scan conflict-resolution path
// (server/storage.ts), where a higher tier is allowed to refresh an equal
// tier. AI enrichment is deliberately MORE conservative than that generic
// rule: it only ever fills a field whose CURRENT source is strictly below
// body tier (null/metadata/snippet) — body-sourced data is never touched
// regardless of what AI returns, and neither is an already-ai-sourced field
// re-derived by this pass (this function is called once per job, so that
// distinction rarely matters in practice, but the strict-below-body gate
// makes it structurally impossible either way). This mirrors
// server/backfillBodyExtraction.ts's needsBodyFetch() gap-filling
// philosophy exactly, one tier up.
export type ApplicableEventFields = Pick<
  SubscriptionEvent,
  "extractedPrice" | "extractedCurrency" | "amountSource" | "billingInterval" | "intervalSource"
>;

export function applyAIEnrichment(
  event: ApplicableEventFields,
  aiResult: AIEnrichmentResult
): Partial<ApplicableEventFields> {
  const updates: Partial<ApplicableEventFields> = {};

  const amountGap = sourcePrecedence(event.amountSource) < BODY_TIER;
  if (amountGap && aiResult.amount !== null && aiResult.currency !== null) {
    updates.extractedPrice = aiResult.amount.toFixed(2);
    updates.extractedCurrency = aiResult.currency;
    updates.amountSource = "ai";
  }

  const intervalGap = sourcePrecedence(event.intervalSource) < BODY_TIER;
  const usableInterval = aiResult.billingInterval !== "unknown" && aiResult.billingInterval !== "one_time";
  if (intervalGap && usableInterval) {
    updates.billingInterval = aiResult.billingInterval;
    updates.intervalSource = "ai";
  }

  return updates;
}
