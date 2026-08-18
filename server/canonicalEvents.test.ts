import { describe, it, expect } from "vitest";
import { decideCanonicalization } from "./canonicalEvents";
import type { SubscriptionEvent } from "@shared/schema";

let idCounter = 0;
function makeRow(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  idCounter++;
  return {
    id: `evt-${idCounter}`,
    subscriptionId: null,
    userId: "user-1",
    eventType: "subscription_invoice",
    sourceMessageId: "msg-1",
    extractedPrice: null,
    extractedCurrency: null,
    extractedDate: null,
    extractedMerchant: null,
    previousPrice: null,
    newPrice: null,
    confidence: 50,
    detectionSource: "deterministic",
    aiModel: null,
    canonicalMerchantName: null,
    canonicalMerchantDomain: null,
    paymentProcessor: null,
    merchantConfidence: null,
    merchantResolutionStatus: null,
    canonicalEventId: null,
    classificationGeneration: 1,
    isCanonical: true,
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

describe("decideCanonicalization", () => {
  it("a never-before-seen message is a first_generation", () => {
    const decision = decideCanonicalization([], "subscription_invoice");
    expect(decision.kind).toBe("first_generation");
  });

  it("re-scanning the same message under the SAME eventType is same_classification, not a new generation", () => {
    const existing = makeRow({ id: "evt-1", eventType: "subscription_invoice", isCanonical: true });
    const decision = decideCanonicalization([existing], "subscription_invoice");
    expect(decision.kind).toBe("same_classification");
    if (decision.kind === "same_classification") {
      expect(decision.currentCanonical.id).toBe("evt-1");
    }
  });

  it("reclassifying under a DIFFERENT eventType marks the old row for superseding and bumps the generation", () => {
    const existing = makeRow({ id: "evt-1", eventType: "invoice_received", isCanonical: true, classificationGeneration: 1 });
    const decision = decideCanonicalization([existing], "one_time_purchase");
    expect(decision.kind).toBe("reclassification");
    if (decision.kind === "reclassification") {
      expect(decision.oldCanonicalRow.id).toBe("evt-1");
      expect(decision.newGeneration).toBe(2);
      expect(decision.chainRowIdsToRelink).toEqual([]);
    }
  });

  it("both rows are preserved across a reclassification: old row's data isn't discarded, only the decision output describes what should happen to it", () => {
    const existing = makeRow({ id: "evt-1", eventType: "invoice_received", isCanonical: true, classificationGeneration: 1 });
    const decision = decideCanonicalization([existing], "one_time_purchase");
    expect(decision.kind).toBe("reclassification");
    // decideCanonicalization is pure decision logic — it never deletes or
    // mutates rows itself. The caller (storage.ts) is responsible for
    // actually preserving both rows; this test locks in that the decision
    // object always contains enough information to do that (the old row to
    // supersede, distinct from the fact that a new row will be inserted).
    if (decision.kind === "reclassification") {
      expect(decision.oldCanonicalRow).toEqual(existing);
    }
  });

  it("relinks EVERY other row in a multi-generation chain, not just the most recent one, on a further reclassification", () => {
    const gen1 = makeRow({ id: "evt-1", eventType: "invoice_received", isCanonical: false, classificationGeneration: 1, canonicalEventId: "evt-2", supersededBy: "evt-2" });
    const gen2 = makeRow({ id: "evt-2", eventType: "one_time_purchase", isCanonical: true, classificationGeneration: 2, canonicalEventId: "evt-2" });
    const decision = decideCanonicalization([gen1, gen2], "subscription_cancelled");
    expect(decision.kind).toBe("reclassification");
    if (decision.kind === "reclassification") {
      expect(decision.oldCanonicalRow.id).toBe("evt-2");
      expect(decision.newGeneration).toBe(3);
      expect(decision.chainRowIdsToRelink).toEqual(["evt-1"]);
    }
  });

  it("defensively starts a fresh chain if no row in the existing set is marked canonical (invariant violation)", () => {
    const existing = makeRow({ id: "evt-1", eventType: "invoice_received", isCanonical: false });
    const decision = decideCanonicalization([existing], "invoice_received");
    expect(decision.kind).toBe("first_generation");
  });

  it("is idempotent: repeated calls with the same existing rows and same new eventType always produce the same decision kind", () => {
    const existing = makeRow({ id: "evt-1", eventType: "invoice_received", isCanonical: true, classificationGeneration: 1 });
    const a = decideCanonicalization([existing], "subscription_cancelled");
    const b = decideCanonicalization([existing], "subscription_cancelled");
    expect(a.kind).toBe(b.kind);
    if (a.kind === "reclassification" && b.kind === "reclassification") {
      expect(a.newGeneration).toBe(b.newGeneration);
      expect(a.oldCanonicalRow.id).toBe(b.oldCanonicalRow.id);
    }
  });
});
