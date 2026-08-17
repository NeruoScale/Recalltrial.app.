import { google } from "googleapis";
import type { SuggestedTrial } from "@shared/schema";
import {
  STRONG_POSITIVES,
  SOFT_NEGATIVES,
  SOFT_NEGATIVE_OVERRIDES,
  RECURRING_INDICATORS,
  REQUIRED_TRIGGERS,
  PAYMENT_PROCESSOR_DOMAINS,
  PREFERRED_SENDER_KEYWORDS,
} from "./gmailKeywords";

// ─── OAuth helpers ────────────────────────────────────────────────────────────

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function generateAuthUrl(userId: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    state: userId,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiry: Date | null;
}> {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return {
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token || null,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  };
}

export async function revokeToken(accessToken: string): Promise<void> {
  const oauth2Client = getOAuthClient();
  try {
    await oauth2Client.revokeToken(accessToken);
  } catch {
    // Ignore revoke errors — token may already be expired
  }
}

// ─── Domain utilities ─────────────────────────────────────────────────────────

export function extractDomainFromEmail(email: string): string {
  const match = email.match(/@([^>\s]+)/);
  return match ? match[1].toLowerCase().trim() : "";
}

/** Extract eTLD+1 root domain for deduplication. e.g. billing.bubble.io → bubble.io */
export function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  // Handle .co.uk, .com.au etc.
  const twoPartTld = ["co.uk", "com.au", "co.nz", "com.br", "co.za", "co.in"];
  const lastTwo = parts.slice(-2).join(".");
  if (twoPartTld.includes(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

export function hasStrongPositive(text: string): boolean {
  return STRONG_POSITIVES.some((p) => text.includes(p));
}

export function hasSoftNegative(text: string): boolean {
  return SOFT_NEGATIVES.some((n) => text.includes(n));
}

export function hasNegativeOverride(text: string): boolean {
  return SOFT_NEGATIVE_OVERRIDES.some((o) => text.includes(o));
}

export function hasRequiredTrigger(text: string): boolean {
  return REQUIRED_TRIGGERS.some((t) => text.includes(t));
}

export function passesReceiptFilter(text: string): boolean {
  const hasReceipt = text.includes("receipt") || text.includes("invoice");
  if (!hasReceipt) return true;
  return RECURRING_INDICATORS.some((r) => text.includes(r));
}

export function hasOngoingSignal(text: string): boolean {
  return ["renews", "recurring", "auto-renew", "auto renew", "next billing", "will be charged"].some(
    (k) => text.includes(k)
  );
}

/** Returns true if the sender looks like a trusted billing sender */
function isBillingSender(from: string): boolean {
  const lower = from.toLowerCase();
  return PREFERRED_SENDER_KEYWORDS.some((k) => lower.includes(k));
}

function isPaymentProcessor(domain: string): boolean {
  const root = getRootDomain(domain);
  return PAYMENT_PROCESSOR_DOMAINS.has(root) || PAYMENT_PROCESSOR_DOMAINS.has(domain);
}

// ─── Service name resolution ──────────────────────────────────────────────────

export function resolveServiceName(domain: string, snippet: string): string {
  if (isPaymentProcessor(domain)) {
    const patterns = [
      /you subscribed to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s+for|\s+at|\s+\$)/i,
      /your ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?) subscription/i,
      /payment to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
      /charged by ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
      /from ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
    ];
    for (const pattern of patterns) {
      const match = snippet.match(pattern);
      if (match?.[1]) {
        const name = match[1]
          .replace(/\b(Inc|LLC|Corp|Ltd|Co|GmbH|SAS|BV)\.?\b/gi, "")
          .replace(/[^\w\s\-]/g, "")
          .trim();
        if (name.length >= 2) return name;
      }
    }
  }

  const root = getRootDomain(domain);
  const parts = root.split(".");
  const name = parts[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── Date extraction ──────────────────────────────────────────────────────────

export type EndDateSource = "explicit" | "relative" | "duration" | "none";

// ─── Timezone-safe calendar-date helpers ───────────────────────────────────────
//
// Root cause of the original bug: `new Date(dateString)` parses a bare date
// string (e.g. "Aug 20, 2026") in the process's LOCAL timezone, but
// `.toISOString()` always serializes in UTC. Whenever the local timezone is
// positively offset from UTC, that round-trip can silently roll the date
// back one calendar day. The fix is to never let a date-only value pass
// through an ambiguous local-time Date parse at all: extract year/month/day
// as plain integers directly from the regex match, and only ever construct
// Date objects via Date.UTC (or read them via getUTC*), so every date in
// this module means exactly one calendar day regardless of the host's
// timezone. receivedAt itself is exempt from this — it comes from parsing
// an RFC 2822 email "Date" header, which always carries an explicit
// offset/zone, so `new Date(rfc2822String)` is already unambiguous.

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

type CalendarDate = { year: number; month: number; day: number };

/**
 * Parses a date substring already isolated by a regex match — one of
 * "Month D[, YYYY]", "MM/DD/YYYY", or "YYYY-MM-DD" — into plain calendar
 * components. `year` is null when the substring had no 4-digit year (the
 * "Month D" no-year case). Never touches `new Date(string)`.
 */
function parseCalendarDateComponents(raw: string): { year: number | null; month: number; day: number } | null {
  const cleaned = raw.replace(/(?:st|nd|rd|th)\b/gi, "").trim();

  let m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };

  m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { year: +m[3], month: +m[1], day: +m[2] };

  m = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})?$/);
  if (m) {
    const month = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return { year: m[3] ? +m[3] : null, month, day: +m[2] };
  }

  return null;
}

/** "YYYY-MM-DD", zero timezone dependency. Rejects overflow (e.g. Feb 30) rather than silently normalizing it. */
function formatCalendarDate(year: number, month: number, day: number): string | null {
  const ts = Date.UTC(year, month - 1, day);
  const check = new Date(ts);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function utcDateParts(d: Date): CalendarDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isBeforeUTC(a: CalendarDate, b: CalendarDate): boolean {
  return Date.UTC(a.year, a.month - 1, a.day) < Date.UTC(b.year, b.month - 1, b.day);
}

/**
 * Resolves an explicit-or-inferred year against `today` the same way the
 * original code did: reject years before today's (a clearly past date isn't
 * a usable renewal/trial-end date), and if the resulting date has already
 * passed this year, assume it refers to next year's occurrence.
 */
function resolveFutureCalendarDate(year: number, month: number, day: number, today: CalendarDate): string | null {
  if (year < today.year) return null;
  const candidate: CalendarDate = { year, month, day };
  const resolved = isBeforeUTC(candidate, today) ? { year: year + 1, month, day } : candidate;
  return formatCalendarDate(resolved.year, resolved.month, resolved.day);
}

export function extractDate(
  text: string,
  receivedAt: Date
): { date: string | null; source: EndDateSource } {
  const today = utcDateParts(new Date());

  // High-priority context patterns (explicit dates with lifecycle context)
  const explicitPatterns = [
    /next billing date[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /next billing (?:date )?is ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
    /renews on ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /will be charged on ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:trial ends?|trial expires?|ends?|expir(?:es?|ation)|valid until|cancel (?:by|before)|charged on|due on)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /(?:trial ends?|trial expires?|ends?|expir(?:es?|ation)|valid until|cancel (?:by|before))\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const components = parseCalendarDateComponents(match[1]);
      if (components) {
        const year = components.year ?? today.year;
        const formatted = resolveFutureCalendarDate(year, components.month, components.day, today);
        if (formatted) return { date: formatted, source: "explicit" };
      }
    }
  }

  // Standard date formats without contextual phrasing (bare dates). Each
  // pattern captures month/day/year as separate groups — read explicitly
  // per pattern rather than assuming a single capture group covers the
  // whole date (a bare `match[1]` alone here would only ever be the first
  // component, e.g. just "Aug" or just "2026").
  const bareMonthName = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/i);
  if (bareMonthName) {
    const month = MONTH_NAMES[bareMonthName[1].slice(0, 3).toLowerCase()];
    const day = parseInt(bareMonthName[2]);
    const year = parseInt(bareMonthName[3]);
    if (month) {
      const formatted = resolveFutureCalendarDate(year, month, day, today);
      if (formatted) return { date: formatted, source: "explicit" };
    }
  }

  const bareSlash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (bareSlash) {
    const month = parseInt(bareSlash[1]);
    const day = parseInt(bareSlash[2]);
    const year = parseInt(bareSlash[3]);
    const formatted = resolveFutureCalendarDate(year, month, day, today);
    if (formatted) return { date: formatted, source: "explicit" };
  }

  const bareIso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (bareIso) {
    const year = parseInt(bareIso[1]);
    const month = parseInt(bareIso[2]);
    const day = parseInt(bareIso[3]);
    const formatted = resolveFutureCalendarDate(year, month, day, today);
    if (formatted) return { date: formatted, source: "explicit" };
  }

  // Relative: "ends in X days", "trial ends tomorrow", "ends in 3 days"
  // These add plain milliseconds to receivedAt's absolute timestamp — already
  // timezone-safe (receivedAt came from an unambiguous RFC 2822 parse) — so
  // .toISOString() here was never the bug; left unchanged.
  const tomorrowMatch = text.match(/(?:ends?|expir(?:es?)|trial ends?)\s+tomorrow/i);
  if (tomorrowMatch) {
    const d = new Date(receivedAt.getTime() + 86400000);
    return { date: d.toISOString().slice(0, 10), source: "relative" };
  }

  const inDaysMatch = text.match(/(?:ends?|expir(?:es?|ation)|trial ends?|trial will end)\s+in\s+(\d+)\s+days?/i);
  if (inDaysMatch) {
    const d = new Date(receivedAt.getTime() + parseInt(inDaysMatch[1]) * 86400000);
    return { date: d.toISOString().slice(0, 10), source: "relative" };
  }

  // Ordinal day: "on the 6th" → infer month from receivedAt. This one WAS
  // buggy (setDate/getMonth are local-time methods) — rewritten on
  // receivedAt's UTC calendar parts, compared against UTC-today.
  const ordinalDayMatch = text.match(/(?:ends?|expir(?:es?)|cancel by|renews?)\s+on the (\d{1,2})(?:st|nd|rd|th)/i);
  if (ordinalDayMatch) {
    const day = parseInt(ordinalDayMatch[1]);
    const rec = utcDateParts(receivedAt);
    const candidate: CalendarDate = { year: rec.year, month: rec.month, day };
    const resolved = isBeforeUTC(candidate, today)
      ? (rec.month === 12 ? { year: rec.year + 1, month: 1, day } : { year: rec.year, month: rec.month + 1, day })
      : candidate;
    const formatted = formatCalendarDate(resolved.year, resolved.month, resolved.day);
    if (formatted) return { date: formatted, source: "relative" };
  }

  // Duration-based: "14-day free trial", "30 day trial", "1-month trial"
  const dayDuration = text.match(/(\d+)[-\s]day(?:s)?\s+(?:free\s+)?trial/i) ||
                      text.match(/trial\s+(?:for|of|period(?:\s+of)?)\s+(\d+)\s+days?/i);
  if (dayDuration) {
    const d = new Date(receivedAt.getTime() + parseInt(dayDuration[1]) * 86400000);
    return { date: d.toISOString().slice(0, 10), source: "duration" };
  }

  // Month-duration: setMonth/getMonth (local-time) replaced with
  // Date.UTC-based month arithmetic on receivedAt's UTC parts. Date.UTC
  // auto-normalizes day-of-month overflow the same way local setMonth did
  // (e.g. Jan 31 + 1 month), preserving the original overflow behavior —
  // just anchored consistently in UTC instead of mixing local and UTC.
  const monthDuration = text.match(/(\d+)[-\s]month(?:s)?\s+(?:free\s+)?(?:trial|plan|subscription)/i);
  if (monthDuration) {
    const rec = utcDateParts(receivedAt);
    const ts = Date.UTC(rec.year, (rec.month - 1) + parseInt(monthDuration[1]), rec.day);
    return { date: new Date(ts).toISOString().slice(0, 10), source: "duration" };
  }

  const weekDuration = text.match(/(\d+)[-\s]week(?:s)?\s+(?:free\s+)?trial/i);
  if (weekDuration) {
    const d = new Date(receivedAt.getTime() + parseInt(weekDuration[1]) * 7 * 86400000);
    return { date: d.toISOString().slice(0, 10), source: "duration" };
  }

  // Short month+day without year: "Mar 6", "March 6"
  const shortMatch = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (shortMatch) {
    const month = MONTH_NAMES[shortMatch[1].slice(0, 3).toLowerCase()];
    const day = parseInt(shortMatch[2]);
    if (month) {
      const formatted = resolveFutureCalendarDate(today.year, month, day, today);
      if (formatted) return { date: formatted, source: "explicit" };
    }
  }

  return { date: null, source: "none" };
}

// ─── Start date extraction ─────────────────────────────────────────────────────
// Only extract if an explicit start date phrase is present. Never defaults to today.

export function extractStartDate(text: string): { date: string | null; source: "explicit" | "none" } {
  // Explicit start date patterns — use /i flag for case-insensitive matching
  const startPatterns = [
    /(?:trial started|trial begins?|started|activated|subscription started|billing starts?|effective)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /since\s+([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /starts?\s+on\s+([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /start date[:\s]+([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
  ];

  for (const pattern of startPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const components = parseCalendarDateComponents(match[1]);
      if (components && components.year) {
        const formatted = formatCalendarDate(components.year, components.month, components.day);
        if (formatted) return { date: formatted, source: "explicit" };
      }
    }
  }

  return { date: null, source: "none" };
}

// ─── Amount extraction ────────────────────────────────────────────────────────

export function extractAmount(text: string): { amount: string | null; currency: string } {
  const match = text.match(/(?:[\$\£\€])\s*(\d+(?:\.\d{2})?)|\b(\d+(?:\.\d{2})?)\s*(?:USD|EUR|GBP|QAR)\b/i);
  if (match) {
    const amount = match[1] || match[2];
    const currencyMatch = text.match(/(\$|£|€|USD|EUR|GBP|QAR)/i);
    let currency = "USD";
    if (currencyMatch) {
      const c = currencyMatch[1].toUpperCase();
      if (c === "$") currency = "USD";
      else if (c === "£") currency = "GBP";
      else if (c === "€") currency = "EUR";
      else currency = c;
    }
    return { amount, currency };
  }
  return { amount: null, currency: "USD" };
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

export function scoreConfidenceDetailed(
  subject: string,
  snippet: string,
  from: string,
  hasDate: boolean,
  hasPrice: boolean,
  endDateSource: EndDateSource
): { score: number; breakdown: Array<{ label: string; points: number }> } {
  const text = (subject + " " + snippet).toLowerCase();
  const breakdown: Array<{ label: string; points: number }> = [];
  let score = 20;

  const add = (label: string, points: number) => {
    score += points;
    breakdown.push({ label, points });
  };

  if (hasStrongPositive(text)) add("Strong lifecycle signal", 35);
  if (hasRequiredTrigger(text)) add("Lifecycle trigger phrase", 15);
  if (["renews", "recurring", "auto-renew", "next billing", "will be charged"].some((k) => text.includes(k))) add("Renewal/billing phrase", 10);
  if (hasDate) {
    if (endDateSource === "explicit") add("Explicit date found", 15);
    else if (endDateSource === "relative") add("Relative date found", 10);
    else if (endDateSource === "duration") add("Duration-based date", 8);
  }
  if (hasPrice) add("Price detected", 8);
  if (isBillingSender(from)) add("Billing sender address", 5);
  if (!passesReceiptFilter(text)) add("Receipt without recurring indicator", -30);

  return { score: Math.min(Math.max(score, 0), 95), breakdown };
}

// ─── Subscription-event detection (Phase 2 Step 5, parallel to trial detection) ─
//
// Independent classification pass, reusing only the existing keyword/regex
// primitives above — no new keyword vocabulary introduced here. Deliberately
// does NOT classify price_changed, cancellation_requested/confirmed,
// subscription_expired, or subscription_paused: those need either signals
// that don't exist in gmailKeywords.ts yet (cancellation/expiry phrasing —
// that's Phase 3's job, not this step's) or comparison against a prior
// known price/status via entity resolution against a `subscriptions` table
// that doesn't exist yet (Phase 4). Returning `unknown_subscription_event`
// for genuinely subscription-relevant-but-unclassified signals is honest
// about that boundary rather than guessing.

export type SubscriptionEventType =
  | "trial_started" | "trial_ending" | "subscription_started" | "subscription_renewed"
  | "payment_received" | "invoice_received" | "price_changed" | "cancellation_requested"
  | "cancellation_confirmed" | "subscription_expired" | "subscription_paused"
  | "unknown_subscription_event";

export type SubscriptionEventCandidate = {
  eventType: SubscriptionEventType;
  extractedPrice: string | null;
  extractedCurrency: string | null;
  extractedDate: string | null;
  confidence: number;
};

export function detectSubscriptionEvent(
  subject: string,
  snippet: string,
  from: string,
  dateHeader: string
): SubscriptionEventCandidate | null {
  const combined = (subject + " " + snippet).toLowerCase();
  const receivedAt = dateHeader ? new Date(dateHeader) : new Date();

  // Same baseline relevance gate as the trial pipeline: must have SOME
  // subscription-lifecycle signal at all, or there's nothing to log.
  if (!hasStrongPositive(combined) && !hasRequiredTrigger(combined)) return null;

  const { date: extractedDate, source: endDateSource } = extractDate(combined, receivedAt);
  const { amount, currency } = extractAmount(combined);

  let eventType: SubscriptionEventType;
  if (["trial started", "free trial started", "trial has started", "trial begins", "your free trial", "trial period started"].some((k) => combined.includes(k))) {
    eventType = "trial_started";
  } else if (["trial ends", "trial ending", "trial expires", "trial expiring", "trial will end", "trial period ends"].some((k) => combined.includes(k))) {
    eventType = "trial_ending";
  } else if (["subscription confirmed", "subscription is active", "subscription activated", "subscription has been activated", "subscription is now active", "your plan is now active"].some((k) => combined.includes(k))) {
    eventType = "subscription_started";
  } else if (["renews on", "renewal", "auto-renewal", "auto renew", "auto-renew", "next billing"].some((k) => combined.includes(k))) {
    eventType = "subscription_renewed";
  } else if (["payment received", "charge successful", "card charged", "you will be charged", "will be charged on"].some((k) => combined.includes(k))) {
    eventType = "payment_received";
  } else if (combined.includes("invoice")) {
    eventType = "invoice_received";
  } else {
    eventType = "unknown_subscription_event";
  }

  const { score: confidence } = scoreConfidenceDetailed(subject, snippet, from, !!extractedDate, !!amount, endDateSource);

  return {
    eventType,
    extractedPrice: amount,
    extractedCurrency: currency,
    extractedDate,
    confidence,
  };
}

// ─── Gmail list with pagination ───────────────────────────────────────────────

async function listMessages(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
  maxTotal: number,
  phase: "A" | "B"
): Promise<Array<{ id: string; phase: "A" | "B" }>> {
  const all: Array<{ id: string; phase: "A" | "B" }> = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(500, maxTotal - all.length),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of res.data.messages || []) {
      if (m.id) all.push({ id: m.id, phase });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && all.length < maxTotal);

  return all;
}

// ─── Main scan function ───────────────────────────────────────────────────────

export async function scanGmailForTrials(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiry: Date | null,
  // Added for Phase 2 Step 5's parallel subscription-event write path only.
  // Existing return shape and existing trial-write behavior are unchanged;
  // this is purely additive so the two existing callers can pass user.id,
  // which they already have in scope.
  userId?: string
): Promise<Array<Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status">>> {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
    expiry_date: tokenExpiry?.getTime(),
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const phaseAQuery =
    'newer_than:90d -category:promotions (' +
    '"free trial has started" OR "trial started" OR "trial ends" OR "trial expires" OR ' +
    '"trial ending" OR "subscription started" OR "subscription is now active" OR ' +
    '"renews on" OR "next billing date" OR "will be charged on" OR "auto-renewal" OR ' +
    '"cancel before" OR "your trial" OR "free trial" OR "billing starts" OR ' +
    '"upcoming payment" OR "next payment" OR "payment due"' +
    ')';

  const phaseBQuery =
    'newer_than:90d -category:social -category:promotions (' +
    'subject:(trial OR subscription OR renewal OR invoice OR receipt OR billing)' +
    ')';

  const [phaseAMsgs, phaseBMsgs] = await Promise.all([
    listMessages(gmail, phaseAQuery, 500, "A"),
    listMessages(gmail, phaseBQuery, 500, "B"),
  ]);

  // Combine + deduplicate by message_id (Phase A takes priority)
  const seenIds = new Map<string, "A" | "B">();
  for (const m of phaseAMsgs) seenIds.set(m.id, "A");
  for (const m of phaseBMsgs) { if (!seenIds.has(m.id)) seenIds.set(m.id, "B"); }
  const allMessages = Array.from(seenIds.entries()).map(([id, phase]) => ({ id, phase }));

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  type RawResult = Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status"> & {
    _rootDomain: string;
    _priceKey: string;
    _dateKey: string;
    _isOngoing: boolean;
    _endDateSource: EndDateSource;
  };

  const rawResults: RawResult[] = [];

  // Phase 2 Step 5: parallel subscription-event detector counters, reported
  // once as a single structured log line after the loop finishes.
  let subDetectorProcessed = 0;
  let subDetectorCandidates = 0;
  let subDetectorWritten = 0;

  for (const { id: msgId, phase } of allMessages) {
    try {
      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = msgRes.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateStr = getHeader("Date");
      const snippet = msgRes.data.snippet || "";
      const combined = (subject + " " + snippet).toLowerCase();

      const fromDomain = extractDomainFromEmail(from);
      if (!fromDomain || fromDomain.endsWith("gmail.com")) continue;

      // ── Parallel subscription-event detection (Phase 2 Step 5) ──
      // Runs on every candidate message that survives only the domain check
      // above — deliberately BEFORE the trial-specific filters below, so a
      // message the trial pipeline rejects (e.g. fails passesReceiptFilter
      // or the trial-specific hasStrongPositive/hasRequiredTrigger gate)
      // still gets an independent chance at subscription-event
      // classification. Isolated in its own try/catch: a failure here must
      // never block or roll back the existing trial-suggestion pipeline
      // below, which is completely unmodified from this point on.
      if (userId) {
        subDetectorProcessed++;
        try {
          const candidate = detectSubscriptionEvent(subject, snippet, from, dateStr);
          if (candidate) {
            subDetectorCandidates++;
            // Dynamic import: keeps gmail.ts free of a module-load-time
            // dependency on the storage/DB layer (which constructs a live
            // pg.Pool at import time), so the pure detection functions stay
            // safely importable in tests without a DATABASE_URL or DB-layer
            // alias resolution. Same lazy-import pattern already used
            // elsewhere in this codebase (e.g. stripeClient.ts).
            const { storage } = await import("./storage");
            const written = await storage.createSubscriptionEvent({
              userId,
              sourceMessageId: msgId,
              eventType: candidate.eventType,
              extractedPrice: candidate.extractedPrice,
              extractedCurrency: candidate.extractedCurrency,
              extractedDate: candidate.extractedDate,
              confidence: candidate.confidence,
              detectionSource: "deterministic",
            });
            if (written) subDetectorWritten++;
          }
        } catch (subErr) {
          console.error(`[SubDetector] failed for message ${msgId}:`, subErr);
        }
      }

      // ── Filter: soft negatives (unless overridden by strong positive) ──
      if (hasSoftNegative(combined) && !hasNegativeOverride(combined)) continue;

      // ── Filter: receipt must have recurring indicator ──
      if (!passesReceiptFilter(combined)) continue;

      // ── Filter: Phase B must have a required trigger ──
      if (phase === "B" && !hasRequiredTrigger(combined)) continue;

      // ── Filter: must have at least one strong positive or required trigger ──
      if (!hasStrongPositive(combined) && !hasRequiredTrigger(combined)) continue;

      const receivedAt = dateStr ? new Date(dateStr) : new Date();
      const isOngoing = hasOngoingSignal(combined);

      // ── Date extraction ──
      const { date: extractedDate, source: endDateSource } = extractDate(combined, receivedAt);
      const { date: extractedStartDate, source: startDateSource } = extractStartDate(combined);

      // ── B: Hard validity rule — end date must be >= tomorrow ──
      if (extractedDate) {
        const endDate = new Date(extractedDate);
        if (endDate < tomorrow && !isOngoing) continue;
        // If date is past but ongoing signals exist, keep suggestion but clear stale date
        if (endDate < tomorrow) {
          // Keep as ongoing, drop the stale date
          // (will be treated as endDateSource = "none" below)
        }
      }

      // ── C: No invented dates — drop if no reliable date and not a clear paid receipt ──
      const isReceipt = combined.includes("receipt") || combined.includes("invoice") ||
                        combined.includes("payment received") || combined.includes("charge successful");
      if (endDateSource === "none" && !isOngoing && !isReceipt) continue;

      const { amount, currency } = extractAmount(combined);
      const serviceGuess = resolveServiceName(fromDomain, snippet);
      const rootDomain = getRootDomain(fromDomain);

      const validDate = extractedDate && new Date(extractedDate) >= tomorrow ? extractedDate : null;

      const { score: confidence } = scoreConfidenceDetailed(
        subject, snippet, from, !!validDate, !!amount, endDateSource
      );

      // ── E: Confidence threshold — 70% minimum, unless explicit date + strong positive ──
      const hasExplicitFutureDate = !!validDate && (endDateSource === "explicit" || endDateSource === "relative");
      const meetsThreshold = confidence >= 70 || (hasExplicitFutureDate && hasStrongPositive(combined));
      if (!meetsThreshold) continue;

      rawResults.push({
        _rootDomain: rootDomain,
        _priceKey: amount || "",
        _dateKey: validDate || "",
        _isOngoing: isOngoing,
        _endDateSource: endDateSource,
        provider: "gmail",
        messageId: msgId,
        fromEmail: from,
        fromDomain,
        subject: subject.slice(0, 255),
        receivedAt,
        serviceGuess,
        startDateGuess: extractedStartDate || null,
        startDateSource: startDateSource,
        endDateGuess: validDate || null,
        amountGuess: amount || null,
        currencyGuess: currency,
        confidence,
      });
    } catch {
      // skip individual message errors
    }
  }

  if (userId) {
    console.log(
      `[SubDetector] processed ${subDetectorProcessed} messages, ${subDetectorCandidates} candidates, ${subDetectorWritten} written`
    );
  }

  // ── D: Dedupe by eTLD+1 root domain + price + date (allow up to 2 per root domain) ──
  const bestByKey = new Map<string, RawResult>();
  for (const r of rawResults) {
    const key = `${r._rootDomain}__${r._priceKey}__${r._dateKey}`;
    const existing = bestByKey.get(key);
    if (!existing || r.confidence > existing.confidence) {
      bestByKey.set(key, r);
    }
  }

  const countPerDomain = new Map<string, number>();
  const finalResults: RawResult[] = [];
  for (const r of Array.from(bestByKey.values()).sort((a, b) => b.confidence - a.confidence)) {
    const count = countPerDomain.get(r._rootDomain) || 0;
    if (count < 2) {
      finalResults.push(r);
      countPerDomain.set(r._rootDomain, count + 1);
    }
  }

  return finalResults.map(({ _rootDomain, _priceKey, _dateKey, _isOngoing, _endDateSource, ...rest }) => rest);
}

export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}
