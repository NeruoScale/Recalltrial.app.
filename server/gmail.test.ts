import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Step 6: verify failure isolation in the REAL scanGmailForTrials() code
// path (not a refactor/extraction) — mock googleapis so no network call
// happens, and mock the dynamically-imported ./storage so the subscription
// detector's write can be forced to throw on demand.
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    gmail: vi.fn(),
  },
}));

vi.mock("./storage", () => ({
  storage: { createSubscriptionEvent: vi.fn() },
}));

import { google } from "googleapis";
import { storage } from "./storage";
import {
  hasStrongPositive,
  hasSoftNegative,
  hasRequiredTrigger,
  passesReceiptFilter,
  extractDate,
  extractStartDate,
  extractAmount,
  resolveServiceName,
  getRootDomain,
  extractDomainFromEmail,
  scoreConfidenceDetailed,
  detectSubscriptionEvent,
  scanGmailForTrials,
} from "./gmail";

// Given email input -> detector -> expected structured output.
// These are the pure, side-effect-free functions scanGmailForTrials() composes;
// no Gmail API calls, no DB, no network involved anywhere in this file.

const RECEIVED = new Date("2026-08-01T00:00:00.000Z");

describe("detection: trial lifecycle", () => {
  it("flags a trial-ending email as a strong positive", () => {
    const text = "your trial ends in 3 days".toLowerCase();
    expect(hasStrongPositive(text)).toBe(true);
  });

  it("flags a trial-started email as a strong positive", () => {
    const text = "your free trial has started".toLowerCase();
    expect(hasStrongPositive(text)).toBe(true);
  });

  it("extracts a relative 'ends in N days' date", () => {
    const { date, source } = extractDate("your trial ends in 3 days", RECEIVED);
    expect(source).toBe("relative");
    expect(date).toBe("2026-08-04");
  });

  it("extracts a duration-based trial length", () => {
    const { date, source } = extractDate("start your 14-day free trial today", RECEIVED);
    expect(source).toBe("duration");
    expect(date).toBe("2026-08-15");
  });
});

describe("detection: subscription / renewal", () => {
  it("flags 'renews on' as a strong positive and required trigger", () => {
    const text = "your subscription renews on Aug 20, 2026".toLowerCase();
    expect(hasStrongPositive(text)).toBe(true);
    expect(hasRequiredTrigger(text)).toBe(true);
  });

  // Was `it.fails` during Phase 2: extractDate() did `new Date(dateString)`
  // (local-time parse) then `.toISOString()` (UTC serialize), which could
  // silently roll a date back one day depending on the host's timezone.
  // Fixed by parsing calendar components as plain integers and never
  // round-tripping through an ambiguous local-time Date parse — see the
  // timezone-safe helpers above extractDate() in gmail.ts. Promoted to a
  // real assertion now that it's fixed.
  it("extracts an explicit 'renews on' date", () => {
    const { date, source } = extractDate("your subscription renews on Aug 20, 2026", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2026-08-20");
  });

  it("extracts an explicit next-billing-date", () => {
    const { date, source } = extractDate("Next billing date: 2026-09-01", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2026-09-01");
  });
});

describe("detection: invoice / receipt filtering", () => {
  it("passes a receipt that also has a recurring indicator", () => {
    const text = "receipt for your monthly subscription renewal".toLowerCase();
    expect(passesReceiptFilter(text)).toBe(true);
  });

  it("rejects a bare receipt with no recurring indicator (one-off purchase)", () => {
    const text = "receipt for your one-time purchase of a t-shirt".toLowerCase();
    expect(passesReceiptFilter(text)).toBe(false);
  });
});

describe("detection: price-change signal", () => {
  it("extracts a $ amount", () => {
    const { amount, currency } = extractAmount("your plan is now $23.99/month");
    expect(amount).toBe("23.99");
    expect(currency).toBe("USD");
  });

  it("extracts a non-USD currency amount", () => {
    const { amount, currency } = extractAmount("you were charged £11.99 today");
    expect(amount).toBe("11.99");
    expect(currency).toBe("GBP");
  });
});

describe("detection: cancellation phrasing", () => {
  it("flags 'cancel before' as a strong positive", () => {
    const text = "cancel before Aug 19 to avoid being charged".toLowerCase();
    expect(hasStrongPositive(text)).toBe(true);
  });
});

describe("false positive rejection", () => {
  it("does not treat a newsletter as a strong positive", () => {
    const text = "check out our weekly update and new features".toLowerCase();
    expect(hasStrongPositive(text)).toBe(false);
    expect(hasSoftNegative(text)).toBe(true);
  });

  it("does not treat a shipping notification as a strong positive", () => {
    const text = "your order has shipped, track your package".toLowerCase();
    expect(hasStrongPositive(text)).toBe(false);
    expect(hasSoftNegative(text)).toBe(true);
  });

  it("does not treat a security alert as a strong positive", () => {
    const text = "new sign-in detected, verify your email".toLowerCase();
    expect(hasStrongPositive(text)).toBe(false);
    expect(hasSoftNegative(text)).toBe(true);
  });
});

describe("dates: no invented dates", () => {
  it("returns source 'none' when there is no date signal at all", () => {
    const { date, source } = extractDate("thanks for being a customer", RECEIVED);
    expect(date).toBeNull();
    expect(source).toBe("none");
  });

  it("start-date extraction never defaults to today when absent", () => {
    const { date, source } = extractStartDate("thanks for being a customer");
    expect(date).toBeNull();
    expect(source).toBe("none");
  });

  // Same fix as above, applied to extractStartDate() too. Promoted from
  // `it.fails` now that it's fixed.
  it("extracts an explicit start date when present", () => {
    const { date, source } = extractStartDate("your trial started on Aug 1, 2026");
    expect(source).toBe("explicit");
    expect(date).toBe("2026-08-01");
  });
});

describe("timezone boundary regression (UTC+ and UTC-)", () => {
  // Proves the fix by reproducing the exact mechanism of the original bug:
  // Node respects a runtime process.env.TZ change for local-time Date
  // construction/methods. Etc/GMT POSIX zone signs are inverted from their
  // plain-English meaning — "Etc/GMT-14" IS UTC+14, "Etc/GMT+12" IS UTC-12 —
  // chosen as the two most extreme standard offsets so the boundary is
  // unambiguous in both directions, not a coincidence of a milder offset.
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  // Explicit-year dates deliberately use 2030, not RECEIVED's 2026: the
  // explicit-date branch rolls a date forward a year if it's already
  // passed relative to the REAL wall-clock date the test happens to run
  // on (matching the original code's own behavior, unrelated to this fix)
  // — a same-year-as-RECEIVED date would silently stop being "in the
  // future" and become a different, wrong assertion once real time passes
  // it. A year comfortably out avoids that class of test rot.

  it("extractDate: explicit month-name date is stable under UTC+14", () => {
    process.env.TZ = "Etc/GMT-14"; // UTC+14 — the direction that caused the original bug
    const { date, source } = extractDate("your subscription renews on Aug 20, 2030", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: explicit month-name date is stable under UTC-12", () => {
    process.env.TZ = "Etc/GMT+12"; // UTC-12 — the opposite extreme
    const { date, source } = extractDate("your subscription renews on Aug 20, 2030", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: bare MM/DD/YYYY is stable under UTC+14", () => {
    process.env.TZ = "Etc/GMT-14";
    const { date, source } = extractDate("renewal scheduled 08/20/2030 for your account", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: bare MM/DD/YYYY is stable under UTC-12", () => {
    process.env.TZ = "Etc/GMT+12";
    const { date, source } = extractDate("renewal scheduled 08/20/2030 for your account", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: bare YYYY-MM-DD is stable under UTC+14", () => {
    process.env.TZ = "Etc/GMT-14";
    const { date, source } = extractDate("renewal scheduled 2030-08-20 for your account", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: bare YYYY-MM-DD is stable under UTC-12", () => {
    process.env.TZ = "Etc/GMT+12";
    const { date, source } = extractDate("renewal scheduled 2030-08-20 for your account", RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe("2030-08-20");
  });

  it("extractDate: 'short month+day, no year' produces the identical result under UTC+14 and UTC-12", () => {
    // No year in the input by design (that's the case being tested), so the
    // function always infers the real current UTC year — a hardcoded
    // expected year would be exactly as fragile as the ordinal-day case
    // below. Cross-timezone consistency is the correct thing to assert.
    process.env.TZ = "Etc/GMT-14";
    const plus14 = extractDate("thanks for being a customer, see you Dec 25", RECEIVED);
    process.env.TZ = "Etc/GMT+12";
    const minus12 = extractDate("thanks for being a customer, see you Dec 25", RECEIVED);
    expect(plus14.source).toBe("explicit");
    expect(plus14.date).toEqual(minus12.date);
    expect(plus14.date).toMatch(/^\d{4}-12-25$/);
  });

  it("extractDate: 'on the Nth' ordinal produces the identical result under UTC+14 and UTC-12", () => {
    // This branch compares its candidate date against the real wall-clock
    // "today", so a hardcoded expected calendar value would be fragile
    // (correct today, silently wrong once real time passes it) — asserting
    // cross-timezone consistency directly targets what's actually being
    // proven here (timezone-invariance) without that coupling.
    process.env.TZ = "Etc/GMT-14";
    const plus14 = extractDate("your subscription renews on the 15th", RECEIVED);
    process.env.TZ = "Etc/GMT+12";
    const minus12 = extractDate("your subscription renews on the 15th", RECEIVED);
    expect(plus14.source).toBe("relative");
    expect(plus14.date).toEqual(minus12.date);
    expect(plus14.source).toEqual(minus12.source);
  });

  it("extractDate: month-duration is stable under UTC+14", () => {
    process.env.TZ = "Etc/GMT-14";
    const { date, source } = extractDate("start your 1-month trial today", RECEIVED);
    expect(source).toBe("duration");
    expect(date).toBe("2026-09-01"); // RECEIVED = 2026-08-01
  });

  it("extractDate: month-duration is stable under UTC-12", () => {
    process.env.TZ = "Etc/GMT+12";
    const { date, source } = extractDate("start your 1-month trial today", RECEIVED);
    expect(source).toBe("duration");
    expect(date).toBe("2026-09-01");
  });

  it("extractStartDate: explicit month-name date is stable under UTC+14", () => {
    process.env.TZ = "Etc/GMT-14";
    const { date, source } = extractStartDate("your trial started on Aug 1, 2026");
    expect(source).toBe("explicit");
    expect(date).toBe("2026-08-01");
  });

  it("extractStartDate: explicit month-name date is stable under UTC-12", () => {
    process.env.TZ = "Etc/GMT+12";
    const { date, source } = extractStartDate("your trial started on Aug 1, 2026");
    expect(source).toBe("explicit");
    expect(date).toBe("2026-08-01");
  });
});

describe("entity resolution: merchant vs. payment processor", () => {
  it("resolves a direct merchant sender by root domain", () => {
    expect(resolveServiceName("billing.spotify.com", "Your payment was processed")).toBe("Spotify");
  });

  it("resolves the real merchant from a Stripe-routed receipt snippet, not 'Stripe'", () => {
    const name = resolveServiceName("stripe.com", "You subscribed to Canva Pro. Thanks!");
    expect(name.toLowerCase()).toContain("canva");
  });

  it("root-domain collapses subdomains (billing.spotify.com and spotify.com match)", () => {
    expect(getRootDomain("billing.spotify.com")).toBe(getRootDomain("spotify.com"));
  });

  it("extracts the sender domain from a From header", () => {
    expect(extractDomainFromEmail("RecallTrial <notifications@recalltrial.app>")).toBe("recalltrial.app");
  });
});

describe("detectSubscriptionEvent (Phase 2 Step 5 parallel detector)", () => {
  it("classifies a trial-started email", () => {
    const r = detectSubscriptionEvent(
      "Welcome to your free trial",
      "your free trial has started, enjoy!",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("trial_started");
  });

  it("classifies a trial-ending email", () => {
    const r = detectSubscriptionEvent(
      "Your trial is ending",
      "your trial ends in 3 days",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("trial_ending");
  });

  it("classifies a subscription-activated email", () => {
    const r = detectSubscriptionEvent(
      "You're all set",
      "your subscription is now active",
      "noreply@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("subscription_started");
  });

  it("classifies a renewal email", () => {
    const r = detectSubscriptionEvent(
      "Renewal notice",
      "your subscription renews on Aug 20, 2026",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("subscription_renewed");
  });

  it("classifies a payment-received email", () => {
    const r = detectSubscriptionEvent(
      "Payment confirmation",
      "payment received, card charged successfully",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("payment_received");
  });

  it("classifies a bare invoice email as invoice_received when nothing more specific matches", () => {
    const r = detectSubscriptionEvent(
      "Your invoice is ready",
      "your invoice for this billing period is now available to view",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r?.eventType).toBe("invoice_received");
  });

  it("returns null for a newsletter (no subscription-lifecycle signal at all)", () => {
    const r = detectSubscriptionEvent(
      "What's new this week",
      "check out our weekly update and new features",
      "news@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r).toBeNull();
  });

  it("returns null for a shipping notification", () => {
    const r = detectSubscriptionEvent(
      "Your order has shipped",
      "tracking number: 1Z999AA10123456784",
      "orders@shop.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(r).toBeNull();
  });

  it("does not classify price_changed, cancellation_*, expired, or paused — not detectable without a subscriptions table (Phase 4/8, out of scope for this step)", () => {
    const r = detectSubscriptionEvent(
      "Your subscription",
      "your subscription price has increased",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    // "subscription" alone isn't a strong positive/required trigger, so this
    // returns null rather than a misleading guess — documents the boundary,
    // doesn't invent a signal that doesn't exist in gmailKeywords.ts yet.
    expect(r).toBeNull();
  });
});

describe("confidence scoring", () => {
  it("scores a strong, dated, priced trial-ending email highly", () => {
    const { score } = scoreConfidenceDetailed(
      "Your trial ends in 3 days",
      "your trial ends in 3 days, you will be charged $9.99",
      "billing@service.com",
      true,
      true,
      "relative"
    );
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it("penalizes a bare receipt with no recurring indicator", () => {
    // "receipt" is itself in STRONG_POSITIVES (gmailKeywords.ts), so it adds
    // +35 before the -30 receipt-without-recurring-indicator penalty is
    // applied — net score lands at exactly 30 (20 base + 35 - 30 + 5 for the
    // "noreply" sender bonus... verified against the real scoring function,
    // not assumed), still well below the 70 acceptance threshold.
    const { score } = scoreConfidenceDetailed(
      "Your receipt",
      "receipt for your one-time purchase",
      "noreply@shop.com",
      false,
      false,
      "none"
    );
    expect(score).toBeLessThanOrEqual(30);
  });
});

describe("Step 6: subscription-detector failure isolation", () => {
  function mockGmailClient(message: { from: string; subject: string; date: string; snippet: string }) {
    const messagesGet = vi.fn().mockResolvedValue({
      data: {
        payload: {
          headers: [
            { name: "From", value: message.from },
            { name: "Subject", value: message.subject },
            { name: "Date", value: message.date },
          ],
        },
        snippet: message.snippet,
      },
    });
    const messagesList = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "msg-1" }], nextPageToken: undefined },
    });
    (google.gmail as any).mockReturnValue({
      users: { messages: { list: messagesList, get: messagesGet } },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still returns the trial suggestion when the subscription-event write throws", async () => {
    // A message that both the existing trial pipeline AND the new parallel
    // detector would act on: a real trial-ending email with a future
    // relative date, strong positive signal, and a price.
    const now = new Date();
    mockGmailClient({
      from: "billing@service.com",
      subject: "Your trial ends in 3 days",
      date: now.toUTCString(),
      snippet: "your trial ends in 3 days, you will be charged $9.99",
    });

    (storage.createSubscriptionEvent as any).mockRejectedValue(new Error("simulated DB failure"));

    const results = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

    // The existing trial-suggestion pipeline must be completely unaffected
    // by the subscription detector's write throwing.
    expect(results).toHaveLength(1);
    expect(results[0].messageId).toBe("msg-1");
    expect(results[0].serviceGuess).toBe("Service");

    // And the subscription detector really was invoked (and really did
    // fail) — this isn't passing because the write path was skipped.
    expect(storage.createSubscriptionEvent).toHaveBeenCalledTimes(1);
  });

  it("produces the identical trial suggestion whether or not the subscription write succeeds", async () => {
    // Same message, but this time the write succeeds — proves the two
    // paths are truly independent in both directions, not just when one
    // happens to fail.
    const now = new Date();
    const message = {
      from: "billing@service.com",
      subject: "Your trial ends in 3 days",
      date: now.toUTCString(),
      snippet: "your trial ends in 3 days, you will be charged $9.99",
    };

    mockGmailClient(message);
    (storage.createSubscriptionEvent as any).mockResolvedValue(true);
    const withSuccess = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

    mockGmailClient(message);
    (storage.createSubscriptionEvent as any).mockRejectedValue(new Error("simulated DB failure"));
    const withFailure = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

    expect(withSuccess).toHaveLength(1);
    expect(withFailure).toHaveLength(1);
    expect(withSuccess[0].messageId).toBe(withFailure[0].messageId);
    expect(withSuccess[0].confidence).toBe(withFailure[0].confidence);
  });
});
