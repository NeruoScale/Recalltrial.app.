// ─── Extraction-source quality precedence (Phase 3B.9.7-PATCH) ─────────────────
//
// Single source of truth for "which extraction layer's data wins" — reused
// by server/storage.ts's onConflictDoUpdate() SQL (hand-written to match
// these exact numbers, since raw SQL can't import a TS function — see the
// comment there) and by server/backfillBodyExtraction.ts's per-field
// decision. If this table ever changes, both call sites need updating
// together.

export type ExtractionSourceTier = "ai" | "body" | "snippet" | "metadata" | null;

const PRECEDENCE: Record<string, number> = {
  ai: 4,
  body: 3,
  snippet: 2,
  metadata: 1,
};

/** null/unknown source is always the lowest tier (0). */
export function sourcePrecedence(source: string | null | undefined): number {
  if (!source) return 0;
  return PRECEDENCE[source] ?? 0;
}

/**
 * isEligibleToUpgrade(): whether data sourced at `newSource` is even allowed
 * to overwrite data currently sourced at `existingSource`. Equal tiers ARE
 * eligible (e.g. body -> body) — a same-tier re-fetch can carry genuinely
 * fresher data (a merchant's price changed between two scans); callers that
 * also want to skip truly identical re-writes should separately compare the
 * actual field VALUES before applying/counting an update — this function
 * only answers the source-quality question, never the "did anything
 * actually change" question.
 */
export function isEligibleToUpgrade(newSource: string | null, existingSource: string | null): boolean {
  return sourcePrecedence(newSource) >= sourcePrecedence(existingSource);
}
