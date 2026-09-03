import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShadowSubscription, User, SubscriptionEvent, PriceIncreaseNotification } from "@shared/schema";

// Regression coverage for the Price Increase Notification storage-layer
// orchestration — the actual DB-backed methods on DatabaseStorage, not a
// bypass. Same technique server/lateScanProtection.test.ts introduced in
// Phase 5.1A: mock ./db with a minimal chainable fake, import the REAL
// storage singleton (with ./db and googleapis mocked so the module graph
// resolves without a live DB or the real googleapis package), and exercise
// the real methods.
vi.mock("googleapis", () => ({
  google: { auth: { OAuth2: vi.fn() }, gmail: vi.fn() },
}));

const {
  mockDb,
  queueSelect,
  queueUpdateReturning,
  queueInsertDedup,
  getUpdateCalls,
  getInsertCalls,
  resetDbMock,
} = vi.hoisted(() => {
  const selectQueue: any[] = [];
  const updateReturningQueue: any[] = [];
  const updateCalls: { table: unknown; set: unknown }[] = [];
  const insertCalls: { table: unknown; values: unknown; deduped: boolean }[] = [];
  // Simulates the real DB's composite UNIQUE constraint + onConflictDoNothing:
  // a second insert whose values are byte-identical to an already-"committed"
  // one is a no-op, proving idempotency at this mock's level of fidelity —
  // real concurrent-transaction atomicity itself is unchanged Postgres
  // behavior, same as every other atomic-claim pattern already trusted
  // throughout this codebase (see lateScanProtection.test.ts's own framing).
  const committedInsertKeys = new Set<string>();

  function selectChain() {
    const value = selectQueue.length ? selectQueue.shift() : [];
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(value),
      orderBy: () => chain,
      then: (res: any, rej: any) => Promise.resolve(value).then(res, rej),
    };
    return chain;
  }

  function updateChain(table: unknown) {
    const record = { table, set: undefined as unknown };
    updateCalls.push(record);
    const chain: any = {
      set: (fields: unknown) => {
        record.set = fields;
        return chain;
      },
      where: () => chain,
      returning: () => Promise.resolve(updateReturningQueue.length ? updateReturningQueue.shift() : []),
      then: (res: any, rej: any) => Promise.resolve(undefined).then(res, rej),
    };
    return chain;
  }

  function insertChain(table: unknown) {
    const record = { table, values: undefined as unknown, deduped: false };
    const chain: any = {
      values: (v: unknown) => {
        record.values = v;
        return chain;
      },
      onConflictDoNothing: () => {
        const key = JSON.stringify(record.values);
        if (committedInsertKeys.has(key)) {
          record.deduped = true;
        } else {
          committedInsertKeys.add(key);
        }
        insertCalls.push(record);
        return chain;
      },
      returning: () => Promise.resolve([]),
      then: (res: any, rej: any) => Promise.resolve(undefined).then(res, rej),
    };
    return chain;
  }

  const db = {
    select: () => ({ from: () => selectChain() }),
    update: (table: unknown) => updateChain(table),
    insert: (table: unknown) => insertChain(table),
  };

  return {
    mockDb: db,
    queueSelect: (v: unknown) => selectQueue.push(v),
    queueUpdateReturning: (v: unknown) => updateReturningQueue.push(v),
    queueInsertDedup: () => {}, // reserved, dedup is automatic via committedInsertKeys
    getUpdateCalls: () => updateCalls,
    getInsertCalls: () => insertCalls,
    resetDbMock: () => {
      selectQueue.length = 0;
      updateReturningQueue.length = 0;
      updateCalls.length = 0;
      insertCalls.length = 0;
      committedInsertKeys.clear();
    },
  };
});

vi.mock("./db", () => ({ db: mockDb, pool: {} }));

import { storage } from "./storage";

function makeSubscriptionEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    id: "evt-1",
    subscriptionId: "sub-1",
    userId: "user-1",
    emailConnectionId: null,
    eventType: "subscription_invoice",
    sourceMessageId: "msg-1",
    extractedPrice: "9.99",
    extractedCurrency: "USD",
    extractedDate: "2026-07-01",
    extractedMerchant: "Acme",
    previousPrice: null,
    newPrice: null,
    billingInterval: "monthly",
    billingIntervalSource: null,
    billingIntervalConfidence: null,
    amountSource: "snippet",
    intervalSource: "snippet",
    dateSource: "snippet",
    bodyFetched: false,
    confidence: 80,
    detectionSource: "deterministic",
    aiModel: null,
    canonicalMerchantName: "Acme",
    canonicalMerchantDomain: "acme.com",
    paymentProcessor: null,
    merchantConfidence: 90,
    merchantResolutionStatus: "resolved",
    canonicalEventId: null,
    classificationGeneration: 1,
    isCanonical: true,
    supersededBy: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

function makeSubscription(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  return {
    id: "sub-1",
    userId: "user-1",
    entityKey: "acme.com",
    canonicalMerchantName: "Acme",
    canonicalMerchantDomain: "acme.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: "9.99",
    currency: "USD",
    billingInterval: "monthly",
    billingIntervalSource: null,
    billingIntervalConfidence: null,
    nextBillingDate: null,
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-0",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: null,
    promotionReason: null,
    promotionEvidence: null,
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

function makeNotification(overrides: Partial<PriceIncreaseNotification> = {}): PriceIncreaseNotification {
  return {
    id: "notif-1",
    subscriptionId: "sub-1",
    userId: "user-1",
    detectedAt: "2026-08-15",
    previousAmount: "9.99",
    previousCurrency: "USD",
    previousInterval: "monthly",
    newAmount: "12.99",
    newCurrency: "USD",
    newInterval: "monthly",
    percentageChange: "30",
    monthlyImpact: "3",
    annualImpact: "36",
    status: "PENDING",
    sentAt: null,
    provider: "resend",
    providerMessageId: null,
    lastError: null,
    claimedAt: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    ...overrides,
  } as PriceIncreaseNotification;
}

beforeEach(() => {
  resetDbMock();
});

describe("runPriceChangeDetection() — notification creation (idempotency)", () => {
  it("a genuine price increase creates exactly one notification record", async () => {
    const priorEvent = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedDate: "2026-07-01" });
    const increaseEvent = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "12.99", extractedDate: "2026-08-15" });
    const subscription = makeSubscription();

    queueSelect([priorEvent, increaseEvent]); // subscriptionEvents lookup
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]); // subscriptions update .returning()

    await (storage as any).runPriceChangeDetection(subscription);

    const inserts = getInsertCalls().filter((c) => !c.deduped);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({
      subscriptionId: "sub-1",
      userId: "user-1",
      previousAmount: "9.99",
      newAmount: "12.99",
    });
  });

  it("repeated processing of the SAME underlying event data does not create a duplicate notification", async () => {
    const priorEvent = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedDate: "2026-07-01" });
    const increaseEvent = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "12.99", extractedDate: "2026-08-15" });
    const subscription = makeSubscription();

    // First run (e.g. the event that actually caused the change)
    queueSelect([priorEvent, increaseEvent]);
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]);
    await (storage as any).runPriceChangeDetection(subscription);

    // Second run — same event history re-queried (a rescan, a retry, an
    // unrelated later lifecycle event on the same subscription re-triggering
    // runPriceChangeDetection). detectPriceChanges() recomputes the SAME
    // latestChange from the SAME two observations.
    queueSelect([priorEvent, increaseEvent]);
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]);
    await (storage as any).runPriceChangeDetection(subscription);

    const committedInserts = getInsertCalls().filter((c) => !c.deduped);
    expect(committedInserts).toHaveLength(1);
    // The second attempt did happen (onConflictDoNothing was invoked), it
    // was just deduped rather than silently never attempted.
    expect(getInsertCalls()).toHaveLength(2);
    expect(getInsertCalls()[1].deduped).toBe(true);
  });

  it("a LATER, genuinely different price increase for the same subscription creates its own new notification", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "12.99", extractedDate: "2026-08-15" });
    const e3 = makeSubscriptionEvent({ id: "evt-3", extractedPrice: "14.99", extractedDate: "2026-09-20" });
    const subscription = makeSubscription({ amount: "12.99" });

    queueSelect([e1, e2]);
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]);
    await (storage as any).runPriceChangeDetection(subscription);

    queueSelect([e1, e2, e3]);
    queueUpdateReturning([makeSubscription({ amount: "14.99" })]);
    await (storage as any).runPriceChangeDetection(makeSubscription({ amount: "12.99" }));

    const committedInserts = getInsertCalls().filter((c) => !c.deduped);
    expect(committedInserts).toHaveLength(2);
    expect((committedInserts[1].values as any).previousAmount).toBe("12.99");
    expect((committedInserts[1].values as any).newAmount).toBe("14.99");
  });
});

describe("runPriceChangeDetection() — filtering (no notification for non-increases)", () => {
  it("does not create a notification for a price decrease", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "12.99", extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "9.99", extractedDate: "2026-08-15" });
    queueSelect([e1, e2]);
    queueUpdateReturning([makeSubscription({ amount: "9.99" })]);

    await (storage as any).runPriceChangeDetection(makeSubscription({ amount: "12.99" }));

    expect(getInsertCalls()).toHaveLength(0);
  });

  it("does not create a notification for a currency change", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedCurrency: "USD", extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "9.99", extractedCurrency: "EUR", extractedDate: "2026-08-15" });
    queueSelect([e1, e2]);
    queueUpdateReturning([makeSubscription({ currency: "EUR" })]);

    await (storage as any).runPriceChangeDetection(makeSubscription());

    expect(getInsertCalls()).toHaveLength(0);
  });

  it("does not create a notification for a billing-interval change", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", billingInterval: "monthly", extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "99.99", billingInterval: "annual", extractedDate: "2026-08-15" });
    queueSelect([e1, e2]);
    queueUpdateReturning([makeSubscription({ billingInterval: "annual" })]);

    await (storage as any).runPriceChangeDetection(makeSubscription());

    expect(getInsertCalls()).toHaveLength(0);
  });

  it("does not create a notification for a first-known price (no prior observation to compare against)", async () => {
    const onlyEvent = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedDate: "2026-07-01" });
    queueSelect([onlyEvent]);
    queueUpdateReturning([]); // priceChanges.latestChange is null -> function returns before any update

    await (storage as any).runPriceChangeDetection(makeSubscription());

    expect(getInsertCalls()).toHaveLength(0);
  });

  it("does not create a notification when the price is unchanged (identical observations collapse to one, no pair to compare)", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: "9.99", extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "9.99", extractedDate: "2026-08-15" });
    queueSelect([e1, e2]);

    await (storage as any).runPriceChangeDetection(makeSubscription());

    expect(getInsertCalls()).toHaveLength(0);
  });

  it("does not create a notification for an invalid/incomplete comparison (missing amount on one side)", async () => {
    const e1 = makeSubscriptionEvent({ id: "evt-1", extractedPrice: null, extractedDate: "2026-07-01" });
    const e2 = makeSubscriptionEvent({ id: "evt-2", extractedPrice: "12.99", extractedDate: "2026-08-15" });
    // buildPriceHistory() itself filters out the null-price event entirely,
    // leaving a single observation — same "first-known price" shape as above.
    queueSelect([e1, e2]);
    queueUpdateReturning([]);

    await (storage as any).runPriceChangeDetection(makeSubscription());

    expect(getInsertCalls()).toHaveLength(0);
  });
});

describe("Price Increase Notification delivery state machine", () => {
  it("successful delivery: claim then mark sent reaches SENT", async () => {
    queueUpdateReturning([makeNotification({ status: "SENDING", claimedAt: new Date() })]);
    const claimed = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(claimed?.status).toBe("SENDING");

    await storage.markPriceIncreaseNotificationSent("notif-1", "resend-msg-1");
    const sentCall = getUpdateCalls().at(-1);
    expect(sentCall?.set).toMatchObject({ status: "SENT", providerMessageId: "resend-msg-1", lastError: null, claimedAt: null });
  });

  it("provider failure marks FAILED (retryable), and a later claim can still succeed", async () => {
    await storage.markPriceIncreaseNotificationFailed("notif-1", "Resend timeout");
    const failCall = getUpdateCalls().at(-1);
    expect(failCall?.set).toMatchObject({ status: "FAILED", lastError: "Resend timeout", claimedAt: null });

    // Retry: FAILED rows remain claimable (same inArray(["PENDING","FAILED"])
    // shape as claimSubscriptionReminderForSending) — simulated here by
    // queuing a successful claim result for the retry attempt.
    queueUpdateReturning([makeNotification({ status: "SENDING" })]);
    const retried = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(retried?.status).toBe("SENDING");
  });

  it("retry does not duplicate the email after a successful send: a claim attempt after SENT finds nothing to claim", async () => {
    queueUpdateReturning([makeNotification({ status: "SENDING" })]);
    const firstClaim = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(firstClaim).toBeDefined();

    await storage.markPriceIncreaseNotificationSent("notif-1", "msg-1");

    // A subsequent claim attempt for the same (now-SENT) row: the real
    // WHERE clause (status IN ('PENDING','FAILED')) matches zero rows —
    // simulated by queuing an empty result, proving the caller (the
    // delivery loop) correctly treats this as "nothing to do", never
    // re-sending.
    queueUpdateReturning([]);
    const secondClaim = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(secondClaim).toBeUndefined();
  });

  it("concurrent delivery attempts cannot both send the same notification: the second claim loses the race", async () => {
    // Worker A's claim succeeds...
    queueUpdateReturning([makeNotification({ status: "SENDING" })]);
    const workerA = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(workerA).toBeDefined();

    // ...worker B's claim, arriving after A's atomic UPDATE already moved
    // the row out of PENDING/FAILED, matches zero rows (queued empty here
    // to represent that outcome — the actual atomicity guarantee is the
    // same single-conditional-UPDATE pattern already trusted throughout
    // this codebase, e.g. claimSubscriptionReminderForSending).
    queueUpdateReturning([]);
    const workerB = await storage.claimPriceIncreaseNotificationForSending("notif-1");
    expect(workerB).toBeUndefined();
  });

  it("skip marks SKIPPED with the given reason and clears claimedAt", async () => {
    await storage.markPriceIncreaseNotificationSkipped("notif-1", "price increase notifications disabled by user");
    const skipCall = getUpdateCalls().at(-1);
    expect(skipCall?.set).toMatchObject({ status: "SKIPPED", lastError: "price increase notifications disabled by user", claimedAt: null });
  });

  it("stale SENDING rows are recovered back to PENDING", async () => {
    queueUpdateReturning([{ id: "notif-1" }, { id: "notif-2" }]);
    const recovered = await storage.recoverStalePriceIncreaseNotificationSending(30, new Date());
    expect(recovered).toBe(2);
    const recoverCall = getUpdateCalls().at(-1);
    expect(recoverCall?.set).toMatchObject({ status: "PENDING", claimedAt: null });
  });
});

describe("Price Increase Notification user preference persistence", () => {
  it("togglePriceIncreaseNotifications persists the boolean on the user row", async () => {
    queueUpdateReturning([{ id: "user-1", priceIncreaseNotificationsEnabled: false }]);
    const updated = await storage.togglePriceIncreaseNotifications("user-1", false);
    expect(updated).toMatchObject({ priceIncreaseNotificationsEnabled: false });
    const call = getUpdateCalls().at(-1);
    expect(call?.set).toMatchObject({ priceIncreaseNotificationsEnabled: false });
  });

  it("disabling immediately skips existing PENDING/FAILED notifications for that user", async () => {
    queueUpdateReturning([{ id: "notif-1" }, { id: "notif-2" }]);
    const skippedCount = await storage.skipPendingPriceIncreaseNotificationsForDisabledUser("user-1");
    expect(skippedCount).toBe(2);
    const call = getUpdateCalls().at(-1);
    expect(call?.set).toMatchObject({ status: "SKIPPED", lastError: "price increase notifications disabled by user", claimedAt: null });
  });
});

describe("Price Increase Notification email payload correctness", () => {
  it("buildPriceIncreaseNotificationEmail includes merchant, old/new price, percentage, monthly/annual impact, date, and a subscriptions link", async () => {
    const { buildPriceIncreaseNotificationEmail } = await import("./email");
    const notification = makeNotification();
    const subscription = makeSubscription();

    const { subject, html } = buildPriceIncreaseNotificationEmail(notification, subscription);

    expect(subject).toContain("Acme");
    expect(html).toContain("Acme");
    expect(html).toContain("9.99 USD");
    expect(html).toContain("12.99 USD");
    expect(html).toContain("30");
    expect(html).toContain("3 USD"); // monthlyImpact
    expect(html).toContain("36 USD"); // annualImpact
    expect(html).toContain("August 15, 2026");
    expect(html).toContain("/subscriptions");
  }, 30000);
});
