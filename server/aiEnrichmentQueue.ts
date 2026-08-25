// ─── AI enrichment job queue processor (Phase 3B.9.9) ──────────────────────────
//
// The DB/network orchestration around server/aiEnrichment.ts's pure
// functions — claiming a job, fetching fresh raw message data (never
// stored, see below), calling Claude, applying results, and updating job
// bookkeeping. Every step that can fail is isolated so a failure here NEVER
// touches subscription_events except in the one success path that
// legitimately improves it, and NEVER blocks/breaks the Gmail scan that
// queued it (this module is only ever invoked from the cron endpoint, not
// from inside scanGmailForTrials()).

import { eq, and, sql } from "drizzle-orm";
import { db } from "./db";
import { aiEnrichmentJobs, subscriptionEvents, users } from "@shared/schema";
import { buildGmailClient, fetchMessageBody } from "./gmail";
import {
  buildAIPayload,
  callClaudeHaiku,
  applyAIEnrichment,
  AITimeoutError,
  AIRateLimitError,
  AISchemaValidationError,
  AIProviderError,
} from "./aiEnrichment";
import { reserveCredit, refundCredit } from "./aiCredits";
import { storage } from "./storage";

class AIScanningDisabledError extends Error {
  constructor() {
    super("User has disabled AI scanning since this job was queued");
    this.name = "AIScanningDisabledError";
  }
}

// ─── Retry classification (pure) ────────────────────────────────────────────
//
// 'failed' is used for BOTH retryable and non-retryable outcomes — what
// makes a 'failed' job actually retried later is errorCode being in
// RETRYABLE_ERROR_CODES *and* attempts < maxAttempts (see
// eligibleNowCondition() below, which the cron fetch and the claim step
// both use). A non-retryable errorCode (schema violation, disabled
// scanning, provider misconfiguration) lands on 'failed' too but is simply
// never matched by that condition again — it's terminal by exclusion, not
// by a different status value. Only once a RETRYABLE error exhausts
// maxAttempts does the status become 'dead_letter'.
const RETRYABLE_ERROR_CODES = new Set(["timeout", "rate_limited"]);

function errorCodeFor(error: unknown): string {
  if (error instanceof AITimeoutError) return "timeout";
  if (error instanceof AIRateLimitError) return "rate_limited";
  if (error instanceof AISchemaValidationError) return "schema_validation_failed";
  if (error instanceof AIScanningDisabledError) return "ai_scanning_disabled";
  if (error instanceof AIProviderError) return "claude_error";
  return "unknown_error";
}

export type JobFailureClassification = {
  status: "failed" | "dead_letter";
  errorCode: string;
  retryable: boolean;
};

export function classifyJobFailure(error: unknown, attemptsAfterIncrement: number, maxAttempts: number): JobFailureClassification {
  const errorCode = errorCodeFor(error);
  const retryable = RETRYABLE_ERROR_CODES.has(errorCode);
  if (retryable && attemptsAfterIncrement < maxAttempts) {
    return { status: "failed", errorCode, retryable: true };
  }
  if (!retryable) {
    return { status: "failed", errorCode, retryable: false };
  }
  return { status: "dead_letter", errorCode, retryable: false };
}

/** attempt 1 = immediate (0 wait), attempt 2 = 5 min after attempt 1, attempt 3 = 30 min after attempt 2. `attempts` here is the CURRENT (post-increment) count on a job that just failed — i.e. "how long to wait before the NEXT attempt." */
export function backoffMinutesForAttempts(attempts: number): number {
  if (attempts <= 0) return 0;
  if (attempts === 1) return 5;
  if (attempts === 2) return 30;
  return Infinity;
}

/**
 * eligibleNowCondition(): a job is claimable right now when it's freshly
 * `pending`, OR it's `failed` with a retryable errorCode, hasn't exhausted
 * its attempts, and its backoff window (backoffMinutesForAttempts, mirrored
 * here in SQL since a DO/WHERE clause can't call a TS function) has
 * elapsed since `startedAt`. Shared verbatim by the cron's list-fetch and
 * by processAIEnrichmentJob()'s own claim UPDATE, so the two can never
 * disagree about what's ready to run.
 */
function eligibleNowCondition() {
  return sql`(
    ${aiEnrichmentJobs.status} = 'pending'
    OR (
      ${aiEnrichmentJobs.status} = 'failed'
      AND ${aiEnrichmentJobs.errorCode} IN ('timeout', 'rate_limited')
      AND ${aiEnrichmentJobs.attempts} < ${aiEnrichmentJobs.maxAttempts}
      AND ${aiEnrichmentJobs.startedAt} + (
        CASE ${aiEnrichmentJobs.attempts}
          WHEN 1 THEN interval '5 minutes'
          WHEN 2 THEN interval '30 minutes'
          ELSE interval '0 minutes'
        END
      ) <= now()
    )
  )`;
}

export async function fetchEligibleJobIds(limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: aiEnrichmentJobs.id })
    .from(aiEnrichmentJobs)
    .where(eligibleNowCondition())
    .orderBy(aiEnrichmentJobs.requestedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

// Rough, clearly-labeled estimate only (this is what estimatedCostUsd
// literally means) — Claude Haiku's published per-token rate as of this
// phase; update these two constants if Anthropic's pricing changes.
const INPUT_COST_PER_TOKEN_USD = 1.0 / 1_000_000;
const OUTPUT_COST_PER_TOKEN_USD = 5.0 / 1_000_000;

export type ProcessJobOutcome = "completed" | "failed" | "dead_letter" | "skipped" | "no_credits";

/**
 * processAIEnrichmentJob(): STEP 1-10 of Phase 3B.9.9's spec, in order.
 * PRIVACY: `bodyText` is a local variable for the duration of this
 * function only — never logged, never assigned anywhere it would outlive
 * this call, matching server/gmail.ts's Layer 2 discipline and
 * server/aiEnrichment.ts's own callClaudeHaiku() note.
 */
export async function processAIEnrichmentJob(jobId: string): Promise<ProcessJobOutcome> {
  const [claimed] = await db
    .update(aiEnrichmentJobs)
    .set({ status: "processing", startedAt: new Date(), attempts: sql`${aiEnrichmentJobs.attempts} + 1` })
    .where(and(eq(aiEnrichmentJobs.id, jobId), eligibleNowCondition()))
    .returning();

  if (!claimed) return "skipped"; // already claimed elsewhere, or no longer eligible (e.g. still in backoff)

  try {
    const [event] = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.id, claimed.subscriptionEventId));
    const [user] = await db.select().from(users).where(eq(users.id, claimed.userId));

    if (!event || !user) throw new AIProviderError("event or user no longer exists");

    // Cross-user isolation, checked explicitly rather than trusted — the
    // job's userId and the event's userId are written together at queue
    // time (server/gmail.ts) and should never diverge, but every other
    // user-scoped query in this codebase re-verifies rather than assuming
    // (see subscriptionCostEngine.ts's own defensive userId filter).
    if (event.userId !== claimed.userId) throw new AIProviderError("event/job user scope mismatch");

    if (!user.aiScanningEnabled) throw new AIScanningDisabledError();
    if (!user.gmailAccessToken) throw new AIProviderError("gmail_not_connected");

    const gmail = buildGmailClient(user.gmailAccessToken, user.gmailRefreshToken, user.gmailTokenExpiry);

    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: event.sourceMessageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = msgRes.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    const bodyText = await fetchMessageBody(gmail, event.sourceMessageId);
    if (!bodyText) throw new AIProviderError("body_unavailable");

    const payload = buildAIPayload({
      subject: getHeader("Subject"),
      from: getHeader("From"),
      date: getHeader("Date"),
      bodyText,
    });

    // Phase 3B.9.10 STEP 3: reserved as late as possible — right before the
    // actual Claude call, only once we know a real request is about to be
    // sent — so a job that fails for a reason unrelated to AI (Gmail
    // disconnected, body unavailable) never costs the user a credit.
    // `referenceId` is scoped to THIS attempt (jobId:attemptNumber), not
    // the job as a whole, so a retried job's later attempt reserves (and,
    // on failure, refunds) its own fresh credit rather than colliding with
    // a previous attempt's ledger entry.
    const referenceId = `${jobId}:${claimed.attempts}`;
    const reserved = await reserveCredit(claimed.userId, referenceId);
    if (!reserved) {
      await db.update(aiEnrichmentJobs).set({
        status: "no_credits",
        completedAt: new Date(),
      }).where(eq(aiEnrichmentJobs.id, jobId));
      console.log(`[AI] job ${jobId} skipped: no AI credits available`);
      return "no_credits";
    }

    let result: Awaited<ReturnType<typeof callClaudeHaiku>>["result"];
    let inputTokens: number;
    let outputTokens: number;
    try {
      ({ result, inputTokens, outputTokens } = await callClaudeHaiku(payload));
    } catch (claudeErr) {
      // The credit was reserved but the call itself failed (timeout/429/5xx)
      // or Claude's response failed Zod validation — never let a failed AI
      // call silently consume a credit. Re-thrown so the existing outer
      // catch block below still classifies/records the failure exactly as
      // it did before credits existed.
      await refundCredit(claimed.userId, referenceId);
      throw claudeErr;
    }
    console.log(`[AI] enrichment completed: inputTokens=${inputTokens} outputTokens=${outputTokens} confidence=${result.confidence}`);

    const updates = applyAIEnrichment(event, result);
    const fieldsImproved: string[] = [];
    if (updates.extractedPrice !== undefined) fieldsImproved.push("amount");
    if (updates.extractedCurrency !== undefined) fieldsImproved.push("currency");
    if (updates.billingInterval !== undefined) fieldsImproved.push("billingInterval");

    if (fieldsImproved.length > 0) {
      await db.update(subscriptionEvents).set(updates).where(eq(subscriptionEvents.id, event.id));
    }

    const estimatedCostUsd = (inputTokens * INPUT_COST_PER_TOKEN_USD + outputTokens * OUTPUT_COST_PER_TOKEN_USD).toFixed(6);

    await db.update(aiEnrichmentJobs).set({
      status: "completed",
      completedAt: new Date(),
      inputTokenCount: inputTokens,
      outputTokenCount: outputTokens,
      estimatedCostUsd,
      fieldsImproved,
    }).where(eq(aiEnrichmentJobs.id, jobId));

    // STEP 10: rerun lifecycle on the improved event — reuses the exact
    // same mechanism the body-extraction backfill (Phase 3B.9.7-PATCH)
    // uses, never a bespoke one. Isolated in its own try/catch: a
    // lifecycle failure must never turn a successfully-completed
    // enrichment job into a failed one.
    if (fieldsImproved.length > 0) {
      try {
        await storage.applyLifecycleEventToSubscription({
          id: event.id,
          eventType: event.eventType,
          extractedPrice: updates.extractedPrice ?? event.extractedPrice,
          extractedCurrency: updates.extractedCurrency ?? event.extractedCurrency,
          extractedDate: event.extractedDate,
          userId: event.userId,
          canonicalMerchantDomain: event.canonicalMerchantDomain,
          billingInterval: updates.billingInterval ?? event.billingInterval,
          emailConnectionId: event.emailConnectionId,
        });
      } catch (err) {
        console.error("[AI] lifecycle re-application failed:", err);
      }
    }

    return "completed";
  } catch (err) {
    const classification = classifyJobFailure(err, claimed.attempts, claimed.maxAttempts);
    await db.update(aiEnrichmentJobs).set({
      status: classification.status,
      errorCode: classification.errorCode,
      completedAt: classification.status === "dead_letter" ? new Date() : null,
    }).where(eq(aiEnrichmentJobs.id, jobId));
    console.error(`[AI] enrichment job ${jobId} -> ${classification.status} (${classification.errorCode})`);
    return classification.status;
  }
}

export type BatchResult = { processed: number; succeeded: number; failed: number; deadLettered: number; noCredits: number };

export async function processAIEnrichmentBatch(limit = 10): Promise<BatchResult> {
  const ids = await fetchEligibleJobIds(limit);
  let succeeded = 0, failed = 0, deadLettered = 0, noCredits = 0;
  for (const id of ids) {
    const outcome = await processAIEnrichmentJob(id);
    if (outcome === "completed") succeeded++;
    else if (outcome === "failed") failed++;
    else if (outcome === "dead_letter") deadLettered++;
    else if (outcome === "no_credits") noCredits++;
  }
  return { processed: ids.length, succeeded, failed, deadLettered, noCredits };
}
