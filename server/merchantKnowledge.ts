// ─── Merchant knowledge base — Tier 2 evidence (Phase 3B.9.3) ──────────────────
//
// Deliberately tiny and conservative, per the task's explicit boundary: only
// merchants whose billing pattern is well-established and unambiguous from
// real production data observed in this project, not a general-purpose
// pricing database. Every entry here is a documented, low-risk shortcut for
// ONE specific known merchant — this is not meant to grow into a large
// registry (STRICT BOUNDARIES: 2 entries max for now).
//
// Only ever consulted as a FALLBACK (see server/storage.ts) when neither
// confirmed_email nor recurrence inference produced anything — never
// overrides either of those, and is itself never allowed to be overridden
// by a later "inferred" result once applied (server/billingIntelligence.ts's
// tier ranking: merchant_knowledge outranks inferred).

export type MerchantKnowledgeEntry = {
  domain: string;
  planName: string | null;
  currency: string | null;
  amount: number | null;
  billingInterval: string;
  confidence: "medium";
  source: "merchant_knowledge";
};

const MERCHANT_KNOWLEDGE_BASE: MerchantKnowledgeEntry[] = [
  {
    domain: "youtube.com",
    planName: "Premium",
    currency: "USD",
    amount: 22,
    billingInterval: "monthly",
    confidence: "medium",
    source: "merchant_knowledge",
  },
  {
    domain: "anthropic.com",
    planName: "Pro",
    currency: null, // amount varies by plan/region — not asserted here
    amount: null,
    billingInterval: "monthly",
    confidence: "medium",
    source: "merchant_knowledge",
  },
];

/**
 * lookupMerchantKnowledge(): exact domain match only, case-insensitive —
 * no fuzzy/substring matching, no subdomain inference. Returns null for
 * anything not explicitly in the registry above, which the caller must
 * treat as "no Tier 2 evidence," never a guess.
 */
export function lookupMerchantKnowledge(domain: string | null): MerchantKnowledgeEntry | null {
  if (!domain) return null;
  const normalized = domain.trim().toLowerCase();
  return MERCHANT_KNOWLEDGE_BASE.find((entry) => entry.domain === normalized) ?? null;
}
