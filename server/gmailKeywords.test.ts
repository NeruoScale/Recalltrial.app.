/**
 * Gmail keyword filter test fixtures.
 * Run with: npx tsx server/gmailKeywords.test.ts
 */

import { STRONG_POSITIVES, SOFT_NEGATIVES, SOFT_NEGATIVE_OVERRIDES, REQUIRED_TRIGGERS } from "./gmailKeywords";

type Fixture = {
  description: string;
  subject: string;
  snippet: string;
  expectPass: boolean; // true = should be kept as suggestion
};

const fixtures: Fixture[] = [
  // ── Should PASS ──────────────────────────────────────────────────────────
  {
    description: "Trial start email",
    subject: "[Bubble] Your Bubble Starter plan free trial has started",
    snippet: "Your trial ends on March 6, 2026. USD 39.00/mo after trial.",
    expectPass: true,
  },
  {
    description: "Trial ending soon",
    subject: "Your Skool free trial ends in 3 days",
    snippet: "Cancel before March 8 to avoid being charged $3.00/mo.",
    expectPass: true,
  },
  {
    description: "Subscription renewal notice",
    subject: "Upcoming payment: Your Spacemail Advanced subscription will be renewed in 3 days",
    snippet: "USD 3.00 will be charged on March 9, 2026.",
    expectPass: true,
  },
  {
    description: "Invoice with recurring indicator",
    subject: "Your Shopify invoice",
    snippet: "Your monthly subscription invoice for $29.00. Renews on March 15, 2026.",
    expectPass: true,
  },
  {
    description: "Welcome to trial",
    subject: "Welcome to your Bubble free trial!",
    snippet: "Your 14-day free trial has started. You will be charged $14.00/mo after the trial ends.",
    expectPass: true,
  },
  {
    description: "Auto-renewal notice",
    subject: "Auto-renewal reminder for your subscription",
    snippet: "Your subscription will auto-renew on April 1, 2026 for $9.99/mo.",
    expectPass: true,
  },
  // ── Should FAIL (false positives) ─────────────────────────────────────────
  {
    description: "Marketing newsletter",
    subject: "What's new this week at Shopify",
    snippet: "Check out our latest product updates, tips, and community highlights.",
    expectPass: false,
  },
  {
    description: "Discount promo",
    subject: "Limited time offer: 50% off your first month",
    snippet: "Use code SAVE50 at checkout. Last chance — this deal expires soon!",
    expectPass: false,
  },
  {
    description: "Shipping notification",
    subject: "Your order has shipped",
    snippet: "Tracking number: 1Z999AA10123456784. Expected delivery: March 8.",
    expectPass: false,
  },
  {
    description: "Security alert",
    subject: "New sign-in to your account",
    snippet: "We detected a new sign-in from Chrome on Windows. If this was you, no action needed.",
    expectPass: false,
  },
  {
    description: "Receipt without recurring indicator (one-time purchase)",
    subject: "Your receipt from Gumroad",
    snippet: "You purchased 'Design Course Bundle' for $49.00. Thank you!",
    expectPass: false,
  },
  {
    description: "Webinar invite",
    subject: "Join us for a live webinar: How to scale your SaaS",
    snippet: "Register now for our free webinar on Thursday at 2pm EST.",
    expectPass: false,
  },
];

// Simplified filter logic matching gmail.ts
function hasStrongPositive(text: string): boolean {
  return STRONG_POSITIVES.some((p) => text.includes(p));
}
function hasSoftNegative(text: string): boolean {
  return SOFT_NEGATIVES.some((n) => text.includes(n));
}
function hasNegativeOverride(text: string): boolean {
  return SOFT_NEGATIVE_OVERRIDES.some((o) => text.includes(o));
}
function hasRequiredTrigger(text: string): boolean {
  return REQUIRED_TRIGGERS.some((t) => text.includes(t));
}
function passesReceiptFilter(text: string): boolean {
  const hasReceipt = text.includes("receipt") || text.includes("invoice");
  if (!hasReceipt) return true;
  const recurring = ["renews", "recurring", "monthly", "annual", "subscription", "membership",
    "auto-renew", "next billing", "trial ends", "will be charged"];
  return recurring.some((r) => text.includes(r));
}

function simulateFilter(subject: string, snippet: string): boolean {
  const combined = (subject + " " + snippet).toLowerCase();
  if (hasSoftNegative(combined) && !hasNegativeOverride(combined)) return false;
  if (!passesReceiptFilter(combined)) return false;
  if (!hasStrongPositive(combined) && !hasRequiredTrigger(combined)) return false;
  return true;
}

let passed = 0;
let failed = 0;

console.log("\n=== Gmail Keyword Filter Tests ===\n");

for (const f of fixtures) {
  const result = simulateFilter(f.subject, f.snippet);
  const ok = result === f.expectPass;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${f.description}`);
  } else {
    failed++;
    const got = result ? "KEPT (false positive)" : "DROPPED (false negative)";
    console.log(`  ✗ FAIL  ${f.description} → ${got}`);
    console.log(`          Subject: "${f.subject}"`);
  }
}

console.log(`\n${passed}/${fixtures.length} tests passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
