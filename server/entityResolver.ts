// ─── Entity resolution — SHADOW MODE ONLY (Phase 3B.4) ─────────────────────────
//
// Groups subscription_events belonging to the same real-world subscription
// into a proposed entity. This is a dry-run/shadow pass:
//
//   raw email -> classified event -> proposed entity resolution -> shadow output
//
// NOT (yet): raw email -> entity resolution -> subscription. No subscriptions
// table exists, nothing here writes to one, nothing here changes reminder
// scheduling or any other user-facing behavior. Output is written only to
// entity_resolution_candidates, an explicitly observation-only table nothing
// else reads from.
//
// Deterministic only — no AI, no randomness, no I/O. Same input always
// produces the same output (proposedSubscriptionId aside, which is a fresh
// UUID per call by design — see resolveEntity's docstring).

import { randomUUID } from "crypto";
import type { SubscriptionEvent } from "@shared/schema";

export type EntityResolutionStatus = "resolved" | "ambiguous" | "conflict" | "unresolved";

export type EntityResolutionResult = {
  proposedSubscriptionId: string;
  canonicalMerchantName: string;
  canonicalMerchantDomain: string | null;
  paymentProcessor: string | null;
  events: SubscriptionEvent[];
  resolutionConfidence: number;
  resolutionMethod: string;
  resolutionStatus: EntityResolutionStatus;
  potentialFalseMerge: boolean;
  potentialFalseSplit: boolean;
};

// Names broad enough to cover genuinely distinct products (Google Play vs
// Drive vs Workspace; App Store vs iCloud vs Apple Music) — matches
// merchantResolver.ts's DUAL_ROLE_DOMAINS exactly, for the same reason.
// Grouping purely on canonicalMerchantName/canonicalMerchantDomain is NOT
// safe for these; extra corroboration is required before merging.
const AMBIGUOUS_PLATFORM_NAMES = new Set(["google", "apple"]);

function isAmbiguousPlatformName(name: string | null): boolean {
  return !!name && AMBIGUOUS_PLATFORM_NAMES.has(name.toLowerCase());
}

/**
 * A best-effort "which specific product" signal for events whose
 * canonicalMerchantName is a broad platform name. Falls back to the raw
 * extractedMerchant text (Phase 3B.2's resolveServiceName() guess) ONLY
 * when it's meaningfully different from the bare platform name — e.g.
 * canonicalMerchantName="Google" but extractedMerchant mentions "Play" or
 * a specific third-party app name. Returns null when there's no
 * corroborating detail to distinguish sub-products at all.
 */
function specificProductHint(event: SubscriptionEvent): string | null {
  const platform = (event.canonicalMerchantName || "").toLowerCase();
  const raw = (event.extractedMerchant || "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === platform) return null; // no extra detail beyond the bare platform name
  return raw.toLowerCase();
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase();
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp0to100(n: number): number {
  return Math.min(Math.max(Math.round(n), 0), 100);
}

type Bucket = {
  key: string;
  method: string;
  events: SubscriptionEvent[];
};

/**
 * resolveEntity(): groups one user's non-one_time_purchase subscription
 * events into proposed entities using a strict evidence hierarchy. Every
 * grouping decision is explained via resolutionMethod. Conservative by
 * design: an unresolved/ambiguous result is preferred over a confident
 * wrong merge (STRICT rule from the spec — false merges are worse than
 * unresolved cases).
 *
 * proposedSubscriptionId is a fresh UUID generated on every call — it is a
 * SHADOW-ONLY grouping label, never persisted as a real identity and never
 * expected to be stable across repeated calls on the same input. Everything
 * else about the output is a pure function of the input events.
 */
export function resolveEntity(events: SubscriptionEvent[]): EntityResolutionResult[] {
  // Defensive, not just documented: never merge across userIds even if
  // called with mixed input by mistake — group by userId first and resolve
  // each independently.
  const byUser = new Map<string, SubscriptionEvent[]>();
  for (const e of events) {
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId)!.push(e);
  }

  const allResults: EntityResolutionResult[] = [];
  for (const userEvents of Array.from(byUser.values())) {
    allResults.push(...resolveForOneUser(userEvents));
  }
  return allResults;
}

function resolveForOneUser(events: SubscriptionEvent[]): EntityResolutionResult[] {
  // one_time_purchase events must NOT be included in entity resolution at all.
  const eligible = events.filter((e) => e.eventType !== "one_time_purchase");

  const buckets: Bucket[] = [];

  function addToBucket(key: string, method: string, event: SubscriptionEvent) {
    let bucket = buckets.find((b) => b.key === key && b.method === method);
    if (!bucket) {
      bucket = { key, method, events: [] };
      buckets.push(bucket);
    }
    bucket.events.push(event);
  }

  for (const event of eligible) {
    const domain = event.canonicalMerchantDomain;
    const name = event.canonicalMerchantName;
    const processor = event.paymentProcessor;

    if (domain && !isAmbiguousPlatformName(name)) {
      // 1. Same canonicalMerchantDomain -> strong grouping signal.
      addToBucket(`domain:${normalizeKey(domain)}`, "domain_match", event);
    } else if (domain && isAmbiguousPlatformName(name)) {
      // Broad platform domain (google.com/apple.com as a DIRECT merchant,
      // not via the processor path — see specificProductHint). Only group
      // with others sharing the same specific-product hint; otherwise each
      // stays its own ambiguous singleton rather than merging into one
      // giant "Google" entity that conflates unrelated products.
      const hint = specificProductHint(event);
      if (hint) {
        addToBucket(`ambiguous-domain:${normalizeKey(domain)}:${hint}`, "domain_match_with_product_hint", event);
      } else {
        addToBucket(`ambiguous-domain:${normalizeKey(domain)}:singleton:${event.id}`, "ambiguous_platform_name", event);
      }
    } else if (name && !isAmbiguousPlatformName(name)) {
      // 2. Same canonicalMerchantName (case-insensitive), no domain to
      // corroborate — weaker than domain_match, flagged as a possible
      // false merge if it ever groups >1 event (see potentialFalseMerge).
      addToBucket(`name:${normalizeKey(name)}`, "name_match", event);
    } else if (processor && event.extractedMerchant) {
      // 3. Payment processor + body-extracted merchant name -> weaker signal.
      addToBucket(`processor:${normalizeKey(processor)}:${normalizeKey(event.extractedMerchant)}`, "processor_body_match", event);
    } else if (name && isAmbiguousPlatformName(name)) {
      // Ambiguous platform name with no domain and no processor/body
      // corroboration at all — each stays its own singleton.
      addToBucket(`ambiguous-noname:singleton:${event.id}`, "ambiguous_platform_name", event);
    } else {
      // 4. No usable grouping signal whatsoever.
      addToBucket(`unresolved:singleton:${event.id}`, "no_corroborating_evidence", event);
    }
  }

  // Detect potential false splits: an unresolved/ambiguous singleton whose
  // merchant name is a fuzzy (substring) match of another bucket's name —
  // flagged, but NOT merged, per the conservative-by-design rule.
  const resolvedBucketNames = buckets
    .filter((b) => b.method === "domain_match" || b.method === "name_match")
    .map((b) => ({ key: b.key, name: (b.events[0].canonicalMerchantName || "").toLowerCase() }));

  return buckets.map((bucket) => {
    const first = bucket.events[0];
    const merchantConfidences = bucket.events.map((e) => e.merchantConfidence ?? 0);
    const avgMerchantConfidence = average(merchantConfidences);

    const methodBaseConfidence: Record<string, number> = {
      domain_match: 45,
      domain_match_with_product_hint: 35,
      name_match: 25,
      processor_body_match: 15,
      ambiguous_platform_name: 5,
      no_corroborating_evidence: 0,
    };
    const corroborationBonus = Math.min((bucket.events.length - 1) * 10, 30);
    const resolutionConfidence = clamp0to100(
      avgMerchantConfidence * 0.4 + (methodBaseConfidence[bucket.method] ?? 0) + corroborationBonus
    );

    let resolutionStatus: EntityResolutionStatus;
    if (bucket.method === "ambiguous_platform_name") {
      resolutionStatus = "ambiguous";
    } else if (bucket.method === "no_corroborating_evidence") {
      // Single event, no corroboration: "resolved" only if the underlying
      // merchant resolution itself was already high-confidence (we know
      // WHO with good evidence, we just haven't seen them more than once);
      // otherwise genuinely unresolved. Matches the spec's explicit
      // "unresolved or low-confidence" allowance for this case.
      resolutionStatus = avgMerchantConfidence >= 70 ? "resolved" : "unresolved";
    } else if (bucket.events.length === 1) {
      resolutionStatus = avgMerchantConfidence >= 70 ? "resolved" : "unresolved";
    } else {
      resolutionStatus = "resolved";
    }

    // "conflict": stronger than potentialFalseMerge below — positive
    // evidence of difference, not just absence of evidence of sameness.
    // Only meaningful for domain_match groups (grouped on the strongest
    // signal available), where 2+ events carry DISTINCT specific
    // extractedMerchant text despite sharing the same domain — e.g. the
    // domain says "spotify.com" for all of them, but the raw body text
    // extracted two clearly different product names. That's a real,
    // specific reason to distrust the merge, not a generic hedge.
    if (bucket.method === "domain_match") {
      const distinctRawMerchants = new Set(
        bucket.events
          .map((e) => (e.extractedMerchant || "").trim().toLowerCase())
          .filter((m) => m.length > 0)
      );
      if (distinctRawMerchants.size > 1) {
        resolutionStatus = "conflict";
      }
    }

    // potentialFalseMerge: this group has >1 event but was formed on a
    // signal weaker than exact domain identity (name-only or
    // processor+body match), OR — even within a domain_match group — the
    // member events don't all agree on canonicalMerchantName (same domain,
    // different displayed names is itself a mild red flag worth a human
    // glance rather than blind trust).
    const distinctNamesInGroup = new Set(bucket.events.map((e) => normalizeKey(e.canonicalMerchantName || "")));
    const potentialFalseMerge =
      bucket.events.length > 1 &&
      (bucket.method === "name_match" || bucket.method === "processor_body_match" || distinctNamesInGroup.size > 1);

    // potentialFalseSplit: this bucket is a small/unresolved/ambiguous
    // group whose name fuzzy-matches (substring, either direction) an
    // established resolved/name_match group's name — flagged, never merged.
    let potentialFalseSplit = false;
    if (bucket.method !== "domain_match" && first.canonicalMerchantName) {
      const thisName = normalizeKey(first.canonicalMerchantName);
      potentialFalseSplit = resolvedBucketNames.some(
        (r) => r.key !== bucket.key && thisName.length > 2 && r.name.length > 2 &&
          (r.name.includes(thisName) || thisName.includes(r.name))
      );
    }

    return {
      proposedSubscriptionId: randomUUID(),
      canonicalMerchantName: first.canonicalMerchantName || "(unknown)",
      canonicalMerchantDomain: first.canonicalMerchantDomain,
      paymentProcessor: first.paymentProcessor,
      events: bucket.events,
      resolutionConfidence,
      resolutionMethod: bucket.method,
      resolutionStatus,
      potentialFalseMerge,
      potentialFalseSplit,
    };
  });
}
