import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShadowSubscription, EmailConnection, User } from "@shared/schema";
import type { LifecycleRelevantEvent } from "./subscriptionLifecycle";

// Phase 5.1A: regression coverage for RULE 6 (late-scan mutation protection)
// in server/storage.ts's applyLifecycleEventToSubscription() — the one
// production invariant Phase 5.1's audit flagged as having zero automated
// test coverage. That guard lives inline in the DB-orchestration method
// itself (not in the pure subscriptionLifecycle.ts decision logic), so
// exercising the REAL guard — rather than a stand-in that bypasses it —
// means calling the real storage.ts method with a mocked ./db, not a fresh
// abstraction. googleapis is mocked because storage.ts transitively imports
// server/gmail.ts (for buildGmailDisconnectUpdate), matching the existing
// pattern already used by gmail.test.ts.
vi.mock("googleapis", () => ({
  google: { auth: { OAuth2: vi.fn() }, gmail: vi.fn() },
}));

const { mockDb, queueSelect, queueUpdateReturning, getUpdateCalls, getSelectCallCount, resetDbMock } = vi.hoisted(() => {
  const selectQueue: any[] = [];
  const updateReturningQueue: any[] = [];
  const updateCalls: { table: unknown; set: unknown }[] = [];
  let selectCallCount = 0;

  function selectChain() {
    selectCallCount++;
    const value = selectQueue.length ? selectQueue.shift() : [];
    const chain: any = {
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

  const db = {
    select: () => ({ from: () => selectChain() }),
    update: (table: unknown) => updateChain(table),
  };

  return {
    mockDb: db,
    queueSelect: (v: unknown) => selectQueue.push(v),
    queueUpdateReturning: (v: unknown) => updateReturningQueue.push(v),
    getUpdateCalls: () => updateCalls,
    getSelectCallCount: () => selectCallCount,
    resetDbMock: () => {
      selectQueue.length = 0;
      updateReturningQueue.length = 0;
      updateCalls.length = 0;
      selectCallCount = 0;
    },
  };
});

vi.mock("./db", () => ({ db: mockDb, pool: {} }));

// Imported AFTER the ./db mock above so the real applyLifecycleEventToSubscription
// (and the RULE 6 guard inline inside it) runs against the fake db, not a
// live connection — server/db.ts throws immediately without a real
// DATABASE_URL, and must never be touched by a test regardless.
import { storage } from "./storage";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user1@example.com",
    passwordHash: "hash",
    timezone: "UTC",
    plan: "FREE",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    emailScanningEnabled: true,
    aiScanningEnabled: false,
    gmailConnected: true,
    gmailAccessToken: null,
    gmailRefreshToken: null,
    gmailTokenExpiry: null,
    lastEmailScanAt: null,
    lastScanMessagesProcessed: null,
    aiCreditsIncluded: 0,
    aiCreditsPurchased: 0,
    aiCreditsResetAt: null,
    aiScanningConsentAt: null,
    aiScanningConsentVersion: null,
    preferences: {},
    // RULE 6 (and RULE 1-4 cross-account protection) are both gated behind
    // this same controlled-beta flag in storage.ts — must be true for the
    // late-scan guard to even run.
    subscriptionIntelligenceEnabled: true,
    subscriptionRemindersEnabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
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
    amount: null,
    currency: null,
    billingInterval: null,
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

function makeConnection(overrides: Partial<EmailConnection> = {}): EmailConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "google",
    providerAccountId: "google-sub-1",
    emailAddress: "user1@gmail.com",
    accessToken: "token",
    refreshToken: "refresh",
    tokenExpiry: null,
    connectedAt: new Date("2026-08-01T00:00:00.000Z"),
    disconnectedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as EmailConnection;
}

function makeEvent(overrides: Partial<LifecycleRelevantEvent> = {}): LifecycleRelevantEvent {
  return {
    id: "evt-1",
    eventType: "price_changed",
    extractedPrice: "12.99",
    extractedCurrency: "USD",
    extractedDate: null,
    userId: "user-1",
    canonicalMerchantDomain: "acme.com",
    billingInterval: null,
    emailConnectionId: "conn-1",
    ...overrides,
  } as LifecycleRelevantEvent;
}

beforeEach(() => {
  resetDbMock();
  vi.spyOn(storage as any, "runBillingIntelligence").mockImplementation(async (s: unknown) => s);
  vi.spyOn(storage as any, "runPriceChangeDetection").mockImplementation(async (s: unknown) => s);
});

describe("applyLifecycleEventToSubscription — RULE 6 late-scan protection", () => {
  it("positive control: an event from a still-active connection is applied and mutates the subscription", async () => {
    const existing = makeSubscription({ lastEventEmailConnectionId: null });
    const connection = makeConnection({ id: "conn-1", userId: "user-1", disconnectedAt: null });
    const event = makeEvent({ emailConnectionId: "conn-1" });

    queueSelect([existing]); // subscriptions existing-row lookup
    queueSelect([connection]); // emailConnections lookup for event.emailConnectionId
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]); // subscriptions update .returning()
    vi.spyOn(storage, "getUserById").mockResolvedValue(makeUser({ subscriptionIntelligenceEnabled: true }));

    // Sanity precondition for this scenario: the connection genuinely
    // belongs to the same user as the event/subscription.
    expect(connection.userId).toBe(event.userId);

    const result = await storage.applyLifecycleEventToSubscription(event);

    expect(result.applied).toBe(true);
    const calls = getUpdateCalls();
    expect(calls).toHaveLength(2); // subscriptionEvents stamp + subscriptions billing update
    const subUpdate = calls[1].set as Record<string, unknown>;
    expect(subUpdate.amount).toBe("12.99");
  });

  it("RULE 6: an event from a connection that has since been disconnected is NOT applied — evidence stays, mutation is skipped", async () => {
    const existing = makeSubscription({ lastEventEmailConnectionId: null, amount: null });
    // This connection owned the event at scan time, but was disconnected
    // before applyLifecycleEventToSubscription ran (the exact late-scan
    // race Phase 5.1 flagged).
    const disconnectedConnection = makeConnection({
      id: "conn-1",
      userId: "user-1",
      disconnectedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const event = makeEvent({ emailConnectionId: "conn-1" });

    queueSelect([existing]);
    queueSelect([disconnectedConnection]);
    vi.spyOn(storage, "getUserById").mockResolvedValue(makeUser({ subscriptionIntelligenceEnabled: true }));

    const result = await storage.applyLifecycleEventToSubscription(event);

    // The invariant: billing-state application is skipped...
    expect(result.applied).toBe(false);
    expect(result.subscription).toBeUndefined();

    const calls = getUpdateCalls();
    // ...but the event row itself (createSubscriptionEvent, which already
    // ran and committed BEFORE this method is ever called in the real scan
    // path — see server/storage.ts:817-819) is never touched or reverted by
    // this function, and the subscription is never written to.
    expect(calls.filter((c) => c.set && (c.set as Record<string, unknown>).amount !== undefined)).toHaveLength(0);
    expect(calls.every((c) => c.table !== undefined)).toBe(true);
    // Exactly the subscriptions existing-row lookup + the ONE emailConnections
    // lookup for event.emailConnectionId happened — no separate "is the user
    // currently connected" query exists. This proves the guard is evaluated
    // from the EVENT's own connection record, not the user's current active
    // connection state.
    expect(getSelectCallCount()).toBe(2);
    // Only the subscriptionEvents FK-stamp update ran (line ~1597 in
    // storage.ts, unconditional whenever `existing` resolves) — the
    // subscriptions table itself was never updated.
    expect(calls).toHaveLength(1);
  });

  it("RULE 6 gate is per-event-connection, not a general 'protection enabled' toggle: with protection disabled, the guard does not run at all", async () => {
    // Documents the actual gating condition read directly off
    // storage.ts:1614 (`if (crossAccountProtectionEnabled && event.emailConnectionId)`):
    // RULE 6 is nested inside the same controlled-beta flag as cross-account
    // conflict protection. A non-beta user's disconnected-connection event
    // is therefore NOT blocked by RULE 6 — pre-existing behavior, unchanged
    // by this phase, documented here rather than silently assumed.
    const existing = makeSubscription({ lastEventEmailConnectionId: null, amount: null });
    const event = makeEvent({ emailConnectionId: "conn-1" });

    queueSelect([existing]);
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]);
    vi.spyOn(storage, "getUserById").mockResolvedValue(makeUser({ subscriptionIntelligenceEnabled: false }));

    const result = await storage.applyLifecycleEventToSubscription(event);

    expect(result.applied).toBe(true);
    // No emailConnections lookup happened at all — RULE 6 never runs when
    // subscriptionIntelligenceEnabled is false.
    expect(getSelectCallCount()).toBe(1);
  });

  it("documents current behavior: this function does not itself verify the event connection's userId matches the event's userId (relies on the caller only ever supplying same-user connections)", async () => {
    const existing = makeSubscription({ userId: "user-1", lastEventEmailConnectionId: null, amount: null });
    // An ACTIVE connection, but owned by a different user than the event —
    // this should never happen via the real scan path (routes.ts always
    // sources emailConnectionId from getActiveEmailConnection(user.id, ...)
    // for the authenticated user), but applyLifecycleEventToSubscription
    // itself has no independent check for it.
    const otherUsersConnection = makeConnection({ id: "conn-2", userId: "user-2", disconnectedAt: null });
    const event = makeEvent({ userId: "user-1", emailConnectionId: "conn-2" });

    queueSelect([existing]);
    queueSelect([otherUsersConnection]);
    queueUpdateReturning([makeSubscription({ amount: "12.99" })]);
    vi.spyOn(storage, "getUserById").mockResolvedValue(makeUser({ id: "user-1", subscriptionIntelligenceEnabled: true }));

    const result = await storage.applyLifecycleEventToSubscription(event);

    // Current, actual behavior: not blocked. This is a documented gap (see
    // Phase 5.1A report), not a verified protection — flagged for a future
    // phase rather than fixed here, since adding a new ownership check would
    // be architecture work beyond this remediation's scope.
    expect(result.applied).toBe(true);
  });
});
