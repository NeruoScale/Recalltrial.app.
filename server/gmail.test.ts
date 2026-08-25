import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Step 6: verify failure isolation in the REAL scanGmailForTrials() code
// path (not a refactor/extraction) — mock googleapis so no network call
// happens, and mock the dynamically-imported ./storage so the subscription
// detector's write can be forced to throw on demand.
// generateAuthUrl is a vi.fn() that echoes its own input back inside the
// "url" it returns (encoded as JSON) — every OAuth2 instance the mock
// constructs gets its OWN generateAuthUrl mock (matching the real
// per-call `new google.auth.OAuth2(...)` pattern gmail.ts uses), so tests
// that need to inspect what was actually requested (Account Isolation
// architecture, PHASE B's scope verification) can decode the returned
// string directly rather than needing a shared mock-call-history reference.
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        generateAuthUrl: vi.fn((opts: any) => `https://accounts.google.com/mock-auth?data=${encodeURIComponent(JSON.stringify(opts))}`),
      })),
    },
    gmail: vi.fn(),
  },
}));

vi.mock("./storage", () => ({
  storage: { createSubscriptionEvent: vi.fn(), queueAIEnrichmentJob: vi.fn() },
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
  listMessages,
  extractBillingInterval,
  buildScanTimeFilter,
  getMaxScanMessages,
  fetchMessageBody,
  extractCancellationUrl,
  extractNextBillingDate,
  extractSubscriptionId,
  generateAuthUrl,
} from "./gmail";

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

// Account Isolation architecture, PHASE B — Gmail Connection Identity
// Verification: generateAuthUrl() must request openid+email ALONGSIDE the
// existing gmail.readonly scope (never instead of it), so exchangeCodeForTokens()
// can decode a real id_token. state must still carry the RecallTrial userId
// (CSRF binding for the callback), unchanged from before this phase.
describe("Account Isolation PHASE B: generateAuthUrl() requests openid+email alongside gmail.readonly", () => {
  it("scope includes gmail.readonly, openid, and email — all three, none removed", () => {
    const url = generateAuthUrl("user-123");
    const encoded = new URL(url).searchParams.get("data")!;
    const opts = JSON.parse(decodeURIComponent(encoded));
    expect(opts.scope).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(opts.scope).toContain("openid");
    expect(opts.scope).toContain("email");
  });

  it("state still carries the RecallTrial userId (CSRF binding for the callback), unchanged", () => {
    const url = generateAuthUrl("user-123");
    const encoded = new URL(url).searchParams.get("data")!;
    const opts = JSON.parse(decodeURIComponent(encoded));
    expect(opts.state).toBe("user-123");
  });

  it("still requests offline access + forced consent, unchanged — needed for a real refresh_token every time", () => {
    const url = generateAuthUrl("user-123");
    const encoded = new URL(url).searchParams.get("data")!;
    const opts = JSON.parse(decodeURIComponent(encoded));
    expect(opts.access_type).toBe("offline");
    expect(opts.prompt).toBe("consent");
  });
});

// Given email input -> detector -> expected structured output.
// These are the pure, side-effect-free functions scanGmailForTrials() composes;
// no Gmail API calls, no DB, no network involved anywhere in this file.

const RECEIVED = new Date("2026-08-01T00:00:00.000Z");

// extractDate()'s explicit-date resolution rolls a past calendar date
// forward to next year based on the REAL wall-clock "today" (see
// resolveFutureCalendarDate() in gmail.ts) — not on RECEIVED, and not on
// anything else the test controls. A hardcoded date string ("Aug 20,
// 2026") eventually becomes a past date and starts failing for reasons
// completely unrelated to any code change. futureTestDate() sidesteps this
// permanently by computing a date genuinely ahead of whatever "today"
// happens to be when the suite runs, so resolveFutureCalendarDate() never
// has a reason to roll it forward.
const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function futureTestDate(daysAhead: number): { display: string; iso: string } {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth();
  const d = target.getUTCDate();
  return {
    display: `${MONTH_NAMES_SHORT[m]} ${d}, ${y}`,
    iso: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

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
    const { display, iso } = futureTestDate(30);
    const { date, source } = extractDate(`your subscription renews on ${display}`, RECEIVED);
    expect(source).toBe("explicit");
    expect(date).toBe(iso);
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

    const { suggestions: results } = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

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
    const { suggestions: withSuccess } = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

    mockGmailClient(message);
    (storage.createSubscriptionEvent as any).mockRejectedValue(new Error("simulated DB failure"));
    const { suggestions: withFailure } = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

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

    // Noise-filter-gap bugfix: this same RecallTrial reminder email was
    // previously ALSO slipping through the ORIGINAL trial-suggestion
    // pipeline (a completely separate code path from the sub-detector
    // above, whose own filters — hasSoftNegative/passesReceiptFilter/
    // hasStrongPositive/hasRequiredTrigger — never looked at sender domain
    // at all) and being suggested as a trial for "Recalltrial" itself. The
    // noise-domain check now runs once, before either pipeline, so both are
    // covered by the same guarantee.
    it("end-to-end: RecallTrial's own reminder email produces NO trial suggestion either (the original bug)", async () => {
      mockGmailClient({
        from: "RecallTrial <notifications@recalltrial.app>",
        subject: "[RecallTrial] YouTube Premium renews in 3 days",
        date: new Date().toUTCString(),
        snippet: "Your YouTube Premium subscription renews on: Aug 19, 2026. Renewal amount: 22.00 USD.",
      });

      const { suggestions } = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      expect(suggestions).toHaveLength(0);
    });

    it("end-to-end: a noise-domain sender is excluded even when userId is not provided (trial-only scan path)", async () => {
      mockGmailClient({
        from: "RecallTrial <notifications@recalltrial.app>",
        subject: "[RecallTrial] YouTube Premium renews in 3 days",
        date: new Date().toUTCString(),
        snippet: "Your YouTube Premium subscription renews on: Aug 19, 2026. Renewal amount: 22.00 USD.",
      });

      const { suggestions } = await scanGmailForTrials("fake-access-token", null, null);

      expect(suggestions).toHaveLength(0);
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

describe("Phase 3B.7.2: Gmail scan reliability (pagination, completeness, incremental)", () => {
  function fakeGmailList(pages: Array<{ ids: string[]; nextPageToken?: string }>) {
    const list = vi.fn();
    for (const page of pages) {
      list.mockResolvedValueOnce({
        data: {
          messages: page.ids.map((id) => ({ id })),
          nextPageToken: page.nextPageToken,
        },
      });
    }
    return { users: { messages: { list } } } as any;
  }

  describe("1A. listMessages() pagination — no silent truncation", () => {
    it("501 messages across 2 pages: pagination continues, nothing is truncated", async () => {
      const page1Ids = Array.from({ length: 500 }, (_, i) => `msg-${i}`);
      const page2Ids = ["msg-500"];
      const gmail = fakeGmailList([
        { ids: page1Ids, nextPageToken: "page-2" },
        { ids: page2Ids, nextPageToken: undefined },
      ]);

      const result = await listMessages(gmail, "some query", 5000, "A");

      expect(result.ids).toHaveLength(501);
      expect(result.totalAvailable).toBe(501);
      expect(result.scanComplete).toBe(true);
      expect(gmail.users.messages.list).toHaveBeenCalledTimes(2);
    });

    it("multiple Gmail API pages (3 pages) are all fetched, not just the first", async () => {
      const gmail = fakeGmailList([
        { ids: Array.from({ length: 500 }, (_, i) => `a-${i}`), nextPageToken: "p2" },
        { ids: Array.from({ length: 500 }, (_, i) => `b-${i}`), nextPageToken: "p3" },
        { ids: Array.from({ length: 50 }, (_, i) => `c-${i}`), nextPageToken: undefined },
      ]);

      const result = await listMessages(gmail, "some query", 5000, "B");

      expect(result.ids).toHaveLength(1050);
      expect(result.totalAvailable).toBe(1050);
      expect(result.scanComplete).toBe(true);
      expect(gmail.users.messages.list).toHaveBeenCalledTimes(3);
    });

    it("hitting the safety limit stops collecting but still reports an EXACT total and scanComplete=false, never silently truncating", async () => {
      const gmail = fakeGmailList([
        { ids: Array.from({ length: 6 }, (_, i) => `x-${i}`), nextPageToken: "p2" },
        { ids: Array.from({ length: 6 }, (_, i) => `y-${i}`), nextPageToken: undefined },
      ]);

      const result = await listMessages(gmail, "some query", 10, "A");

      expect(result.ids).toHaveLength(10); // capped
      expect(result.totalAvailable).toBe(12); // exact count, kept paginating past the cap to get it
      expect(result.scanComplete).toBe(false);
    });
  });

  describe("1B. getMaxScanMessages() — explicit, configurable safety limit", () => {
    const originalEnv = process.env.MAX_SCAN_MESSAGES;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.MAX_SCAN_MESSAGES;
      else process.env.MAX_SCAN_MESSAGES = originalEnv;
    });

    it("defaults to 5000 when MAX_SCAN_MESSAGES is unset", () => {
      delete process.env.MAX_SCAN_MESSAGES;
      expect(getMaxScanMessages()).toBe(5000);
    });

    it("respects an explicit MAX_SCAN_MESSAGES override", () => {
      process.env.MAX_SCAN_MESSAGES = "1200";
      expect(getMaxScanMessages()).toBe(1200);
    });

    it("falls back to the default on a garbage value", () => {
      process.env.MAX_SCAN_MESSAGES = "not-a-number";
      expect(getMaxScanMessages()).toBe(5000);
    });
  });

  describe("1C. buildScanTimeFilter() — incremental query construction", () => {
    it("first scan (lastEmailScanAt null) uses the existing 90-day window", () => {
      expect(buildScanTimeFilter(null)).toBe("newer_than:90d");
      expect(buildScanTimeFilter(undefined)).toBe("newer_than:90d");
    });

    it("subsequent scan uses after: with a 1-day overlap, not the raw scan date", () => {
      // lastEmailScanAt = Aug 19 -> overlap day = Aug 18, so any message from
      // the 18th gets safely re-fetched (idempotent) rather than risking a
      // gap from Gmail's after: being date-, not timestamp-, granular.
      expect(buildScanTimeFilter(new Date("2026-08-19T10:00:00Z"))).toBe("after:2026/08/18");
    });

    it("correctly rolls back across a year boundary", () => {
      expect(buildScanTimeFilter(new Date("2026-01-01T00:00:00Z"))).toBe("after:2025/12/31");
    });

    it("messages exactly at the 90-day boundary: first-scan query string still includes the full window, unaltered", () => {
      // The 90-day cutoff itself is Gmail's own server-side newer_than:90d
      // evaluation, not something this codebase computes — what's testable
      // here is that the first-scan query is passed through exactly, so nothing
      // in the incremental-scan change narrows the window for a first-time scan.
      expect(buildScanTimeFilter(null)).toContain("newer_than:90d");
    });
  });

  describe("1B/1C. scanGmailForTrials() end-to-end: completeness + incremental scanning", () => {
    function mockGmailClient(message: { from: string; subject: string; date: string; snippet: string }, listImpl?: any) {
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
      const messagesList = listImpl || vi.fn().mockResolvedValue({
        data: { messages: [{ id: "msg-1" }], nextPageToken: undefined },
      });
      (google.gmail as any).mockReturnValue({
        users: { messages: { list: messagesList, get: messagesGet } },
      });
      return messagesList;
    }

    beforeEach(() => {
      vi.clearAllMocks();
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);
    });

    it("a first-time scan (lastEmailScanAt=null) queries with newer_than:90d", async () => {
      const messagesList = mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null);

      const queriesUsed = messagesList.mock.calls.map((c: any[]) => c[0].q as string);
      expect(queriesUsed.every((q: string) => q.startsWith("newer_than:90d"))).toBe(true);
    });

    it("a subsequent scan (lastEmailScanAt set) queries with after:, not newer_than:90d — and still picks up the new message", async () => {
      const messagesList = mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });

      const lastScan = new Date("2026-08-15T00:00:00Z");
      const result = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", lastScan);

      const queriesUsed = messagesList.mock.calls.map((c: any[]) => c[0].q as string);
      expect(queriesUsed.every((q: string) => q.startsWith("after:2026/08/14"))).toBe(true);
      expect(queriesUsed.every((q: string) => !q.includes("newer_than:90d"))).toBe(true);

      // The new message returned by the incremental-scoped query still flows
      // all the way through the pipeline.
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].messageId).toBe("msg-1");
    });

    it("repeated hourly scan of the same message feeds IDENTICAL data into the write path both times (idempotency precondition)", async () => {
      const message = {
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date("2026-08-01T12:00:00Z").toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      };

      mockGmailClient(message);
      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null);
      const firstCallArgs = (storage.createSubscriptionEvent as any).mock.calls[0][0];

      vi.clearAllMocks();
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);
      mockGmailClient(message);
      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null);
      const secondCallArgs = (storage.createSubscriptionEvent as any).mock.calls[0][0];

      // Same message, same classifier inputs -> the scan layer must hand the
      // DB layer byte-identical data on every re-scan. decideCanonicalization()
      // (Phase 3B.5) is what actually turns that into "no duplicate row" —
      // this test locks in the scan layer's half of that guarantee.
      expect(secondCallArgs).toEqual(firstCallArgs);
    });

    // Account Isolation architecture, PHASE C — Gmail Connection Identity
    // Verification: the emailConnectionId captured at scan start (routes.ts's
    // POST /api/gmail/scan) must be stamped onto every event this scan writes.
    it("emailConnectionId (7th param) is threaded through into every subscription_events write", async () => {
      mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, false, "connection-abc-123");

      expect(storage.createSubscriptionEvent).toHaveBeenCalledTimes(1);
      const writeArg = (storage.createSubscriptionEvent as any).mock.calls[0][0];
      expect(writeArg.emailConnectionId).toBe("connection-abc-123");
    });

    it("omitting emailConnectionId (a user who hasn't reconnected since PHASE C shipped) writes emailConnectionId=null, never undefined or a fabricated value", async () => {
      mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      const writeArg = (storage.createSubscriptionEvent as any).mock.calls[0][0];
      expect(writeArg.emailConnectionId).toBeNull();
    });

    it("reports scan-completeness fields on the returned ScanResult", async () => {
      mockGmailClient({
        from: "billing@service.com",
        subject: "Your trial ends in 3 days",
        date: new Date().toUTCString(),
        snippet: "your trial ends in 3 days, you will be charged $9.99",
      });

      const result = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      expect(result.scanComplete).toBe(true);
      expect(result.messagesRemaining).toBe(0);
      expect(result.messagesFound).toBeGreaterThan(0);
      expect(result.messagesProcessed).toBe(result.messagesFound);
      expect(result.scanStartedAt).toBeInstanceOf(Date);
      expect(result.scanCompletedAt).toBeInstanceOf(Date);
      expect(result.scanCompletedAt.getTime()).toBeGreaterThanOrEqual(result.scanStartedAt.getTime());
    });
  });
});

describe("Phase 3B.9.2A: extractBillingInterval()", () => {
  it("'$19.99/month' -> monthly", () => {
    expect(extractBillingInterval("Your subscription is $19.99/month, charged to your card on file.")).toBe("monthly");
  });

  it("'$19.99 per month' -> monthly", () => {
    expect(extractBillingInterval("You will be charged $19.99 per month for this subscription.")).toBe("monthly");
  });

  it("'billed monthly' -> monthly", () => {
    expect(extractBillingInterval("Your plan is billed monthly. Next charge: $9.99.")).toBe("monthly");
  });

  it("'$139/year' -> annual", () => {
    expect(extractBillingInterval("Your subscription renews at $139/year.")).toBe("annual");
  });

  it("'billed annually' -> annual", () => {
    expect(extractBillingInterval("Your plan is billed annually at $99.00.")).toBe("annual");
  });

  it("'every 3 months' -> quarterly", () => {
    expect(extractBillingInterval("Your card will be charged $29.99 every 3 months for this subscription.")).toBe("quarterly");
  });

  it("'every 6 months' -> semi_annual", () => {
    expect(extractBillingInterval("Your subscription is billed every 6 months at $59.99.")).toBe("semi_annual");
  });

  it("'weekly' (with billing context) -> weekly", () => {
    expect(extractBillingInterval("Your weekly subscription charge of $4.99 has been processed.")).toBe("weekly");
  });

  it("'every 2 weeks' -> biweekly", () => {
    expect(extractBillingInterval("You will be charged $14.99 every 2 weeks for your subscription.")).toBe("biweekly");
  });

  it("'monthly newsletter' -> null (false positive guard: bare word with NO billing context)", () => {
    expect(extractBillingInterval("Subscribe to our monthly newsletter for the latest news and updates.")).toBeNull();
  });

  it("'$20 payment received' -> null (price present, but no interval phrase at all)", () => {
    expect(extractBillingInterval("$20 payment received. Thank you for your purchase.")).toBeNull();
  });

  it("empty text -> null", () => {
    expect(extractBillingInterval("")).toBeNull();
  });

  it("missing/whitespace-only text -> null", () => {
    expect(extractBillingInterval("   ")).toBeNull();
  });

  it("additional false-positive guards: 'weekly digest' and 'quarterly report' with no billing context -> null", () => {
    expect(extractBillingInterval("Check out this week's weekly digest of top stories.")).toBeNull();
    expect(extractBillingInterval("Our quarterly report is now available to read.")).toBeNull();
  });

  it("bare word DOES count when other billing context co-occurs elsewhere in the message (not just adjacent)", () => {
    // Realistic shape: subject has no interval word, snippet has "annual" AND
    // separately mentions "subscription" — same message, not necessarily
    // adjacent text — still correctly extracted since context is message-wide.
    expect(extractBillingInterval("Your Acme subscription — annual plan confirmed, $120.00 charged.")).toBe("annual");
  });

  it("strong compound phrases are trusted even with no separate billing context word nearby", () => {
    expect(extractBillingInterval("$4.99/wk")).toBe("weekly");
  });

  it("detectSubscriptionEvent() end-to-end: billingInterval flows through into the candidate", () => {
    const candidate = detectSubscriptionEvent(
      "Your subscription renews soon",
      "Your Acme Pro plan renews on Sep 1, 2026. You'll be charged $19.99/month.",
      "billing@acme.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(candidate?.billingInterval).toBe("monthly");
  });

  it("detectSubscriptionEvent() end-to-end: no interval evidence -> billingInterval is null, never guessed from price", () => {
    const candidate = detectSubscriptionEvent(
      "Your receipt",
      "Payment received: $20.00. Thank you for your purchase.",
      "billing@service.com",
      "Sat, 01 Aug 2026 00:00:00 GMT"
    );
    expect(candidate?.billingInterval).toBeNull();
  });
});

describe("Phase 3B.9.7: full Gmail body extraction (Layer 2)", () => {
  function makeGmailClient(getImpl: (args: any) => Promise<any>) {
    const messagesGet = vi.fn().mockImplementation(getImpl);
    return { users: { messages: { get: messagesGet, list: vi.fn() } } };
  }

  describe("fetchMessageBody()", () => {
    it("returns plaintext from a text/plain part", async () => {
      const gmail = makeGmailClient(async () => ({
        data: {
          payload: {
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Your Anthropic subscription is now £15.00/month.") } },
            ],
          },
        },
      })) as any;

      const body = await fetchMessageBody(gmail, "msg-1");
      expect(body).toBe("Your Anthropic subscription is now £15.00/month.");
    });

    it("falls back to HTML to text when no text/plain part exists, preserving link URLs", async () => {
      const html = '<html><body><p>Renews monthly.</p><a href="https://example.com/cancel">Cancel subscription</a></body></html>';
      const gmail = makeGmailClient(async () => ({
        data: {
          payload: {
            parts: [
              { mimeType: "text/html", body: { data: b64url(html) } },
            ],
          },
        },
      })) as any;

      const body = await fetchMessageBody(gmail, "msg-1");
      expect(body).not.toBeNull();
      expect(body).not.toMatch(/<[^>]+>/);
      expect(body).toContain("Renews monthly");
      expect(body).toContain("https://example.com/cancel");
    });

    it("returns null gracefully when no body is available", async () => {
      const gmail = makeGmailClient(async () => ({ data: { payload: { parts: [] } } })) as any;
      const body = await fetchMessageBody(gmail, "msg-1");
      expect(body).toBeNull();
    });

    it("returns null gracefully when the Gmail API call throws", async () => {
      const gmail = makeGmailClient(async () => { throw new Error("network error"); }) as any;
      const body = await fetchMessageBody(gmail, "msg-1");
      expect(body).toBeNull();
    });

    it("truncates at MAX 8000 chars", async () => {
      const longText = "A".repeat(9000);
      const gmail = makeGmailClient(async () => ({
        data: { payload: { parts: [{ mimeType: "text/plain", body: { data: b64url(longText) } }] } },
      })) as any;

      const body = await fetchMessageBody(gmail, "msg-1");
      expect(body).not.toBeNull();
      expect(body!.length).toBe(8000);
    });
  });

  describe("extractAmount() with fullBodyText fallback", () => {
    it("finds £15.00 in body text when the snippet has no amount at all (the Anthropic case)", () => {
      const snippet = "your subscription details have been updated";
      const body = "Your Anthropic subscription is now billed at £15.00 per month.";
      const { amount, currency } = extractAmount(snippet, body);
      expect(amount).toBe("15.00");
      expect(currency).toBe("GBP");
    });

    it("prefers the snippet's own amount over the body when both are present", () => {
      const snippet = "you were charged $9.99 today";
      const body = "Historical note: your old plan was $19.99/month.";
      const { amount, currency } = extractAmount(snippet, body);
      expect(amount).toBe("9.99");
      expect(currency).toBe("USD");
    });

    it("supports the extended currency set (CHF, kr) via the body", () => {
      const chf = extractAmount("no amount here", "You are charged CHF 12.50 monthly.");
      expect(chf.amount).toBe("12.50");
      expect(chf.currency).toBe("CHF");
      const kr = extractAmount("no amount here", "Total: 199 kr per month.");
      expect(kr.currency).toBe("SEK");
    });
  });

  describe("extractBillingInterval() with fullBodyText fallback", () => {
    it("finds 'monthly' in body when the snippet has no interval evidence", () => {
      const snippet = "your subscription is active";
      const body = "You are billed monthly for this subscription, $9.99 charged today.";
      expect(extractBillingInterval(snippet, body)).toBe("monthly");
    });

    it("prefers the snippet's own interval over the body when both are present", () => {
      const snippet = "billed annually at $99.00";
      const body = "Note: this plan used to be billed monthly.";
      expect(extractBillingInterval(snippet, body)).toBe("annual");
    });
  });

  describe("extractDate() with fullBodyText fallback", () => {
    it("finds a renewal date in body when the snippet has none", () => {
      const receivedAt = new Date("2026-08-01T00:00:00Z");
      const snippet = "your account was updated";
      const body = "Your subscription renews on Sep 15, 2026.";
      const { date, source } = extractDate(snippet, receivedAt, body);
      expect(date).toBe("2026-09-15");
      expect(source).toBe("explicit");
    });
  });

  describe("extractCancellationUrl()", () => {
    it("finds a cancel URL in body text", () => {
      const body = "To cancel, visit https://example.com/account/cancel-subscription at any time.";
      expect(extractCancellationUrl("no url here", body)).toBe("https://example.com/account/cancel-subscription");
    });

    it("finds an unsubscribe URL preserved from an HTML link", async () => {
      const html = '<a href="https://mail.example.com/u/12345/unsubscribe">Unsubscribe</a>';
      const gmail = makeGmailClient(async () => ({
        data: { payload: { parts: [{ mimeType: "text/html", body: { data: b64url(html) } }] } },
      })) as any;
      const body = await fetchMessageBody(gmail, "msg-1");
      expect(extractCancellationUrl("no url here", body!)).toBe("https://mail.example.com/u/12345/unsubscribe");
    });

    it("returns null when no URL is present", () => {
      expect(extractCancellationUrl("your subscription renews soon")).toBeNull();
    });
  });

  describe("extractNextBillingDate()", () => {
    it("extracts an explicit next billing date phrase", () => {
      expect(extractNextBillingDate("Next billing date: Sep 1, 2026")).toBe("2026-09-01");
    });

    it("returns null when no explicit next-billing phrase is present", () => {
      expect(extractNextBillingDate("thanks for your purchase")).toBeNull();
    });
  });

  describe("extractSubscriptionId()", () => {
    it("extracts an explicit subscription/account identifier", () => {
      expect(extractSubscriptionId("Your Subscription ID: SUB-88421-XZ")).toBe("SUB-88421-XZ");
    });

    it("returns null when no identifier phrase is present", () => {
      expect(extractSubscriptionId("thanks for your purchase")).toBeNull();
    });
  });

  describe("detectSubscriptionEvent() with fullBodyText: provenance + graceful fallback", () => {
    it("reports amountSource/intervalSource = body when only the body supplied that field", () => {
      const candidate = detectSubscriptionEvent(
        "Your subscription",
        "your subscription is active",
        "billing@anthropic.com",
        "Sat, 01 Aug 2026 00:00:00 GMT",
        "Your Anthropic subscription renews monthly at £15.00. Next billing date: Sep 1, 2026."
      );
      expect(candidate?.extractedPrice).toBe("15.00");
      expect(candidate?.amountSource).toBe("body");
      expect(candidate?.billingInterval).toBe("monthly");
      expect(candidate?.intervalSource).toBe("body");
    });

    it("reports 'snippet' when the snippet alone already supplied the field", () => {
      const candidate = detectSubscriptionEvent(
        "Your receipt",
        "your monthly subscription invoice is ready, $9.99 charged",
        "billing@service.com",
        "Sat, 01 Aug 2026 00:00:00 GMT",
        "irrelevant body text with no billing info"
      );
      expect(candidate?.amountSource).toBe("snippet");
      expect(candidate?.intervalSource).toBe("snippet");
    });

    it("extraction still works identically when fullBodyText is null (snippet-only fallback, unchanged from pre-3B.9.7 behavior)", () => {
      const withoutBody = detectSubscriptionEvent(
        "Your receipt",
        "your monthly subscription invoice is ready, $9.99 charged",
        "billing@service.com",
        "Sat, 01 Aug 2026 00:00:00 GMT"
      );
      const withNullBody = detectSubscriptionEvent(
        "Your receipt",
        "your monthly subscription invoice is ready, $9.99 charged",
        "billing@service.com",
        "Sat, 01 Aug 2026 00:00:00 GMT",
        null
      );
      expect(withoutBody).toEqual(withNullBody);
      expect(withoutBody?.extractedPrice).toBe("9.99");
      expect(withoutBody?.amountSource).toBe("snippet");
    });

    it("amountSource/intervalSource are both null when nothing was found in either layer", () => {
      const candidate = detectSubscriptionEvent(
        "Your subscription is cancelled",
        "your subscription has been cancelled as requested",
        "billing@service.com",
        "Sat, 01 Aug 2026 00:00:00 GMT",
        "no price or interval info here"
      );
      expect(candidate?.amountSource).toBeNull();
      expect(candidate?.intervalSource).toBeNull();
    });
  });

  describe("Privacy: body content never appears in log output", () => {
    it("scanGmailForTrials() never logs the raw body text, even when it drives extraction", async () => {
      const SECRET_MARKER = "SECRET_BODY_CONTENT_MARKER_9f3a1c";
      const messagesGet = vi.fn().mockImplementation(async (args: any) => {
        if (args.format === "full") {
          return {
            data: {
              payload: {
                parts: [{
                  mimeType: "text/plain",
                  body: { data: b64url("Your subscription renews monthly at $19.99. Ref: " + SECRET_MARKER) },
                }],
              },
            },
          };
        }
        return {
          data: {
            payload: {
              headers: [
                { name: "From", value: "billing@service.com" },
                { name: "Subject", value: "Your trial ends in 3 days" },
                { name: "Date", value: new Date().toUTCString() },
              ],
            },
            snippet: "your trial ends in 3 days, you will be charged $9.99",
          },
        };
      });
      const messagesList = vi.fn().mockResolvedValue({ data: { messages: [{ id: "msg-1" }], nextPageToken: undefined } });
      (google.gmail as any).mockReturnValue({ users: { messages: { list: messagesList, get: messagesGet } } });
      (storage.createSubscriptionEvent as any).mockResolvedValue(true);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await scanGmailForTrials("fake-access-token", null, null, "fake-user-id");

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
        .join("\n");

      expect(allLoggedText).not.toContain(SECRET_MARKER);

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});

// ─── Phase 3B.9.9-BUGFIX: bodyFetched persistence + AI-eligibility wiring ──────
//
// Regression coverage for the body_fetched=false bug (server/storage.ts's
// buildSourceAwareConflictSet() was missing bodyFetched from its
// onConflictDoUpdate SET clause — fixed by OR-ing the existing and
// incoming values). These tests exercise the REAL end-to-end
// scanGmailForTrials() path (not a refactored extraction), asserting on
// exactly what gets passed to storage.createSubscriptionEvent() and
// storage.queueAIEnrichmentJob() — the two integration points the bug
// actually lived between. isEligibleForAI() itself is imported for real
// (not mocked) since it's a pure function with no DB/network dependency;
// only ./storage and googleapis are mocked.
describe("Phase 3B.9.9-BUGFIX: bodyFetched persistence and AI-eligibility wiring", () => {
  function mockGmailClientWithBody(
    message: { from: string; subject: string; date: string; snippet: string },
    bodyMode: "success" | "unavailable" | "throws",
    bodyText?: string
  ) {
    const messagesGet = vi.fn().mockImplementation(async (args: any) => {
      if (args.format === "full") {
        if (bodyMode === "throws") throw new Error("simulated Gmail API failure fetching full body");
        if (bodyMode === "unavailable") return { data: { payload: { parts: [] } } }; // no usable part -> fetchMessageBody() returns null
        return {
          data: {
            payload: {
              parts: [{ mimeType: "text/plain", body: { data: b64url(bodyText ?? "") } }],
            },
          },
        };
      }
      return {
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
      };
    });
    const messagesList = vi.fn().mockResolvedValue({ data: { messages: [{ id: "msg-1" }], nextPageToken: undefined } });
    (google.gmail as any).mockReturnValue({ users: { messages: { list: messagesList, get: messagesGet } } });
    return { messagesGet, messagesList };
  }

  function mockWrittenRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt-ai-1",
      userId: "fake-user-id",
      isCanonical: true,
      bodyFetched: true,
      extractedPrice: null,
      extractedCurrency: null,
      billingInterval: null,
      eventType: "subscription_invoice",
      canonicalMerchantDomain: "service.com",
      ...overrides,
    };
  }

  const AMBIGUOUS_MESSAGE = {
    from: "billing@service.com",
    subject: "Your subscription invoice",
    date: new Date().toUTCString(),
    snippet: "your monthly subscription invoice is ready to view",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("body successfully fetched -> event written with bodyFetched=true", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "success", "We couldn't determine your exact renewal amount this cycle.");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({ bodyFetched: true }));

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    expect(storage.createSubscriptionEvent).toHaveBeenCalledTimes(1);
    const writeArg = (storage.createSubscriptionEvent as any).mock.calls[0][0];
    expect(writeArg.bodyFetched).toBe(true);
  });

  it("body unavailable (fetchMessageBody returns null) -> event written with bodyFetched=false, no AI job queued", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "unavailable");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({ bodyFetched: false, extractedPrice: null }));

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    const writeArg = (storage.createSubscriptionEvent as any).mock.calls[0][0];
    expect(writeArg.bodyFetched).toBe(false);
    expect(storage.queueAIEnrichmentJob).not.toHaveBeenCalled();
  });

  it("body fetch failed/threw -> event written with bodyFetched=false, no AI job queued (never blocks the scan)", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "throws");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({ bodyFetched: false, extractedPrice: null }));

    const { suggestions } = await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    const writeArg = (storage.createSubscriptionEvent as any).mock.calls[0][0];
    expect(writeArg.bodyFetched).toBe(false);
    expect(storage.queueAIEnrichmentJob).not.toHaveBeenCalled();
    // The scan itself completes normally despite the body-fetch failure.
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it("a non-candidate email never attempts a body fetch, and createSubscriptionEvent is never called", async () => {
    const { messagesGet } = mockGmailClientWithBody(
      { from: "news@service.com", subject: "Weekly newsletter", date: new Date().toUTCString(), snippet: "check out this week's roundup of articles" },
      "success",
      "irrelevant"
    );

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    expect(messagesGet).not.toHaveBeenCalledWith(expect.objectContaining({ format: "full" }));
    expect(storage.createSubscriptionEvent).not.toHaveBeenCalled();
  });

  it("fully-resolved event (price+currency+interval all already known) -> AI job NOT created even with bodyFetched=true and AI enabled", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "success", "Your subscription is $9.99/month, billed monthly.");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({
      bodyFetched: true, extractedPrice: "9.99", extractedCurrency: "USD", billingInterval: "monthly",
    }));

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    expect(storage.queueAIEnrichmentJob).not.toHaveBeenCalled();
  });

  it("ambiguous body extraction (a field still missing) -> AI job IS created when aiScanningEnabled=true", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "success", "We couldn't determine your exact renewal amount this cycle.");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({
      bodyFetched: true, extractedPrice: null, extractedCurrency: null, billingInterval: "monthly",
    }));
    (storage.queueAIEnrichmentJob as any).mockResolvedValue(true);

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    expect(storage.queueAIEnrichmentJob).toHaveBeenCalledWith("fake-user-id", "evt-ai-1");
  });

  it("ambiguous body extraction, but aiScanningEnabled=false -> no AI job queued", async () => {
    mockGmailClientWithBody(AMBIGUOUS_MESSAGE, "success", "We couldn't determine your exact renewal amount this cycle.");
    (storage.createSubscriptionEvent as any).mockResolvedValue(mockWrittenRow({ bodyFetched: true, extractedPrice: null }));

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, false);

    expect(storage.queueAIEnrichmentJob).not.toHaveBeenCalled();
  });

  it("RecallTrial's own reminder email is excluded at the shared noise gate BEFORE any body fetch is attempted", async () => {
    const { messagesGet } = mockGmailClientWithBody(
      {
        from: "RecallTrial <notifications@recalltrial.app>",
        subject: "[RecallTrial] YouTube Premium renews in 3 days",
        date: new Date().toUTCString(),
        snippet: "Your YouTube Premium subscription renews on: Aug 19, 2026. Renewal amount: 22.00 USD.",
      },
      "success",
      "irrelevant"
    );

    await scanGmailForTrials("fake-access-token", null, null, "fake-user-id", null, true);

    expect(messagesGet).not.toHaveBeenCalledWith(expect.objectContaining({ format: "full" }));
    expect(storage.createSubscriptionEvent).not.toHaveBeenCalled();
    expect(storage.queueAIEnrichmentJob).not.toHaveBeenCalled();
  });
});
