import { describe, it, expect } from "vitest";
import { buildReminderPresentation } from "./reminderPresentation";
import type { ShadowSubscription, SubscriptionReminder } from "@shared/schema";

let subIdCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  subIdCounter++;
  return {
    id: `sub-${subIdCounter}`,
    userId: "user-U",
    entityKey: "anthropic.com",
    canonicalMerchantName: "Anthropic",
    canonicalMerchantDomain: "anthropic.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: "20.00",
    currency: "USD",
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    nextBillingDate: "2026-08-22",
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-original",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-01T00:00:00.000Z"),
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
    lastEventEmailConnectionId: null,
    crossAccountConflict: false,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

function makeReminderRow(overrides: Partial<SubscriptionReminder> = {}): SubscriptionReminder {
  return {
    id: "reminder-1",
    subscriptionId: "sub-1",
    userId: "user-U",
    remindAt: new Date("2026-08-19T00:00:00.000Z"),
    type: "THREE_DAYS",
    status: "PENDING",
    sentAt: null,
    provider: "resend",
    providerMessageId: null,
    lastError: "Some internal Resend error with a secret token abc123",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionReminder;
}

const NOW = new Date("2026-08-19T00:00:00.000Z");

describe("buildReminderPresentation — eligibility gate (Phase 4.3 Test 1/2)", () => {
  it("Test 1: eligible subscription with a valid future renewal returns all three offset items", () => {
    const sub = makeSub();
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.items.map((i) => i.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
      expect(result.items.map((i) => i.label)).toEqual(["3 days before", "2 days before", "1 day before"]);
    }
  });

  it("Test 2: missing renewal date returns eligible=false with a friendly reason, never a scheduled reminder", () => {
    const sub = makeSub({ nextBillingDate: null });
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("We don't have a renewal date yet, so we can't schedule a reminder.");
      expect(result.items).toEqual([]);
    }
  });

  it("dismissed subscription returns a dismissed-specific friendly reason", () => {
    const sub = makeSub({ userDismissed: true });
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain("dismissed");
  });

  it("a cancelled subscription returns a status-specific friendly reason", () => {
    const sub = makeSub({ subscriptionStatus: "canceled" });
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toBe("Reminders aren't available for this subscription's current status.");
  });

  it("an already-passed renewal date returns a past-date friendly reason", () => {
    const sub = makeSub({ nextBillingDate: "2020-01-01" });
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toBe("This renewal date has already passed.");
  });
});

describe("buildReminderPresentation — real row state mapping (Phase 4.3 Test 9)", () => {
  it("no matching row for an offset -> not_scheduled", () => {
    const sub = makeSub();
    const result = buildReminderPresentation(sub, NOW, "UTC", []);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      for (const item of result.items) expect(item.status).toBe("not_scheduled");
    }
  });

  it("a PENDING row maps to 'scheduled' with its remindAt exposed", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "THREE_DAYS", status: "PENDING", remindAt: new Date("2026-08-19T12:00:00.000Z") });
    const result = buildReminderPresentation(sub, NOW, "UTC", [row]);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      const item = result.items.find((i) => i.type === "THREE_DAYS")!;
      expect(item.status).toBe("scheduled");
      expect(item.remindAt).toBe("2026-08-19T12:00:00.000Z");
    }
  });

  it("a SENDING row (mid-delivery claim) ALSO maps to 'scheduled' -- an internal implementation detail never leaks to the user", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "TWO_DAYS", status: "SENDING" as any });
    const result = buildReminderPresentation(sub, NOW, "UTC", [row]);
    if (result.eligible) {
      const item = result.items.find((i) => i.type === "TWO_DAYS")!;
      expect(item.status).toBe("scheduled");
    }
  });

  it("a SENT row maps to 'sent' with sentAt exposed, remindAt cleared", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "ONE_DAY", status: "SENT", sentAt: new Date("2026-08-21T09:00:00.000Z") });
    const result = buildReminderPresentation(sub, NOW, "UTC", [row]);
    if (result.eligible) {
      const item = result.items.find((i) => i.type === "ONE_DAY")!;
      expect(item.status).toBe("sent");
      expect(item.sentAt).toBe("2026-08-21T09:00:00.000Z");
      expect(item.remindAt).toBeNull();
    }
  });

  it("a FAILED row maps to 'unavailable' -- never the raw FAILED status name, never lastError", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "THREE_DAYS", status: "FAILED", lastError: "Resend API key abc123 rejected" });
    const result = buildReminderPresentation(sub, NOW, "UTC", [row]);
    if (result.eligible) {
      const item = result.items.find((i) => i.type === "THREE_DAYS")!;
      expect(item.status).toBe("unavailable");
      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain("FAILED");
      expect(serialized).not.toContain("abc123");
      expect(serialized).not.toContain("lastError");
    }
  });

  it("a SKIPPED row is treated identically to no row at all -- not an error state", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "TWO_DAYS", status: "SKIPPED" as any });
    const result = buildReminderPresentation(sub, NOW, "UTC", [row]);
    if (result.eligible) {
      const item = result.items.find((i) => i.type === "TWO_DAYS")!;
      expect(item.status).toBe("not_scheduled");
    }
  });

  it("never exposes database ids, provider name, or raw status strings anywhere in the output", () => {
    const sub = makeSub();
    const rows = [
      makeReminderRow({ id: "reminder-secret-1", type: "THREE_DAYS", status: "SENT", providerMessageId: "resend-msg-999" }),
      makeReminderRow({ id: "reminder-secret-2", type: "TWO_DAYS", status: "PENDING" }),
      makeReminderRow({ id: "reminder-secret-3", type: "ONE_DAY", status: "FAILED" }),
    ];
    const result = buildReminderPresentation(sub, NOW, "UTC", rows);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("reminder-secret");
    expect(serialized).not.toContain("resend-msg-999");
    expect(serialized).not.toContain("PENDING");
    expect(serialized).not.toContain("SENDING");
    expect(serialized).not.toContain("FAILED");
  });

  it("Test 10: even if two rows exist for the SAME offset type (defensive -- the real DB has a unique constraint preventing this), exactly one item is ever produced per type, never a duplicate row in the output", () => {
    const sub = makeSub();
    const rows = [
      makeReminderRow({ id: "row-a", type: "THREE_DAYS", status: "PENDING" }),
      makeReminderRow({ id: "row-b", type: "THREE_DAYS", status: "SENT", sentAt: new Date("2026-08-19T09:00:00.000Z") }),
    ];
    const result = buildReminderPresentation(sub, NOW, "UTC", rows);
    if (result.eligible) {
      const threeDayItems = result.items.filter((i) => i.type === "THREE_DAYS");
      expect(threeDayItems).toHaveLength(1);
      expect(result.items).toHaveLength(3); // exactly one per offset type overall, never more
    }
  });

  it("determinism: identical inputs always produce the identical presentation", () => {
    const sub = makeSub();
    const row = makeReminderRow({ type: "THREE_DAYS", status: "SENT", sentAt: new Date("2026-08-19T09:00:00.000Z") });
    const a = buildReminderPresentation(sub, NOW, "UTC", [row]);
    const b = buildReminderPresentation(sub, NOW, "UTC", [row]);
    expect(a).toEqual(b);
  });
});
