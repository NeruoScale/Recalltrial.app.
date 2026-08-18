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
  isKnownNoiseDomain,
  isSubscriptionEvidence,
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

describe("detectSubscriptionEvent (Phase 3B.2 taxonomy)", () => {
  const DATE = "Sat, 01 Aug 2026 00:00:00 GMT";

  describe("trial_started", () => {
    it("positive: clear trial-start confirmation", () => {
      const r = detectSubscriptionEvent("Welcome to your free trial", "your free trial has started, enjoy!", "billing@service.com", DATE);
      expect(r?.eventType).toBe("trial_started");
    });

    it("edge case: trial-ending language must NOT be misread as trial_started", () => {
      const r = detectSubscriptionEvent("Your trial is ending", "your trial ends in 3 days", "billing@service.com", DATE);
      expect(r?.eventType).not.toBe("trial_started");
      expect(r?.eventType).toBe("trial_ending");
    });
  });

  describe("trial_ending", () => {
    it("positive: clear trial-ending warning", () => {
      const r = detectSubscriptionEvent("Your trial is ending", "your trial ends in 3 days", "billing@service.com", DATE);
      expect(r?.eventType).toBe("trial_ending");
    });

    it("edge case: trial_ending is checked before subscription_renewed, so co-occurring renewal language doesn't hijack it", () => {
      const r = detectSubscriptionEvent(
        "Your trial is ending",
        "your trial ends in 3 days and then automatically renews",
        "billing@service.com",
        DATE
      );
      expect(r?.eventType).toBe("trial_ending");
    });
  });

  describe("subscription_cancelled", () => {
    it("positive: explicit cancellation confirmation", () => {
      const r = detectSubscriptionEvent("Your subscription is cancelled", "your subscription has been cancelled as requested", "billing@service.com", DATE);
      expect(r?.eventType).toBe("subscription_cancelled");
    });

    it("edge case: a 'cancel before X' renewal WARNING is not a cancellation confirmation", () => {
      // This is exactly the Step 1 finding: "cancel before" is a prompt to
      // avoid an upcoming charge, not evidence the subscription was
      // actually cancelled. Must land in subscription_renewed instead.
      const r = detectSubscriptionEvent("Renewal reminder", "cancel before Aug 20 to avoid being charged", "billing@service.com", DATE);
      expect(r?.eventType).not.toBe("subscription_cancelled");
      expect(r?.eventType).toBe("subscription_renewed");
    });
  });

  describe("payment_failed", () => {
    it("positive: explicit payment failure notice", () => {
      const r = detectSubscriptionEvent("Payment failed", "your payment failed, please update your payment method", "billing@service.com", DATE);
      expect(r?.eventType).toBe("payment_failed");
    });

    it("edge case: a routine 'payment due' reminder is not a failure notice", () => {
      const r = detectSubscriptionEvent("Payment due", "your payment is due soon", "billing@service.com", DATE);
      expect(r?.eventType).not.toBe("payment_failed");
      expect(r?.eventType).toBe("subscription_invoice");
    });
  });

  describe("price_changed", () => {
    it("positive: explicit price-change notice with old/new amounts extracted", () => {
      const r = detectSubscriptionEvent(
        "Your subscription price is changing",
        "your subscription price increase takes effect next month, from $9.99 to $12.99",
        "billing@service.com",
        DATE
      );
      expect(r?.eventType).toBe("price_changed");
      expect(r?.previousPrice).toBe("9.99");
      expect(r?.newPrice).toBe("12.99");
    });

    it("edge case: merely stating the current price is not a price-change notice", () => {
      const r = detectSubscriptionEvent("Your receipt", "your monthly subscription price is $9.99, charged today", "billing@service.com", DATE);
      expect(r?.eventType).not.toBe("price_changed");
    });
  });

  describe("subscription_renewed", () => {
    it("positive: explicit renewal date", () => {
      const r = detectSubscriptionEvent("Renewal notice", "your subscription renews on Aug 20, 2026", "billing@service.com", DATE);
      expect(r?.eventType).toBe("subscription_renewed");
    });

    it("edge case: 'cancel before' phrased as a cancellation prompt still correctly routes here, not to subscription_cancelled", () => {
      const r = detectSubscriptionEvent("Renewal reminder", "cancel before Aug 19 to avoid renewal", "billing@service.com", DATE);
      expect(r?.eventType).toBe("subscription_renewed");
    });
  });

  describe("subscription_invoice", () => {
    it("positive: invoice language with an explicit recurring indicator", () => {
      const r = detectSubscriptionEvent("Your invoice", "your monthly subscription invoice is ready, $9.99 charged", "billing@service.com", DATE);
      expect(r?.eventType).toBe("subscription_invoice");
    });

    it("edge case: 'payment due' with no invoice/receipt wording still resolves to subscription_invoice via the billing-due fold-in", () => {
      const r = detectSubscriptionEvent("Payment due", "payment due for your account", "billing@service.com", DATE);
      expect(r?.eventType).toBe("subscription_invoice");
    });
  });

  describe("one_time_purchase", () => {
    it("positive: explicit one-time-purchase phrasing", () => {
      const r = detectSubscriptionEvent("Thanks for your purchase", "you purchased 'Design Bundle' for $49, thank you for your one-time purchase", "billing@service.com", DATE);
      expect(r?.eventType).toBe("one_time_purchase");
    });

    it("edge case: genuinely ambiguous invoice wording (Step 1's real production pattern) — defaults to one_time_purchase but with a measurably lower confidence penalty, not a confident guess", () => {
      // This is the exact snippet shape Step 1's evaluation found dominating
      // production: "invoice" present, no recurring keyword co-occurring,
      // no explicit one-time phrase either — genuinely can't tell.
      const clear = detectSubscriptionEvent("Your invoice", "your monthly subscription invoice is ready, $9.99 charged", "billing@service.com", DATE);
      const ambiguous = detectSubscriptionEvent("Your invoice is ready", "your invoice for this billing period is now available to view", "billing@service.com", DATE);
      expect(ambiguous?.eventType).toBe("one_time_purchase");
      expect(ambiguous!.confidence).toBeLessThan(clear!.confidence);
    });
  });

  describe("unknown_subscription_event: genuine fallback only", () => {
    it("positive: a real signal with no matching bucket", () => {
      const r = detectSubscriptionEvent("You're all set", "your subscription is now active", "noreply@service.com", DATE);
      expect(r?.eventType).toBe("unknown_subscription_event");
    });

    it("edge case: a different unbucketed-but-real signal, confirming this isn't one lucky case", () => {
      const r = detectSubscriptionEvent("Billing starting soon", "your billing starts on Sept 1", "noreply@service.com", DATE);
      expect(r?.eventType).toBe("unknown_subscription_event");
    });
  });

  describe("baseline relevance gate (unchanged from Phase 2)", () => {
    it("returns null for a newsletter (no subscription-lifecycle signal at all)", () => {
      const r = detectSubscriptionEvent("What's new this week", "check out our weekly update and new features", "news@service.com", DATE);
      expect(r).toBeNull();
    });

    it("returns null for a shipping notification", () => {
      const r = detectSubscriptionEvent("Your order has shipped", "tracking number: 1Z999AA10123456784", "orders@shop.com", DATE);
      expect(r).toBeNull();
    });
  });
});

describe("scoreSubscriptionEventConfidence rules (Step 3, via detectSubscriptionEvent's output)", () => {
  const DATE = "Sat, 01 Aug 2026 00:00:00 GMT";

  it("explicit recurring language boosts confidence", () => {
    const withRecurring = detectSubscriptionEvent("Invoice", "your monthly subscription invoice, $9.99", "noreply@shop.com", DATE);
    const withoutRecurring = detectSubscriptionEvent("Invoice", "your invoice, $9.99 charged", "noreply@shop.com", DATE);
    expect(withRecurring!.confidence).toBeGreaterThan(withoutRecurring!.confidence);
  });

  it("a known billing sender domain boosts confidence", () => {
    const billingSender = detectSubscriptionEvent("Invoice", "your monthly subscription invoice, $9.99", "billing@shop.com", DATE);
    const genericSender = detectSubscriptionEvent("Invoice", "your monthly subscription invoice, $9.99", "hello@shop.com", DATE);
    expect(billingSender!.confidence).toBeGreaterThan(genericSender!.confidence);
  });

  it("price + billing interval both present boosts confidence more than price alone", () => {
    const withInterval = detectSubscriptionEvent("Invoice", "your monthly subscription invoice, $9.99/month", "noreply@shop.com", DATE);
    const priceOnly = detectSubscriptionEvent("Invoice", "your subscription invoice, $9.99, recurring", "noreply@shop.com", DATE);
    expect(withInterval!.confidence).toBeGreaterThan(priceOnly!.confidence);
  });

  it("a payment-processor sender with no resolvable merchant name is penalized vs. one with a clear merchant", () => {
    const clearMerchant = detectSubscriptionEvent("Receipt", "you subscribed to Canva Pro for $12.99, monthly", "receipts@stripe.com", DATE);
    const unclearMerchant = detectSubscriptionEvent("Receipt", "thanks for your payment of $12.99, monthly", "receipts@stripe.com", DATE);
    expect(clearMerchant!.confidence).toBeGreaterThan(unclearMerchant!.confidence);
  });

  it("no price detected is penalized vs. the same email with a price", () => {
    const withPrice = detectSubscriptionEvent("Invoice", "your monthly subscription invoice, $9.99", "billing@shop.com", DATE);
    const withoutPrice = detectSubscriptionEvent("Invoice", "your monthly subscription invoice is ready to view", "billing@shop.com", DATE);
    expect(withPrice!.confidence).toBeGreaterThan(withoutPrice!.confidence);
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

describe("Phase 3B.3.1: precision patch regression tests", () => {
  describe("1. Noise-domain exclusion at the sub-detector gate", () => {
    it("isKnownNoiseDomain: recognizes recalltrial.app", () => {
      expect(isKnownNoiseDomain("recalltrial.app")).toBe(true);
    });

    it("isKnownNoiseDomain: recognizes facebook.com and its known ad-billing subdomain", () => {
      expect(isKnownNoiseDomain("facebook.com")).toBe(true);
      expect(isKnownNoiseDomain("business-updates.facebook.com")).toBe(true);
    });

    it("isKnownNoiseDomain: does not flag an unrelated domain", () => {
      expect(isKnownNoiseDomain("spotify.com")).toBe(false);
    });

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

    it("end-to-end: a real Meta Ads receipt is excluded before classification, never written", async () => {
      mockGmailClient({
        from: "Meta for Business <noreply@business-updates.facebook.com>",
        subject: "Your Meta ads receipt (Account ID: 2234941693708795)",
        date: new Date().toUTCString(),
        snippet: "This is not an invoice. Transaction for SK2. Payment summary Amount billed $2.74 USD.",
      });
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      expect(storage.createSubscriptionEvent).not.toHaveBeenCalled();
    });

    it("end-to-end: RecallTrial's own reminder email is excluded before classification, never written", async () => {
      mockGmailClient({
        from: "RecallTrial <notifications@recalltrial.app>",
        subject: "[RecallTrial] YouTube Premium renews in 3 days",
        date: new Date().toUTCString(),
        snippet: "Your YouTube Premium subscription renews on: Aug 19, 2026. Renewal amount: 22.00 USD.",
      });
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      expect(storage.createSubscriptionEvent).not.toHaveBeenCalled();
    });

    it("end-to-end: a genuine, non-noise merchant is NOT excluded and is still written", async () => {
      mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      expect(storage.createSubscriptionEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. 'renew' word-family classification fix", () => {
    it("'to renew your Replit Core' (no 'subscription'/'renews'/other existing indicator) now correctly resolves as recurring, not ambiguous one_time_purchase", () => {
      // Deliberately isolated from "subscription" (already in
      // RECURRING_INDICATORS) so this test actually exercises the new
      // regex path rather than passing anyway via an existing keyword —
      // this is the real Google Play snippet shape from the precision
      // analysis, with "subscription" replaced to isolate the mechanism.
      // "Receipt" in the subject (also from the real email) is required
      // for the baseline relevance gate to pass at all — my first attempt
      // at this test dropped it and got a bare `null` back, not a
      // resolver bug, just an under-specified test input.
      const r = detectSubscriptionEvent(
        "Your Google Play Order Receipt",
        "we had trouble using your primary payment method to renew your Replit Core, backup payment method charged",
        "googleplay-noreply@google.com",
        "Sat, 01 Aug 2026 00:00:00 GMT"
      );
      expect(r?.eventType).toBe("subscription_invoice");
    });

    it("also matches 'renewing' — a word form NOT already covered by the existing RENEWAL_WARNING_PHRASES bucket", () => {
      // NOT testing "renewal" here: that bare word is already in
      // RENEWAL_WARNING_PHRASES (checked earlier in the classification
      // chain than the branch hasRecurringLanguage() lives in), so it can
      // never actually reach this code path — it would always resolve via
      // that earlier bucket regardless of this fix, making it an
      // impossible/moot case to test at this specific branch.
      const r = detectSubscriptionEvent(
        "Your receipt",
        "we are renewing your plan for another term, $9.99 charged",
        "billing@service.com",
        "Sat, 01 Aug 2026 00:00:00 GMT"
      );
      expect(r?.eventType).toBe("subscription_invoice");
    });
  });

  describe("3. Payment-failure phrase expansion", () => {
    it("'payment was unsuccessful' (the real Anthropic wording) now correctly resolves as payment_failed", () => {
      const r = detectSubscriptionEvent(
        "Your subscription access has been paused",
        "Your subscription access has been paused. Your most recent payment was unsuccessful, and your access has been paused.",
        "no-reply@mail.anthropic.com",
        "Sat, 01 Aug 2026 00:00:00 GMT"
      );
      expect(r?.eventType).toBe("payment_failed");
    });

    it("'charge failed' also resolves as payment_failed", () => {
      const r = detectSubscriptionEvent("Payment issue", "your charge failed, please update your billing details", "billing@service.com", "Sat, 01 Aug 2026 00:00:00 GMT");
      expect(r?.eventType).toBe("payment_failed");
    });
  });

  describe("4. trial_ending checked before trial_started", () => {
    it("'trial ends soon' + 'free trial started' recap (the real Sell The Trend email) now correctly resolves as trial_ending, not trial_started", () => {
      const r = detectSubscriptionEvent(
        "Your Sell The Trend trial ends soon",
        "Your free trial with Sell The Trend started on Jul 11, 2026 and will end on July 25, 2026",
        "trial-ending@sellthetrend.com",
        "Sat, 01 Aug 2026 00:00:00 GMT"
      );
      expect(r?.eventType).toBe("trial_ending");
    });

    it("a pure trial-started email with no ending language still correctly resolves as trial_started", () => {
      const r = detectSubscriptionEvent("Welcome", "your free trial has started, enjoy!", "billing@service.com", "Sat, 01 Aug 2026 00:00:00 GMT");
      expect(r?.eventType).toBe("trial_started");
    });
  });

  describe("5. isSubscriptionEvidence architecture guard", () => {
    it("returns false for one_time_purchase", () => {
      expect(isSubscriptionEvidence("one_time_purchase")).toBe(false);
    });

    it("returns true for every other event type", () => {
      for (const t of [
        "subscription_invoice", "subscription_renewed", "trial_started", "trial_ending",
        "subscription_cancelled", "payment_failed", "price_changed", "unknown_subscription_event",
      ] as const) {
        expect(isSubscriptionEvidence(t)).toBe(true);
      }
    });
  });
});
