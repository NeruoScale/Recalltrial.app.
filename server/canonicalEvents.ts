// ─── Canonical event identity — pure decision logic (Phase 3B.5 Step 1) ────────
//
// Deliberately separated from storage.ts's DB I/O: given the existing rows
// for a (userId, sourceMessageId) and a new incoming eventType, decide what
// should happen — insert-only, no-op (already classified this way), or a
// reclassification (old row superseded, new row becomes canonical). No
// database access here, so this is directly unit-testable without a live
// DB connection, same pattern as gmail.ts/merchantResolver.ts/
// entityResolver.ts.
//
// HARD RULE this module exists to enforce: historical classification
// generations are NEVER deleted, and a reclassification is never treated
// as an independent, unrelated event — every row in a chain shares one
// canonicalEventId, which always points at whichever row is CURRENTLY
// canonical.

import type { SubscriptionEvent } from "@shared/schema";

export type CanonicalizationDecision =
  | { kind: "first_generation" }
  | { kind: "same_classification"; currentCanonical: SubscriptionEvent }
  | { kind: "reclassification"; oldCanonicalRow: SubscriptionEvent; newGeneration: number; chainRowIdsToRelink: string[] };

/**
 * existingRowsForMessage: ALL rows (every generation, canonical or
 * superseded) already stored for this exact (userId, sourceMessageId) —
 * not scoped to one eventType. Empty array means this message has never
 * been classified before.
 */
export function decideCanonicalization(
  existingRowsForMessage: SubscriptionEvent[],
  newEventType: SubscriptionEvent["eventType"]
): CanonicalizationDecision {
  if (existingRowsForMessage.length === 0) {
    return { kind: "first_generation" };
  }

  const currentCanonical = existingRowsForMessage.find((r) => r.isCanonical);

  if (!currentCanonical) {
    // Defensive: the invariant (exactly one canonical row per message) is
    // supposed to always hold, but if it's ever violated (e.g. manual DB
    // edit, or bootstrapping from data that predates this system), don't
    // compound the problem — start a fresh chain rather than guessing
    // which stale row to treat as canonical.
    return { kind: "first_generation" };
  }

  if (currentCanonical.eventType === newEventType) {
    return { kind: "same_classification", currentCanonical };
  }

  // Reclassification: every OTHER row in the chain (not just the current
  // canonical one) needs its canonicalEventId relinked to the new row, to
  // preserve "canonicalEventId always = current canonical row's id" across
  // the whole chain, not just the most recent hop.
  const chainRowIdsToRelink = existingRowsForMessage
    .filter((r) => r.id !== currentCanonical.id)
    .map((r) => r.id);

  return {
    kind: "reclassification",
    oldCanonicalRow: currentCanonical,
    newGeneration: currentCanonical.classificationGeneration + 1,
    chainRowIdsToRelink,
  };
}
