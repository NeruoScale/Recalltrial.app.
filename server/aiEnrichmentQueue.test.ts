import { describe, it, expect, vi } from "vitest";

// This file only tests the pure exports (classifyJobFailure,
// backoffMinutesForAttempts) — but aiEnrichmentQueue.ts's top-level imports
// pull in server/db.ts (throws without a live DATABASE_URL), server/gmail.ts
// (imports googleapis), and server/storage.ts (imports server/db.ts too).
// None of these are exercised by the tests below, so all are mocked away at
// the module boundary — same pattern server/backfillBodyExtraction.test.ts
// already uses for the identical reason.
vi.mock("./db", () => ({ db: {} }));
vi.mock("./storage", () => ({ storage: {} }));
vi.mock("@shared/schema", () => ({ aiEnrichmentJobs: {}, subscriptionEvents: {}, users: {} }));
vi.mock("./gmail", () => ({ buildGmailClient: vi.fn(), fetchMessageBody: vi.fn() }));
vi.mock("./aiCredits", () => ({ reserveCredit: vi.fn(), refundCredit: vi.fn() }));
vi.mock("./aiEnrichment", () => ({
  buildAIPayload: vi.fn(),
  callClaudeHaiku: vi.fn(),
  applyAIEnrichment: vi.fn(),
  AITimeoutError: class AITimeoutError extends Error {},
  AIRateLimitError: class AIRateLimitError extends Error {},
  AISchemaValidationError: class AISchemaValidationError extends Error {},
  AIProviderError: class AIProviderError extends Error {},
}));

import {
  classifyJobFailure,
  backoffMinutesForAttempts,
} from "./aiEnrichmentQueue";
import {
  AITimeoutError,
  AIRateLimitError,
  AISchemaValidationError,
  AIProviderError,
} from "./aiEnrichment";

// Cross-user isolation and "duplicate job insertion ignored" are both DB
// constraint/query-scoping guarantees (a UNIQUE constraint on
// subscriptionEventId; explicit userId re-verification inside
// processAIEnrichmentJob) — this codebase has no DB-integration test
// infrastructure anywhere (every existing *.test.ts file tests a pure
// function only), so both are verified live against production during the
// Phase 3B.9.9 benchmark instead, the same way every other DB-layer
// guarantee in this feature line has been verified (Phase 3B.9.6A's
// subscriptionId backfill, Phase 3B.9.7-PATCH's source-aware conflict
// resolution, etc).

describe("Phase 3B.9.9: classifyJobFailure()", () => {
  it("Claude timeout with attempts < maxAttempts -> status='failed' (retryable), not dead_letter", () => {
    const result = classifyJobFailure(new AITimeoutError(), 1, 3);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("rate limit with attempts < maxAttempts -> status='failed' (retryable)", () => {
    const result = classifyJobFailure(new AIRateLimitError(), 1, 3);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("Zod schema validation failure -> status='failed', NOT retried regardless of attempts remaining", () => {
    const zodErr = new (AISchemaValidationError as any)("bad shape");
    const result = classifyJobFailure(zodErr, 1, 3);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("schema_validation_failed");
    expect(result.retryable).toBe(false);
  });

  it("a retryable error that has exhausted attempts (attempts >= maxAttempts) -> dead_letter", () => {
    const result = classifyJobFailure(new AITimeoutError(), 3, 3);
    expect(result.status).toBe("dead_letter");
    expect(result.errorCode).toBe("timeout");
  });

  it("a non-retryable error is 'failed' even when attempts >= maxAttempts (never dead_letter for a schema violation)", () => {
    const result = classifyJobFailure(new (AISchemaValidationError as any)("bad shape"), 3, 3);
    expect(result.status).toBe("failed");
  });

  it("a generic provider error (e.g. misconfigured API key) is non-retryable", () => {
    const result = classifyJobFailure(new AIProviderError("ANTHROPIC_API_KEY is not configured"), 1, 3);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("claude_error");
    expect(result.retryable).toBe(false);
  });

  it("an unrecognized error type is treated as non-retryable, not silently retried forever", () => {
    const result = classifyJobFailure(new Error("something unexpected"), 1, 3);
    expect(result.retryable).toBe(false);
  });
});

describe("Phase 3B.9.9: backoffMinutesForAttempts()", () => {
  it("attempt 1 (first try) is immediate: 0 minutes", () => {
    expect(backoffMinutesForAttempts(0)).toBe(0);
  });

  it("after attempt 1 fails, attempt 2 waits 5 minutes", () => {
    expect(backoffMinutesForAttempts(1)).toBe(5);
  });

  it("after attempt 2 fails, attempt 3 waits 30 minutes", () => {
    expect(backoffMinutesForAttempts(2)).toBe(30);
  });
});
