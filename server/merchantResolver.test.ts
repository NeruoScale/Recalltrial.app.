import { describe, it, expect } from "vitest";
import { resolveMerchant, KNOWN_MERCHANTS, KNOWN_PROCESSORS } from "./merchantResolver";

const base = (overrides: Partial<Parameters<typeof resolveMerchant>[0]> = {}) => ({
  senderEmail: "noreply@example.com",
  senderDomain: "example.com",
  extractedMerchant: null,
  subject: "",
  snippet: "",
  eventType: "subscription_invoice",
  ...overrides,
});

describe("A. Domain normalization", () => {
  it("billing.spotify.com normalizes to spotify.com", () => {
    const r = resolveMerchant(base({ senderDomain: "billing.spotify.com" }));
    expect(r.canonicalMerchantDomain).toBe("spotify.com");
  });

  it("www.spotify.com and mail.spotify.com both collapse to the same canonical domain as billing.spotify.com", () => {
    const a = resolveMerchant(base({ senderDomain: "billing.spotify.com" }));
    const b = resolveMerchant(base({ senderDomain: "www.spotify.com" }));
    const c = resolveMerchant(base({ senderDomain: "mail.spotify.com" }));
    expect(a.canonicalMerchantDomain).toBe(b.canonicalMerchantDomain);
    expect(b.canonicalMerchantDomain).toBe(c.canonicalMerchantDomain);
    expect(a.canonicalMerchantName).toBe("Spotify");
  });
});

describe("B. Sender normalization", () => {
  it("noreply@spotify.com resolves to Spotify via its domain", () => {
    const r = resolveMerchant(base({ senderEmail: "noreply@spotify.com", senderDomain: "" }));
    expect(r.canonicalMerchantName).toBe("Spotify");
  });

  it("billing@netflix.com resolves to Netflix via its domain", () => {
    const r = resolveMerchant(base({ senderEmail: "billing@netflix.com", senderDomain: "" }));
    expect(r.canonicalMerchantName).toBe("Netflix");
  });
});

describe("C. Known merchant registry", () => {
  it("covers the minimum required merchants", () => {
    for (const domain of [
      "spotify.com", "netflix.com", "adobe.com", "apple.com", "google.com",
      "amazon.com", "youtube.com", "dropbox.com", "notion.so", "figma.com",
      "github.com", "slack.com", "zoom.us", "shopify.com", "bubble.io",
    ]) {
      expect(KNOWN_MERCHANTS[domain]).toBeTruthy();
    }
  });

  it("resolves a non-dual-role registry domain directly", () => {
    const r = resolveMerchant(base({ senderDomain: "figma.com" }));
    expect(r.canonicalMerchantName).toBe("Figma");
    expect(r.resolutionMethod).toBe("known_domain");
  });
});

describe("D. Payment processor registry", () => {
  it("covers the minimum required processors, including adyen.com", () => {
    for (const domain of [
      "stripe.com", "paypal.com", "paddle.com", "apple.com", "google.com",
      "gumroad.com", "fastspring.com", "lemonsqueezy.com", "chargebee.com",
      "recurly.com", "braintree.com", "2checkout.com", "klarna.com", "adyen.com",
    ]) {
      expect(KNOWN_PROCESSORS[domain]).toBeTruthy();
    }
  });

  it("apple.com and google.com appear in both registries (explicit dual-role acknowledgment)", () => {
    expect(KNOWN_MERCHANTS["apple.com"]).toBeTruthy();
    expect(KNOWN_PROCESSORS["apple.com"]).toBeTruthy();
    expect(KNOWN_MERCHANTS["google.com"]).toBeTruthy();
    expect(KNOWN_PROCESSORS["google.com"]).toBeTruthy();
  });
});

describe("E. Resolution hierarchy — each method, 2+ cases", () => {
  describe("explicit_text_match", () => {
    it("finds a known merchant name in the body of a processor-routed email", () => {
      const r = resolveMerchant(base({
        senderDomain: "stripe.com",
        subject: "Your receipt",
        snippet: "Thanks for your payment. Your Adobe Creative Cloud subscription is confirmed.",
      }));
      expect(r.resolutionMethod).toBe("explicit_text_match");
      expect(r.canonicalMerchantName).toBe("Adobe");
      expect(r.paymentProcessor).toBe("Stripe");
    });

    it("finds a known merchant name in the subject line even from an unrelated domain", () => {
      const r = resolveMerchant(base({
        senderDomain: "notifications.example.com",
        subject: "Your Slack workspace billing receipt",
        snippet: "Thanks for your payment.",
      }));
      expect(r.resolutionMethod).toBe("explicit_text_match");
      expect(r.canonicalMerchantName).toBe("Slack");
    });
  });

  describe("known_domain", () => {
    it("resolves a known merchant purely from its sending domain", () => {
      const r = resolveMerchant(base({ senderDomain: "netflix.com", snippet: "Your payment was successful." }));
      expect(r.resolutionMethod).toBe("known_domain");
      expect(r.canonicalMerchantName).toBe("Netflix");
    });

    it("resolves a different known merchant purely from its sending domain", () => {
      const r = resolveMerchant(base({ senderDomain: "github.com", snippet: "Your subscription receipt." }));
      expect(r.resolutionMethod).toBe("known_domain");
      expect(r.canonicalMerchantName).toBe("GitHub");
    });
  });

  describe("body_name+domain (processor domain + clear body extraction)", () => {
    it("extracts a third-party merchant name from a Stripe-routed receipt", () => {
      const r = resolveMerchant(base({
        senderDomain: "stripe.com",
        snippet: "You subscribed to Canva Pro for $12.99/month.",
      }));
      expect(r.resolutionMethod).toBe("body_name+domain");
      expect(r.canonicalMerchantName?.toLowerCase()).toContain("canva");
      expect(r.paymentProcessor).toBe("Stripe");
    });

    it("extracts a third-party merchant name from a PayPal-routed receipt", () => {
      // Deliberately NOT a KNOWN_MERCHANTS name (unlike "Bubble", which IS
      // registered and would correctly hit explicit_text_match first) —
      // this needs to be a name resolveServiceName() finds only via body
      // regex, to actually exercise the body_name+domain path.
      const r = resolveMerchant(base({
        senderDomain: "paypal.com",
        snippet: "Your payment to Grammarly was successful.",
      }));
      expect(r.resolutionMethod).toBe("body_name+domain");
      expect(r.canonicalMerchantName?.toLowerCase()).toContain("grammarly");
      expect(r.paymentProcessor).toBe("PayPal");
    });
  });

  describe("sender_domain_fallback (unrecognized, non-processor domain)", () => {
    it("falls back to a title-cased domain guess for an unrecognized merchant", () => {
      const r = resolveMerchant(base({ senderDomain: "somesaasapp.io" }));
      expect(r.resolutionMethod).toBe("sender_domain_fallback");
      expect(r.canonicalMerchantName).toBe("Somesaasapp");
      expect(r.merchantResolutionStatus).toBe("resolved");
    });

    it("does the same for a different unrecognized domain", () => {
      const r = resolveMerchant(base({ senderDomain: "billing.anothertool.com" }));
      expect(r.resolutionMethod).toBe("sender_domain_fallback");
      expect(r.canonicalMerchantDomain).toBe("anothertool.com");
    });
  });

  describe("weak_text_match (processor domain, no clear body extraction) -> ambiguous", () => {
    it("flags ambiguous when a processor sends but no merchant name can be extracted", () => {
      const r = resolveMerchant(base({ senderDomain: "stripe.com", snippet: "Your payment was processed successfully." }));
      expect(r.resolutionMethod).toBe("weak_text_match");
      expect(r.merchantResolutionStatus).toBe("ambiguous");
      expect(r.paymentProcessor).toBe("Stripe");
      expect(r.canonicalMerchantName).toBeNull();
    });

    it("does the same for a different processor with unextractable body text", () => {
      const r = resolveMerchant(base({ senderDomain: "braintree.com", snippet: "Payment confirmed." }));
      expect(r.resolutionMethod).toBe("weak_text_match");
      expect(r.merchantResolutionStatus).toBe("ambiguous");
      expect(r.paymentProcessor).toBe("Braintree");
    });
  });

  describe("none (no usable domain) -> unknown", () => {
    it("returns unknown when there is no domain to work with at all", () => {
      const r = resolveMerchant(base({ senderDomain: "", senderEmail: "malformed" }));
      expect(r.resolutionMethod).toBe("none");
      expect(r.merchantResolutionStatus).toBe("unknown");
      expect(r.merchantConfidence).toBe(0);
    });

    it("is consistent (unknown, not a crash) for a second malformed input", () => {
      const r = resolveMerchant(base({ senderDomain: "", senderEmail: "" }));
      expect(r.merchantResolutionStatus).toBe("unknown");
    });
  });
});

describe("apple.com / google.com dual-role handling (explicit, per Step 2D)", () => {
  it("apple_google_direct: an Apple-branded email with no third-party name is the direct merchant", () => {
    const r = resolveMerchant(base({
      senderDomain: "apple.com",
      subject: "Your Apple subscription receipt",
      snippet: "Your Apple Music subscription has renewed for $10.99.",
    }));
    expect(r.resolutionMethod).toBe("apple_google_direct");
    expect(r.canonicalMerchantName).toBe("Apple");
    expect(r.paymentProcessor).toBeNull();
  });

  it("apple_google_direct: same for Google", () => {
    const r = resolveMerchant(base({
      senderDomain: "google.com",
      subject: "Your Google One receipt",
      snippet: "Your Google storage subscription has renewed.",
    }));
    expect(r.resolutionMethod).toBe("apple_google_direct");
    expect(r.canonicalMerchantName).toBe("Google");
  });

  it("apple_google_as_processor: App Store billing on behalf of a third-party app", () => {
    const r = resolveMerchant(base({
      senderDomain: "apple.com",
      subject: "Your receipt from Apple",
      snippet: "You subscribed to Streaks Workout for $4.99/month.",
    }));
    expect(r.resolutionMethod).toBe("apple_google_as_processor");
    expect(r.canonicalMerchantName?.toLowerCase()).toContain("streaks");
    expect(r.paymentProcessor).toBe("Apple");
  });

  it("apple_google_as_processor: Play Store billing on behalf of a third-party app", () => {
    const r = resolveMerchant(base({
      senderDomain: "google.com",
      subject: "Your receipt from Google Play",
      snippet: "You subscribed to Focus Timer for $2.99/month.",
    }));
    expect(r.resolutionMethod).toBe("apple_google_as_processor");
    expect(r.canonicalMerchantName?.toLowerCase()).toContain("focus timer");
    expect(r.paymentProcessor).toBe("Google");
  });

  it("apple_google_ambiguous: neither a third-party name nor Apple's own brand is mentioned", () => {
    const r = resolveMerchant(base({
      senderDomain: "apple.com",
      subject: "Receipt",
      snippet: "Your payment was processed.",
    }));
    expect(r.resolutionMethod).toBe("apple_google_ambiguous");
    expect(r.merchantResolutionStatus).toBe("ambiguous");
    expect(r.paymentProcessor).toBe("Apple");
  });
});

describe("Processor-vs-merchant distinction (explicit)", () => {
  it("a processor-routed receipt populates BOTH canonicalMerchantName and paymentProcessor, correctly distinct", () => {
    const r = resolveMerchant(base({ senderDomain: "stripe.com", snippet: "You subscribed to Canva Pro for $12.99/month." }));
    expect(r.canonicalMerchantName?.toLowerCase()).toContain("canva");
    expect(r.paymentProcessor).toBe("Stripe");
    expect(r.canonicalMerchantName).not.toBe(r.paymentProcessor);
  });

  it("a direct-merchant email has a null paymentProcessor — the merchant IS the sender, not routed through one", () => {
    const r = resolveMerchant(base({ senderDomain: "netflix.com", snippet: "Your payment was successful." }));
    expect(r.canonicalMerchantName).toBe("Netflix");
    expect(r.paymentProcessor).toBeNull();
  });

  it("an unresolvable processor email still correctly identifies the processor even without a merchant", () => {
    const r = resolveMerchant(base({ senderDomain: "stripe.com", snippet: "Payment processed." }));
    expect(r.paymentProcessor).toBe("Stripe");
    expect(r.canonicalMerchantName).toBeNull();
  });
});

describe("F. Purity / determinism", () => {
  it("the same input always produces an identical result", () => {
    const input = base({ senderDomain: "stripe.com", snippet: "You subscribed to Canva Pro for $12.99/month.", extractedMerchant: "Canva" });
    const a = resolveMerchant(input);
    const b = resolveMerchant(input);
    expect(a).toEqual(b);
  });

  it("rawMerchantName preserves the originally-extracted evidence even when canonical resolution differs from it", () => {
    const r = resolveMerchant(base({ senderDomain: "billing.spotify.com", extractedMerchant: "Spotify Premium Billing Dept" }));
    expect(r.rawMerchantName).toBe("Spotify Premium Billing Dept");
    expect(r.canonicalMerchantName).toBe("Spotify");
  });

  it("eventType never influences the resolution outcome", () => {
    const withInvoiceType = resolveMerchant(base({ senderDomain: "netflix.com", eventType: "subscription_invoice" }));
    const withUnknownType = resolveMerchant(base({ senderDomain: "netflix.com", eventType: "unknown_subscription_event" }));
    expect(withInvoiceType).toEqual(withUnknownType);
  });
});
