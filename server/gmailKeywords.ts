// ─── Strong positive phrases ───────────────────────────────────────────────────
// Any of these in subject+snippet = high-confidence trial/subscription signal

export const STRONG_POSITIVES: string[] = [
  // Trial lifecycle
  "your trial ends", "trial ends", "trial ending", "trial ends tomorrow", "trial ends in",
  "trial will end", "trial expires", "trial expiring", "trial period ends",
  "free trial started", "trial has started", "trial begins", "trial period started",
  "trial started", "your free trial",
  // Subscription activation
  "subscription confirmed", "subscription is active", "subscription activated",
  "your subscription has been activated", "your subscription is now active",
  "your plan is now active",
  // Billing events
  "billing starts", "billing begins", "your billing starts",
  "you will be charged", "will be charged on", "first payment on",
  "next payment", "upcoming payment", "payment due", "renews on",
  "invoice", "receipt", "payment received", "charge successful", "card charged",
  // Renewal
  "subscription renewal", "renewal notice", "renews in",
  // Cancellation prompts (paired with trial/billing)
  "cancel before", "cancel by",
  // Auto-renewal
  "auto-renewal", "auto renew", "auto-renew",
  "next billing date", "next billing",
];

// ─── Negative filter phrases ───────────────────────────────────────────────────
// If subject+snippet contains any of these AND no strong positive override,
// the email is dropped.

export const SOFT_NEGATIVES: string[] = [
  // Marketing / promos
  "sale", " deal ", "discount", " offer ", "save ", "limited time", "last chance",
  "promo", "promotion", "black friday", "cyber monday",
  "newsletter", "digest", "weekly update", "monthly update", "new features",
  "release notes", "what's new", "product updates", "tips and tricks",
  "webinar", "workshop", " event ", "invite", "invitation", "join us",
  "community", " blog ", "survey", "feedback", "vote",
  // Outreach spam
  "book a call", "demo request", "schedule a call", "schedule a demo",
  "book a meeting", "calendar invite",
  // Security / auth (not billing)
  "security alert", "new sign-in", "verify your email", "verification code",
  "password reset", "two-step", "2-step", "one-time code", " otp ", "login attempt",
  // Shipping / orders
  "has shipped", "has been shipped", "out for delivery", "tracking number",
  "order confirmed", "order number", "your order",
];

// Strong positive overrides that rescue a soft-negative email
export const SOFT_NEGATIVE_OVERRIDES: string[] = [
  "will be charged", "invoice", "receipt", "trial ends", "trial started",
  "subscription activated", "payment due", "next billing",
];

// ─── Recurring indicators (required if email is a receipt/invoice) ─────────────

export const RECURRING_INDICATORS: string[] = [
  "renews", "recurring", "monthly", "annual", "annually", "subscription",
  "membership", "auto-renew", "auto renew", "next billing date",
  "trial ends", "trial expires", "cancel before", "will be charged",
];

// ─── Required triggers (Phase B emails must have at least one) ────────────────

export const REQUIRED_TRIGGERS: string[] = [
  "trial has started", "trial started", "your trial", "trial ends",
  "trial expires", "trial will end", "trial expiration",
  "subscription started", "subscription is now active", "subscription activated",
  "renews on", "renewal", "next billing date", "next billing",
  "will be charged", "auto-renewal", "auto renew", "auto-renew",
  "cancel before", "cancel anytime before", "free trial", "billing starts",
  "payment due", "upcoming payment", "next payment",
];

// ─── Payment processor / platform domains ─────────────────────────────────────

export const PAYMENT_PROCESSOR_DOMAINS: Set<string> = new Set([
  "stripe.com", "paypal.com", "apple.com", "google.com", "gumroad.com",
  "paddle.com", "fastspring.com", "lemonsqueezy.com", "chargebee.com",
  "recurly.com", "braintree.com", "2checkout.com", "klarna.com",
]);

// ─── Preferred sender sub-strings (boost confidence) ─────────────────────────

export const PREFERRED_SENDER_KEYWORDS: string[] = [
  "billing", "payments", "invoice", "receipts", "subscription",
  "noreply", "no-reply", "notifications", "alerts", "accounts",
];
