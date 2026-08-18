// ─── Merchant & payment processor normalization (Phase 3B.3) ───────────────────
//
// Converts inconsistent merchant representations (billing.spotify.com,
// www.spotify.com, a Stripe-routed receipt mentioning "Spotify" in the body,
// a bare unrecognized domain) into a stable canonical identity, while always
// preserving the raw evidence it started from.
//
// This module does NOT decide whether something is a subscription — it only
// answers "who is this from." eventType is accepted as an input for context/
// future use but never branches any resolution decision here, on purpose
// (that boundary belongs to detectSubscriptionEvent() in gmail.ts).
//
// Reuses gmail.ts's existing pure helpers rather than duplicating them:
// resolveServiceName() (body-text merchant extraction for processor-routed
// snippets), getRootDomain() (eTLD+1 reduction — already handles common
// two-part TLDs like co.uk/com.au, not naive last-two-labels splitting),
// extractDomainFromEmail(), and hasClearProcessorMerchant() (did
// resolveServiceName() find a genuine regex match, or fall back to
// title-casing the processor's own domain).
//
// Every result is pure/deterministic — no randomness, no I/O, no wall-clock
// dependency — same input always produces the same output.

import { resolveServiceName, getRootDomain, extractDomainFromEmail, hasClearProcessorMerchant } from "./gmail";

export type MerchantResolverInput = {
  senderEmail: string;
  senderDomain: string;
  extractedMerchant: string | null;
  subject: string;
  snippet: string;
  eventType: string; // accepted for context only — never used to decide resolution here
};

export type MerchantResolutionStatus = "resolved" | "ambiguous" | "unknown";

export type MerchantResolution = {
  rawMerchantName: string | null;
  canonicalMerchantName: string | null;
  canonicalMerchantDomain: string | null;
  paymentProcessor: string | null;
  merchantConfidence: number; // 0-100 — a distinct scale from event-classification confidence (0-95) elsewhere in this app; not directly comparable
  resolutionMethod: string;
  merchantResolutionStatus: MerchantResolutionStatus;
};

// ─── C. Known merchant registry ────────────────────────────────────────────────
// Hardcoded, version-controlled. Only what real production evidence and the
// explicit Phase 3B.3 instructions justify — not hundreds of speculative
// mappings. domain -> canonical display name.
export const KNOWN_MERCHANTS: Record<string, string> = {
  "spotify.com": "Spotify",
  "netflix.com": "Netflix",
  "adobe.com": "Adobe",
  "apple.com": "Apple",
  "google.com": "Google",
  "amazon.com": "Amazon",
  "youtube.com": "YouTube",
  "dropbox.com": "Dropbox",
  "notion.so": "Notion",
  "figma.com": "Figma",
  "github.com": "GitHub",
  "slack.com": "Slack",
  "zoom.us": "Zoom",
  "shopify.com": "Shopify",
  "bubble.io": "Bubble",
};

// ─── D. Payment processor registry (separate from merchants) ──────────────────
// domain -> canonical display name. A dedicated registry rather than reusing
// gmailKeywords.ts's PAYMENT_PROCESSOR_DOMAINS Set: that Set is a boolean
// membership check with no display names attached (wrong shape for
// `paymentProcessor: string`), and this list needs one more domain
// (adyen.com) than that set currently has. gmailKeywords.ts is left
// untouched per the Phase 3B.3 boundary — this is a new, self-contained
// registry, not a modification of the existing one.
export const KNOWN_PROCESSORS: Record<string, string> = {
  "stripe.com": "Stripe",
  "paypal.com": "PayPal",
  "paddle.com": "Paddle",
  "apple.com": "Apple",
  "google.com": "Google",
  "gumroad.com": "Gumroad",
  "fastspring.com": "FastSpring",
  "lemonsqueezy.com": "Lemon Squeezy",
  "chargebee.com": "Chargebee",
  "recurly.com": "Recurly",
  "braintree.com": "Braintree",
  "2checkout.com": "2Checkout",
  "klarna.com": "Klarna",
  "adyen.com": "Adyen",
};

// apple.com and google.com deliberately appear in both registries above.
// Both companies have genuine direct-merchant relationships (Apple Music,
// Google One) AND genuine marketplace/processor relationships (App Store /
// Play Store billing on behalf of third-party apps) — this handles that
// ambiguity explicitly rather than picking one role arbitrarily.
const DUAL_ROLE_DOMAINS = new Set(["apple.com", "google.com"]);

function normalizeDomain(rawDomain: string): string {
  const lower = rawDomain.toLowerCase().trim().replace(/^www\./, "");
  return getRootDomain(lower);
}

function clamp0to100(n: number): number {
  return Math.min(Math.max(Math.round(n), 0), 100);
}

function findExplicitMerchantNameInText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [domain, name] of Object.entries(KNOWN_MERCHANTS)) {
    if (DUAL_ROLE_DOMAINS.has(domain)) continue; // handled separately, see resolveAppleGoogleAmbiguity
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

/**
 * apple.com/google.com dual-role handling, per Step 2D's explicit
 * instruction. Runs before the general hierarchy when the sender domain is
 * one of these two. Distinguishes "this IS Apple/Google as the merchant"
 * (e.g. an Apple Music or Google One email) from "Apple/Google is acting as
 * a marketplace processor for a third-party app" (resolveServiceName finds
 * a genuine third-party name in the body via its processor-pattern regexes).
 */
function resolveAppleGoogleAmbiguity(
  domain: string,
  subject: string,
  snippet: string
): MerchantResolution | null {
  if (!DUAL_ROLE_DOMAINS.has(domain)) return null;
  const registryName = KNOWN_MERCHANTS[domain]; // "Apple" or "Google"

  const bodyExtracted = resolveServiceName(domain, snippet);
  // Not a strict inequality: resolveServiceName() legitimately extracts
  // "Apple Music"/"Apple TV+"/"Google One"-style first-party product names
  // via its own-brand-subscription regex pattern, which would never exactly
  // equal the bare registry name "Apple"/"Google" but is still clearly
  // first-party, not a third-party app. Only treat it as a third party if
  // the extracted name has no textual relation to the brand at all.
  const foundThirdPartyName = hasClearProcessorMerchant(snippet) && !bodyExtracted.toLowerCase().includes(registryName.toLowerCase());

  if (foundThirdPartyName) {
    // A third-party app name was found in the body — Apple/Google is acting
    // as the marketplace processor here, not the merchant.
    return {
      rawMerchantName: bodyExtracted,
      canonicalMerchantName: bodyExtracted,
      canonicalMerchantDomain: null,
      paymentProcessor: registryName,
      merchantConfidence: 70,
      resolutionMethod: "apple_google_as_processor",
      merchantResolutionStatus: "resolved",
    };
  }

  const combined = (subject + " " + snippet).toLowerCase();
  const mentionsOwnBrand = combined.includes(registryName.toLowerCase());
  if (mentionsOwnBrand) {
    // No third-party name found, and the message itself names
    // Apple/Google directly — treat as the direct merchant relationship.
    return {
      rawMerchantName: registryName,
      canonicalMerchantName: registryName,
      canonicalMerchantDomain: domain,
      paymentProcessor: null,
      merchantConfidence: 75,
      resolutionMethod: "apple_google_direct",
      merchantResolutionStatus: "resolved",
    };
  }

  // Genuinely can't tell which role Apple/Google is playing here.
  return {
    rawMerchantName: registryName,
    canonicalMerchantName: null,
    canonicalMerchantDomain: null,
    paymentProcessor: registryName,
    merchantConfidence: 30,
    resolutionMethod: "apple_google_ambiguous",
    merchantResolutionStatus: "ambiguous",
  };
}

/**
 * resolveMerchant(): pure function, deterministic — see module header.
 * Evidence-based hierarchy (Step 2E):
 *   1. Explicit known-merchant name literally present in subject/body
 *   2. Known merchant domain mapping
 *   3/5. Processor domain -> resolveServiceName()'s body-text extraction
 *        (these two hierarchy steps from the spec collapse into one
 *        mechanism in practice: resolveServiceName() only attempts body
 *        extraction for processor domains in the first place, so "reuse
 *        resolveServiceName" and "processor-domain body extraction" are
 *        the same call, not two separate techniques — documented rather
 *        than artificially split into two near-identical code paths)
 *   4. Sender domain itself (non-processor only)
 *   6. Weak/no match -> ambiguous or unknown
 */
export function resolveMerchant(input: MerchantResolverInput): MerchantResolution {
  const domain = normalizeDomain(input.senderDomain || extractDomainFromEmail(input.senderEmail));
  const combinedText = `${input.subject} ${input.snippet}`;

  // apple.com/google.com dual role — handled first and separately.
  const dualRole = resolveAppleGoogleAmbiguity(domain, input.subject, input.snippet);
  if (dualRole) {
    return { ...dualRole, rawMerchantName: input.extractedMerchant ?? dualRole.rawMerchantName };
  }

  const isProcessorDomain = domain in KNOWN_PROCESSORS;
  const processorName = isProcessorDomain ? KNOWN_PROCESSORS[domain] : null;

  // 1. Explicit known-merchant name literally present in subject/body —
  // the strongest possible signal, checked regardless of sender domain
  // (a processor-routed receipt can still explicitly name the merchant).
  const explicitName = findExplicitMerchantNameInText(combinedText);
  if (explicitName) {
    const explicitDomain = Object.entries(KNOWN_MERCHANTS).find(([, name]) => name === explicitName)?.[0] ?? null;
    return {
      rawMerchantName: input.extractedMerchant ?? explicitName,
      canonicalMerchantName: explicitName,
      canonicalMerchantDomain: explicitDomain,
      paymentProcessor: processorName,
      merchantConfidence: clamp0to100(90),
      resolutionMethod: "explicit_text_match",
      merchantResolutionStatus: "resolved",
    };
  }

  // 2. Known merchant domain mapping (sender domain itself, non-dual-role).
  if (domain in KNOWN_MERCHANTS) {
    return {
      rawMerchantName: input.extractedMerchant ?? KNOWN_MERCHANTS[domain],
      canonicalMerchantName: KNOWN_MERCHANTS[domain],
      canonicalMerchantDomain: domain,
      paymentProcessor: null, // a known merchant's own domain is not also a processor here
      merchantConfidence: clamp0to100(85),
      resolutionMethod: "known_domain",
      merchantResolutionStatus: "resolved",
    };
  }

  // 3/5. Processor domain -> resolveServiceName()'s body-text extraction.
  if (isProcessorDomain) {
    const bodyExtracted = resolveServiceName(domain, input.snippet);
    if (hasClearProcessorMerchant(input.snippet)) {
      return {
        rawMerchantName: input.extractedMerchant ?? bodyExtracted,
        canonicalMerchantName: bodyExtracted,
        canonicalMerchantDomain: null, // we only have a name here, not the merchant's own domain
        paymentProcessor: processorName,
        merchantConfidence: clamp0to100(75),
        resolutionMethod: "body_name+domain",
        merchantResolutionStatus: "resolved",
      };
    }

    // 6. Processor domain but no clear body extraction — we know the
    // processor, not the merchant. Genuinely ambiguous, not a confident guess.
    return {
      rawMerchantName: input.extractedMerchant,
      canonicalMerchantName: null,
      canonicalMerchantDomain: null,
      paymentProcessor: processorName,
      merchantConfidence: clamp0to100(25),
      resolutionMethod: "weak_text_match",
      merchantResolutionStatus: "ambiguous",
    };
  }

  // 4. Sender domain itself (non-processor, not in the known registry).
  if (domain) {
    const titleCased = domain.split(".")[0].replace(/^\w/, (c) => c.toUpperCase());
    return {
      rawMerchantName: input.extractedMerchant ?? titleCased,
      canonicalMerchantName: titleCased,
      canonicalMerchantDomain: domain,
      paymentProcessor: null,
      merchantConfidence: clamp0to100(50),
      resolutionMethod: "sender_domain_fallback",
      merchantResolutionStatus: "resolved",
    };
  }

  // No domain at all to work with.
  return {
    rawMerchantName: input.extractedMerchant,
    canonicalMerchantName: null,
    canonicalMerchantDomain: null,
    paymentProcessor: null,
    merchantConfidence: 0,
    resolutionMethod: "none",
    merchantResolutionStatus: "unknown",
  };
}
