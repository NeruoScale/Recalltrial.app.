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

/**
 * buildGmailClient(): same OAuth2Client + gmail client construction
 * scanGmailForTrials() does inline — extracted (Phase 3B.9.7-PATCH) so
 * server/backfillBodyExtraction.ts can build an authenticated client for a
 * user without duplicating this wiring.
 */
export function buildGmailClient(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiry: Date | null
): ReturnType<typeof google.gmail> {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
    expiry_date: tokenExpiry?.getTime(),
  });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

// PHASE B (Account Isolation): openid + email added alongside the existing
// gmail.readonly scope — pure identity, grants ZERO additional data access
// beyond what gmail.readonly already allowed. This is what makes
// exchangeCodeForTokens() below able to return a real id_token to decode.
export function generateAuthUrl(userId: string): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
    state: userId,
  });
}

/**
 * exchangeCodeForTokens(): providerAccountId (Google's stable `sub` claim,
 * PREFERRED over email as the durable identity per the approved design —
 * email addresses can be reassigned/aliased on Workspace accounts, `sub`
 * never changes) and emailAddress (display-only) come from decoding the
 * id_token the NEW openid/email scopes now cause Google to return.
 *
 * Both are null, never thrown, if id_token verification fails for any
 * reason (missing GOOGLE_CLIENT_ID, network hiccup, malformed token) — per
 * PHASE B's explicit "do not silently break existing connections"
 * requirement, identity is an ENHANCEMENT layered on top of the existing
 * connect flow, never a new failure mode for it. A user connecting today
 * still gets a fully working Gmail connection even if this lookup fails;
 * they just won't have a provider identity recorded until a later
 * reconnect succeeds.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiry: Date | null;
  providerAccountId: string | null;
  emailAddress: string | null;
}> {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  let providerAccountId: string | null = null;
  let emailAddress: string | null = null;
  if (tokens.id_token) {
    try {
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      providerAccountId = payload?.sub ?? null;
      emailAddress = payload?.email ?? null;
    } catch (err) {
      console.error("[Gmail OAuth] id_token verification failed — continuing without provider identity:", err);
    }
  }

  return {
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token || null,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    providerAccountId,
    emailAddress,
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
 * Resolves a calendar date against `today`. `yearWasExplicit` distinguishes
 * two genuinely different situations that used to be conflated:
 *
 *  - explicit year (the source text said "Sep 1, 2026"): that year is
 *    authoritative. Returned as-is, even if it's in the past relative to
 *    `today` — an email that explicitly states a date gets reported exactly
 *    as stated, never silently bumped to "next year" just because today
 *    happens to be a day (or a year) later. (Phase 5.1A: this used to roll
 *    "Sep 1, 2026" forward to 2027-09-01 the moment today passed Sep 1,
 *    2026 — wrong, since the year was never ambiguous in the first place.)
 *  - inferred year (the source only said "Sep 1", no year — `today.year` is
 *    filled in by the caller before this function ever sees it): the
 *    original rollover behavior is unchanged — if that date has already
 *    passed this year, assume it refers to next year's occurrence.
 */
function resolveFutureCalendarDate(year: number, month: number, day: number, today: CalendarDate, yearWasExplicit: boolean): string | null {
  if (yearWasExplicit) {
    return formatCalendarDate(year, month, day);
  }
  if (year < today.year) return null;
  const candidate: CalendarDate = { year, month, day };
  const resolved = isBeforeUTC(candidate, today) ? { year: year + 1, month, day } : candidate;
  return formatCalendarDate(resolved.year, resolved.month, resolved.day);
}

function extractDateFromSingleText(
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
        const yearWasExplicit = components.year !== null;
        const year = components.year ?? today.year;
        const formatted = resolveFutureCalendarDate(year, components.month, components.day, today, yearWasExplicit);
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
      // Explicit year: matched directly by the regex's `(\d{4})` group above.
      const formatted = resolveFutureCalendarDate(year, month, day, today, true);
      if (formatted) return { date: formatted, source: "explicit" };
    }
  }

  const bareSlash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (bareSlash) {
    const month = parseInt(bareSlash[1]);
    const day = parseInt(bareSlash[2]);
    const year = parseInt(bareSlash[3]);
    const formatted = resolveFutureCalendarDate(year, month, day, today, true);
    if (formatted) return { date: formatted, source: "explicit" };
  }

  const bareIso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (bareIso) {
    const year = parseInt(bareIso[1]);
    const month = parseInt(bareIso[2]);
    const day = parseInt(bareIso[3]);
    const formatted = resolveFutureCalendarDate(year, month, day, today, true);
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
      // No year in the source text at all — inferred from today.year, so
      // the rollover-if-already-passed behavior still applies here.
      const formatted = resolveFutureCalendarDate(today.year, month, day, today, false);
      if (formatted) return { date: formatted, source: "explicit" };
    }
  }

  return { date: null, source: "none" };
}

/**
 * extractDate(): tries `text` (subject+snippet) first; only falls back to
 * `fullBodyText` when nothing is found there — the full body frequently
 * carries an explicit "next billing date"/renewal date the truncated
 * snippet cuts off. `receivedAt` anchors relative/duration calculations
 * (e.g. "ends tomorrow") the same way regardless of which layer the phrase
 * was found in — it describes when the email itself arrived, not where the
 * date phrase was read from.
 */
export function extractDate(
  text: string,
  receivedAt: Date,
  fullBodyText?: string
): { date: string | null; source: EndDateSource } {
  const found = extractDateFromSingleText(text, receivedAt);
  if (found.date) return found;
  if (fullBodyText) {
    const foundInBody = extractDateFromSingleText(fullBodyText, receivedAt);
    if (foundInBody.date) return foundInBody;
  }
  return found;
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
//
// Phase 3B.9.7: currency coverage extended past $/€/£/USD/EUR/GBP/QAR to the
// full symbol/code set the task requires. ¥ (JPY/CNY) and "kr" (SEK/DKK/NOK)
// are inherently ambiguous symbols with no further disambiguating text
// available at this layer — defaulted to the more common of the pair (JPY,
// SEK respectively) rather than guessing per-message; a genuinely wrong
// default here is no worse than the pre-existing behavior of not detecting
// the amount at all.
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "$": "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
};

const CURRENCY_CODE_LIST = ["USD", "EUR", "GBP", "QAR", "CHF", "CAD", "AUD", "NZD", "SEK", "DKK", "NOK", "JPY", "CNY", "INR"];
const CURRENCY_CODE_PATTERN = CURRENCY_CODE_LIST.join("|");

function findAmountInText(text: string): { amount: string; currency: string } | null {
  const symbolMatch = text.match(/([\$£€¥₹])\s*(\d+(?:\.\d{2})?)/);
  if (symbolMatch) {
    return { amount: symbolMatch[2], currency: CURRENCY_SYMBOL_MAP[symbolMatch[1]] };
  }

  const codeAfter = text.match(new RegExp(`\\b(\\d+(?:\\.\\d{2})?)\\s*(${CURRENCY_CODE_PATTERN})\\b`, "i"));
  if (codeAfter) {
    return { amount: codeAfter[1], currency: codeAfter[2].toUpperCase() };
  }

  const codeBefore = text.match(new RegExp(`\\b(${CURRENCY_CODE_PATTERN})\\s*(\\d+(?:\\.\\d{2})?)\\b`, "i"));
  if (codeBefore) {
    return { amount: codeBefore[2], currency: codeBefore[1].toUpperCase() };
  }

  // "kr" (SEK/DKK/NOK) has no distinguishing symbol of its own — checked
  // last, after every ISO-code form above, so an explicit "199.00 SEK" or
  // "199.00 NOK" elsewhere in the same text is never shadowed by a bare
  // "kr" match.
  const krMatch = text.match(/\b(\d+(?:\.\d{2})?)\s*kr\b/i);
  if (krMatch) {
    return { amount: krMatch[1], currency: "SEK" };
  }

  return null;
}

/**
 * extractAmount(): tries `text` (subject+snippet) first; only falls back to
 * `fullBodyText` when the snippet-scoped search finds nothing. Return shape
 * is unchanged from before Phase 3B.9.7 — callers that need to know WHICH
 * layer the amount came from (subscriptionEvents.amountSource) derive that
 * themselves by comparing a snippet-only call against this one, rather than
 * this function reporting its own provenance (see detectSubscriptionEvent()).
 */
export function extractAmount(text: string, fullBodyText?: string): { amount: string | null; currency: string } {
  const inSnippet = findAmountInText(text);
  if (inSnippet) return inSnippet;

  if (fullBodyText) {
    const inBody = findAmountInText(fullBodyText);
    if (inBody) return inBody;
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

// ─── Full body fetch (Phase 3B.9.7) ────────────────────────────────────────────
//
// Second-stage, best-effort enrichment for messages that already passed the
// candidate gate (hasSubscriptionEventSignal, checked by the caller before
// this is invoked — see scanGmailForTrials). Layer 1 (metadata + snippet)
// is completely unchanged and is still what decides whether a message is a
// candidate at all; this layer only extends what a message that ALREADY
// qualified can additionally reveal.
//
// PRIVACY: the decoded body string is a local variable inside this function
// and whatever calls it — never assigned to a module-level variable, never
// passed to console.log/console.error, never included in any object that
// gets written to the database. The only things that leave this function
// are (a) the plaintext itself, returned to the immediate caller for
// synchronous extraction, or (b) null. Once the caller's extraction calls
// return, nothing keeps a reference to it and it is eligible for GC exactly
// like any other local value — there is no separate "discard" step needed
// beyond simply not storing it anywhere, which the code below (and every
// call site of fetchMessageBody in this file) satisfies by construction.

const MAX_BODY_CHARS = 8000;

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

/**
 * htmlToPlainText(): link URLs are pulled out into `text (url)` form BEFORE
 * tags are stripped — a plain "strip every tag" pass would silently drop
 * every href, which would make extractCancellationUrl() below unable to
 * ever find a cancel/unsubscribe link that only exists as an <a href> in an
 * HTML email (the common case), not as bare visible text.
 */
function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, inner) => `${inner} (${url})`);
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.replace(/[ \t]+/g, " ").replace(/\n[ \t]*\n+/g, "\n").trim();
}

/** Depth-first search through a (possibly nested, multipart/alternative) MIME tree for the first part matching `mimeType`. */
function findBodyPart(part: any, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (Array.isArray(part.parts)) {
    for (const sub of part.parts) {
      const found = findBodyPart(sub, mimeType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * fetchMessageBody(): second Gmail API call (format:"full") for a single
 * already-qualified candidate message. text/plain is preferred; text/html
 * is only used when no text/plain part exists anywhere in the MIME tree.
 * Truncated to MAX_BODY_CHARS. Returns null on any failure (network error,
 * missing payload, no usable part) — callers must treat null as "proceed
 * with snippet-only extraction," never as an error to surface to the user.
 */
export async function fetchMessageBody(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string
): Promise<string | null> {
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const payload = res.data.payload;
    if (!payload) return null;

    let raw: string | null = null;

    if (!payload.parts && payload.body?.data) {
      raw = decodeBase64Url(payload.body.data);
      if (payload.mimeType === "text/html") raw = htmlToPlainText(raw);
    } else {
      const plainText = findBodyPart(payload, "text/plain");
      if (plainText) {
        raw = plainText;
      } else {
        const htmlText = findBodyPart(payload, "text/html");
        if (htmlText) raw = htmlToPlainText(htmlText);
      }
    }

    if (!raw) return null;
    return raw.slice(0, MAX_BODY_CHARS);
  } catch {
    // Never log `err` here in a way that could echo body content — Gmail
    // API failures at this stage are transport/auth errors, not partial
    // body echoes, but the catch stays silent regardless (see PRIVACY note
    // above) and the caller falls back to snippet-only extraction.
    return null;
  }
}

// ─── Cancellation URL / next-billing-date / account-id extraction (3B.9.7) ─────

const CANCEL_URL_KEYWORD_PATTERN = /cancel|unsubscribe|manage[-_ ]?(?:subscription|billing|plan|account)/i;

function findCancellationUrlInText(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s)"'<>]+/gi);
  if (urls) {
    for (const url of urls) {
      if (CANCEL_URL_KEYWORD_PATTERN.test(url)) return url;
    }
  }
  // Fallback: a URL appearing shortly after a "cancel"/"unsubscribe" word in
  // surrounding text, even when the URL itself has no matching keyword in
  // its path (e.g. an opaque tracking-shortened link right after "Cancel:").
  const contextMatch = text.match(/(?:cancel|unsubscribe)[^\n]{0,60}?(https?:\/\/[^\s)"'<>]+)/i);
  return contextMatch?.[1] ?? null;
}

/** extractCancellationUrl(): never invents a URL — only ever returns one actually present in the text. */
export function extractCancellationUrl(text: string, fullBodyText?: string): string | null {
  return findCancellationUrlInText(text) ?? (fullBodyText ? findCancellationUrlInText(fullBodyText) : null);
}

const NEXT_BILLING_DATE_PATTERN = /(?:next billing date|next payment date|next charge date|renews on|renewal date)[:\s]+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i;

function findNextBillingDateInText(text: string): string | null {
  const match = text.match(NEXT_BILLING_DATE_PATTERN);
  if (!match?.[1]) return null;
  const components = parseCalendarDateComponents(match[1]);
  if (!components) return null;
  const today = utcDateParts(new Date());
  // NEXT_BILLING_DATE_PATTERN's every alternative requires a 4-digit year,
  // so components.year is always non-null here in practice — still computed
  // explicitly (not hardcoded `true`) so this stays correct if the pattern
  // is ever loosened to allow a yearless match.
  const yearWasExplicit = components.year !== null;
  return resolveFutureCalendarDate(components.year ?? today.year, components.month, components.day, today, yearWasExplicit);
}

/** extractNextBillingDate(): narrower than extractDate() — only matches explicit "next billing/renewal date" phrasing, not any lifecycle date. */
export function extractNextBillingDate(text: string, fullBodyText?: string): string | null {
  return findNextBillingDateInText(text) ?? (fullBodyText ? findNextBillingDateInText(fullBodyText) : null);
}

const SUBSCRIPTION_ID_PATTERN = /(?:subscription (?:id|number)|account (?:id|number)|order (?:id|number|#)|reference (?:id|number)?)[:\s#]+([A-Za-z0-9\-]{4,40})/i;

function findSubscriptionIdInText(text: string): string | null {
  const match = text.match(SUBSCRIPTION_ID_PATTERN);
  return match?.[1] ?? null;
}

/** extractSubscriptionId(): merchant-issued account/subscription identifier, when the email states one explicitly. */
export function extractSubscriptionId(text: string, fullBodyText?: string): string | null {
  return findSubscriptionIdInText(text) ?? (fullBodyText ? findSubscriptionIdInText(fullBodyText) : null);
}

// ─── Subscription-event detection (Phase 2 Step 5, parallel to trial detection) ─
//
// Independent classification pass. Phrase lists below are LOCAL to this
// section, not added to gmailKeywords.ts's shared STRONG_POSITIVES/
// REQUIRED_TRIGGERS/etc — those arrays are read by the trial-suggestion
// pipeline (scanGmailForTrials' main loop, hasStrongPositive/
// hasRequiredTrigger gates) and must not change behavior there. Likewise
// scoreConfidenceDetailed() above is untouched and still used only by the
// trial pipeline; scoreSubscriptionEventConfidence() below is a separate,
// independent function for this detector only.
//
// Phase 3B.1 evaluation (PHASE1_AUDIT.md-linked; see commit) found, against
// 205 real production rows: (a) "invoice"/"receipt" is too blunt a catch-all
// — genuinely one-time purchases and genuinely recurring invoices were both
// landing in the same invoice_received bucket; (b) payment-due/upcoming-
// payment/cancel-before phrases had no bucket at all and fell to
// unknown_subscription_event even though they're clear signals; (c) the
// shared scoreConfidenceDetailed()'s receipt-without-recurring-indicator
// penalty was firing on genuinely-recurring invoices whenever the specific
// recurring keyword didn't happen to co-occur in that message's short
// snippet, capping confidence at ~50-60 even with a valid price+date.

const CANCELLATION_CONFIRMED_PHRASES = [
  "subscription cancelled", "subscription canceled", "subscription has been cancelled",
  "subscription has been canceled", "successfully cancelled", "successfully canceled",
  "cancellation confirmed", "your cancellation is confirmed", "you have cancelled your subscription",
  "you have canceled your subscription", "your subscription was cancelled", "your subscription was canceled",
  "your subscription has ended", "your plan has been cancelled", "your plan has been canceled",
];

const PAYMENT_FAILED_PHRASES = [
  "payment failed", "payment declined", "payment could not be processed",
  "card was declined", "your card was declined", "unable to process your payment",
  "payment unsuccessful", "payment did not go through", "we couldn't charge your card",
  "we could not charge your card", "your payment method was declined", "update your payment method",
  // Phase 3B.3.1: added after "your most recent payment was unsuccessful"
  // (real Anthropic email) matched none of the phrases above — "payment
  // unsuccessful" (no "was") is a different substring than "payment was
  // unsuccessful". "payment could not be processed"/"payment did not go
  // through"/"unable to process your payment" were already covered
  // verbatim above, so not re-added.
  "payment was unsuccessful", "charge failed",
];

const PRICE_CHANGE_PHRASES = [
  "price increase", "price change", "new price", "price adjustment",
  "prices are changing", "your subscription price has changed", "your rate is changing",
  "we're updating our prices", "we are updating our prices", "price update",
];

const RENEWAL_WARNING_PHRASES = [
  "renews on", "renewal", "auto-renewal", "auto renew", "auto-renew", "next billing",
  "cancel before", "cancel by",
];

const BILLING_DUE_PHRASES = [
  "payment due", "upcoming payment", "next payment",
];

// Phase 3B.3.1: confirmed, evidence-based exclusions from the precision
// analysis — not a general-purpose blocklist mechanism, just these specific
// cases. recalltrial.app: the app's own reminder emails, sent to the same
// inbox being scanned, were being re-detected as third-party subscription
// evidence (real example: "[RecallTrial] YouTube Premium renews in 3
// days" -> classified as a genuine subscription_renewed). facebook.com /
// business-updates.facebook.com: Meta's ad-spend billing template, whose
// own snippet opens with "This is not an invoice" — 189/214 events in one
// scan were this exact template, matched purely because "receipt" appears
// in the subject. Checked against both the raw sender domain and its
// eTLD+1 root, so any subdomain of facebook.com is caught, not just this
// one exact hostname. Scoped to the sub-detector only (see call site) —
// does not touch the shared ingestion gate the trial pipeline also reads.
const KNOWN_NOISE_DOMAINS = new Set([
  "recalltrial.app",
  "facebook.com",
  "business-updates.facebook.com",
]);

export function isKnownNoiseDomain(domain: string): boolean {
  return KNOWN_NOISE_DOMAINS.has(domain) || KNOWN_NOISE_DOMAINS.has(getRootDomain(domain));
}

const ONE_TIME_PURCHASE_PHRASES = [
  "one-time", "one time purchase", "single purchase", "you purchased",
];

const TRIAL_STARTED_PHRASES = [
  "trial started", "free trial started", "trial has started", "trial begins",
  "your free trial", "trial period started",
];

const TRIAL_ENDING_PHRASES = [
  "trial ends", "trial ending", "trial expires", "trial expiring",
  "trial will end", "trial period ends",
];

// Baseline relevance signal for this detector, extending the trial
// pipeline's hasStrongPositive/hasRequiredTrigger gate with the new local
// categories above (cancellation/payment-failed/price-changed/one-time-
// purchase) — those phrases don't exist in the shared gmailKeywords.ts
// arrays the trial pipeline's own gate reads, on purpose (touching those
// arrays would change trial-detection behavior). Without this, a message
// containing e.g. only "your subscription has been cancelled" and nothing
// from STRONG_POSITIVES/REQUIRED_TRIGGERS would be rejected before ever
// reaching classification, even though it's clearly subscription-relevant.
function hasSubscriptionEventSignal(text: string): boolean {
  return (
    hasStrongPositive(text) ||
    hasRequiredTrigger(text) ||
    CANCELLATION_CONFIRMED_PHRASES.some((k) => text.includes(k)) ||
    PAYMENT_FAILED_PHRASES.some((k) => text.includes(k)) ||
    PRICE_CHANGE_PHRASES.some((k) => text.includes(k)) ||
    ONE_TIME_PURCHASE_PHRASES.some((k) => text.includes(k))
  );
}

// Mirrors resolveServiceName()'s payment-processor regex patterns above,
// for a yes/no "did we actually find a merchant name" signal used only in
// confidence scoring — kept separate rather than changing
// resolveServiceName()'s return shape, since that function is also called
// by the trial-suggestion pipeline and its contract must not change here.
const PROCESSOR_MERCHANT_PATTERNS = [
  /you subscribed to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s+for|\s+at|\s+\$)/i,
  /your ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?) subscription/i,
  /payment to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
  /charged by ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
  /from ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
];

// Exported for reuse by server/merchantResolver.ts (Phase 3B.3) — same
// "did resolveServiceName() find a genuine regex match vs. fall back to
// title-casing the processor's own domain" signal, reused rather than
// duplicated.
export function hasClearProcessorMerchant(snippet: string): boolean {
  return PROCESSOR_MERCHANT_PATTERNS.some((p) => p.test(snippet));
}

function hasBillingInterval(text: string): boolean {
  return /\b(monthly|month|\/mo\b|annual(?:ly)?|yearly|\/yr\b|\/year\b|per month|per year)\b/i.test(text);
}

// ─── Billing interval extraction (Phase 3B.9.2A) ──────────────────────────────
//
// STRONG phrases are multi-word or symbol-containing ("per month", "/mo",
// "billed annually") — inherently billing-shaped by construction, safe to
// trust standalone via a plain substring check (spaces/slashes already act
// as natural boundaries, so no accidental match inside an unrelated word).
//
// WEAK phrases are bare single words ("monthly", "annual", "weekly", ...)
// that commonly appear in non-billing contexts too ("monthly newsletter",
// "weekly digest") — these only count when the SAME message also carries
// independent billing/payment context (reuses hasRecurringLanguage(), a
// detected price, or an explicit billing/payment word). Matched with a
// \b...\b word-boundary regex specifically so "annual" never accidentally
// matches as a substring inside an unrelated word like "semiannual" (which
// is caught by its own STRONG phrase first anyway, since all STRONG phrases
// across every interval are checked before any WEAK phrase).
type BillingIntervalValue = "monthly" | "annual" | "quarterly" | "semi_annual" | "weekly" | "biweekly";

const BILLING_INTERVAL_PHRASES: Record<BillingIntervalValue, { strong: string[]; weak: string[] }> = {
  monthly: {
    strong: ["per month", "/month", "/mo", "billed monthly", "charged monthly", "each month", "every month"],
    weak: ["monthly"],
  },
  annual: {
    strong: ["per year", "/year", "/yr", "billed annually", "billed yearly", "charged annually"],
    weak: ["annual", "annually", "yearly"],
  },
  quarterly: {
    strong: ["every 3 months", "every three months", "per quarter"],
    weak: ["quarterly"],
  },
  semi_annual: {
    strong: ["semi-annual", "semiannual", "twice a year", "every 6 months", "every six months"],
    weak: [],
  },
  weekly: {
    strong: ["per week", "/week", "/wk"],
    weak: ["weekly"],
  },
  biweekly: {
    strong: ["every 2 weeks", "every two weeks"],
    weak: ["biweekly"],
  },
};

// Deliberately NOT reusing hasRecurringLanguage()/RECURRING_INDICATORS here:
// that shared array itself lists "monthly"/"annual"/"annually" as recurring
// signals, which would make this context gate circular — any message
// containing the bare word "monthly" would trivially satisfy its own
// "is there billing context" check. This pattern is self-contained and
// deliberately excludes the six ambiguous interval words themselves.
const BILLING_CONTEXT_PATTERN = /\$|\busd\b|\bprice\b|\bbilled\b|\bcharged?\b|\bpayment\b|\binvoice\b|\bsubscription\b|\brecurring\b|\bmembership\b|\bauto-?renew(?:s|al|ing)?\b|\brenews?\b|\brenewal\b|\brenewing\b/i;

function extractBillingIntervalFromSingleText(text: string): BillingIntervalValue | null {
  const lower = text.toLowerCase();

  for (const [interval, phrases] of Object.entries(BILLING_INTERVAL_PHRASES) as [BillingIntervalValue, { strong: string[]; weak: string[] }][]) {
    if (phrases.strong.some((p) => lower.includes(p))) {
      return interval;
    }
  }

  if (!BILLING_CONTEXT_PATTERN.test(lower)) return null;

  for (const [interval, phrases] of Object.entries(BILLING_INTERVAL_PHRASES) as [BillingIntervalValue, { strong: string[]; weak: string[] }][]) {
    if (phrases.weak.some((p) => new RegExp(`\\b${p}\\b`, "i").test(lower))) {
      return interval;
    }
  }

  return null;
}

/**
 * extractBillingInterval(): returns a specific recurrence interval only when
 * there's explicit, billing-connected textual evidence for it — never
 * guessed from price alone, never defaulted from the merchant. Returns null
 * whenever that evidence isn't there, which callers must treat as "unknown,"
 * not "monthly" (the common case) or any other assumed default.
 *
 * Phase 3B.9.7: `fullBodyText` is a fallback only, tried after `text`
 * (subject+snippet) finds nothing — the full email body frequently states
 * "monthly"/"billed annually" even when the truncated Gmail snippet doesn't.
 */
export function extractBillingInterval(text: string, fullBodyText?: string): BillingIntervalValue | null {
  const found = extractBillingIntervalFromSingleText(text);
  if (found) return found;
  if (fullBodyText) return extractBillingIntervalFromSingleText(fullBodyText);
  return null;
}

// Phase 3B.3.1: RECURRING_INDICATORS (gmailKeywords.ts, shared with the
// trial pipeline's passesReceiptFilter — left untouched here on purpose)
// only contains the literal "renews", so "to renew your Replit Core..."
// (real Google Play renewal email) didn't match at all — "renew" is not a
// substring of "renews". Added as a separate regex check, local to this
// detector only, rather than editing the shared array.
const RENEW_WORD_FAMILY = /\b(renew|renews|renewal|renewing)\b/i;

function hasRecurringLanguage(text: string): boolean {
  return RECURRING_INDICATORS.some((r) => text.includes(r)) || RENEW_WORD_FAMILY.test(text);
}

/** "from $19.99 to $23.99" style phrasing — only meaningful for price_changed. */
function extractPriceChangeAmounts(text: string): { previousPrice: string | null; newPrice: string | null } {
  const match = text.match(/from\s*[\$\£\€]?\s*(\d+(?:\.\d{2})?)[^\d]{1,15}to\s*[\$\£\€]?\s*(\d+(?:\.\d{2})?)/i);
  if (match) return { previousPrice: match[1], newPrice: match[2] };
  return { previousPrice: null, newPrice: null };
}

export type SubscriptionEventType =
  | "subscription_invoice" | "one_time_purchase" | "subscription_renewed"
  | "trial_started" | "trial_ending" | "subscription_cancelled"
  | "payment_failed" | "price_changed" | "unknown_subscription_event";

// ─── ARCHITECTURE RULE (Phase 3B.3.1, for Phase 3B.4 entity resolution) ────────
// "one_time_purchase" means the classifier positively determined this
// event is NOT recurring evidence (a genuine one-off charge, or the
// ambiguousOneTimeVsRecurring default when no recurring signal was found
// at all — see the classification chain below). When entity resolution is
// built, it must NOT fold one_time_purchase events into a subscription's
// evidence graph — a one-time charge is not proof of an ongoing
// commitment, and treating it as such would fabricate subscriptions that
// don't exist. Rows still get written to subscription_events (for
// analytics/audit — e.g. "how much one-time spend did we see") but must be
// filtered out before any future subscription-graph construction. Use this
// guard rather than re-deriving the exclusion ad hoc at each call site.
export function isSubscriptionEvidence(eventType: SubscriptionEventType): boolean {
  return eventType !== "one_time_purchase";
}

export type ExtractionSource = "snippet" | "body" | null;

export type SubscriptionEventCandidate = {
  eventType: SubscriptionEventType;
  extractedPrice: string | null;
  extractedCurrency: string | null;
  extractedDate: string | null;
  extractedMerchant: string | null;
  previousPrice: string | null;
  newPrice: string | null;
  confidence: number;
  billingInterval: string | null;
  // Phase 3B.9.7: which layer (snippet-only text vs. the second-stage full
  // body fetch) actually supplied each field — null when the field itself
  // is null (nothing was found in either layer).
  amountSource: ExtractionSource;
  intervalSource: ExtractionSource;
  dateSource: ExtractionSource;
};

/**
 * Independent confidence model for subscription events (Phase 3B.3 note:
 * this is per-event scoring, not the per-dimension confidence breakdown
 * PHASE1_AUDIT.md §13 describes for a future phase — that's a larger design
 * left for later; this directly implements Step 3's five boost/penalty
 * rules against real evidence).
 */
function scoreSubscriptionEventConfidence(params: {
  text: string;
  from: string;
  fromDomain: string;
  hasPrice: boolean;
  endDateSource: EndDateSource;
  isProcessorDomain: boolean;
  merchantClear: boolean;
  hasInterval: boolean;
  hasRecurring: boolean;
  ambiguousOneTimeVsRecurring: boolean;
}): number {
  let score = 20;

  // Explicit recurring language -> high boost
  if (params.hasRecurring) score += 30;

  // Known billing sender domain -> boost
  if (isBillingSender(params.from)) score += 10;

  // Price + billing interval both present -> boost (partial credit for price alone)
  if (params.hasPrice && params.hasInterval) score += 20;
  else if (params.hasPrice) score += 8;

  // Date quality, same spirit as the trial-pipeline scorer but smaller
  // weight — recurring language is the dominant signal here, not date.
  if (params.endDateSource === "explicit") score += 10;
  else if (params.endDateSource === "relative") score += 6;
  else if (params.endDateSource === "duration") score += 4;

  // Payment processor detected but merchant unclear -> penalty
  if (params.isProcessorDomain && !params.merchantClear) score -= 15;

  // No price detected -> penalty
  if (!params.hasPrice) score -= 12;

  // Ambiguous one-time vs recurring -> penalty
  if (params.ambiguousOneTimeVsRecurring) score -= 15;

  return Math.min(Math.max(score, 0), 95);
}

export function detectSubscriptionEvent(
  subject: string,
  snippet: string,
  from: string,
  dateHeader: string,
  // Phase 3B.9.7: optional second-stage full body text (already fetched via
  // fetchMessageBody() by the caller, already truncated/decoded). `null`/
  // undefined means Layer 2 wasn't available for this message — every
  // extractor below already treats that as "use snippet-only" gracefully.
  fullBodyText?: string | null
): SubscriptionEventCandidate | null {
  const combined = (subject + " " + snippet).toLowerCase();
  const body = fullBodyText ? fullBodyText.toLowerCase() : undefined;
  const receivedAt = dateHeader ? new Date(dateHeader) : new Date();

  // Must have SOME subscription-lifecycle signal at all, or there's
  // nothing to log — extends the trial pipeline's baseline gate with this
  // detector's own local phrase categories (see hasSubscriptionEventSignal).
  // Deliberately checked against `combined` (snippet layer) only, matching
  // the existing candidate gate exactly — the full body is never allowed to
  // manufacture a candidate that the snippet-only gate wouldn't have passed.
  if (!hasSubscriptionEventSignal(combined)) return null;

  // Each extractor is called once snippet-only and once with the body
  // fallback included, so the *Source fields below can report which layer
  // actually supplied the value — without changing extractAmount/
  // extractBillingInterval/extractDate's own return shapes.
  const dateSnippetOnly = extractDate(combined, receivedAt);
  const { date: extractedDate, source: endDateSource } = extractDate(combined, receivedAt, body);
  const dateSource: ExtractionSource = extractedDate === null ? null : (dateSnippetOnly.date ? "snippet" : "body");

  const amountSnippetOnly = extractAmount(combined);
  const { amount, currency } = extractAmount(combined, body);
  const amountSource: ExtractionSource = amount === null ? null : (amountSnippetOnly.amount ? "snippet" : "body");

  const fromDomain = extractDomainFromEmail(from);
  const isProcessorDomain = isPaymentProcessor(fromDomain);
  const merchantClear = !isProcessorDomain || hasClearProcessorMerchant(snippet);
  const extractedMerchant = resolveServiceName(fromDomain, snippet);
  const hasInterval = hasBillingInterval(combined);
  const hasRecurring = hasRecurringLanguage(combined);

  const intervalSnippetOnly = extractBillingInterval(combined);
  const billingInterval = extractBillingInterval(combined, body);
  const intervalSource: ExtractionSource = billingInterval === null ? null : (intervalSnippetOnly ? "snippet" : "body");

  let eventType: SubscriptionEventType;
  let previousPrice: string | null = null;
  let newPrice: string | null = null;
  let ambiguousOneTimeVsRecurring = false;

  // Phase 3B.3.1: trial_ending checked BEFORE trial_started. Real example
  // that motivated this: "Your Sell The Trend trial ends soon" (subject)
  // with a snippet that also recaps "Your free trial ... started on Jul
  // 11" — under started-first ordering, "your free trial" wins even though
  // the email is unambiguously a trial-ending warning (that's the subject
  // line). An email actively ending is the more urgent/relevant signal
  // when both phrases co-occur.
  if (TRIAL_ENDING_PHRASES.some((k) => combined.includes(k))) {
    eventType = "trial_ending";
  } else if (TRIAL_STARTED_PHRASES.some((k) => combined.includes(k))) {
    eventType = "trial_started";
  } else if (CANCELLATION_CONFIRMED_PHRASES.some((k) => combined.includes(k))) {
    eventType = "subscription_cancelled";
  } else if (PAYMENT_FAILED_PHRASES.some((k) => combined.includes(k))) {
    eventType = "payment_failed";
  } else if (PRICE_CHANGE_PHRASES.some((k) => combined.includes(k))) {
    eventType = "price_changed";
    const extracted = extractPriceChangeAmounts(combined);
    previousPrice = extracted.previousPrice;
    newPrice = extracted.newPrice;
  } else if (RENEWAL_WARNING_PHRASES.some((k) => combined.includes(k))) {
    eventType = "subscription_renewed";
  } else if (BILLING_DUE_PHRASES.some((k) => combined.includes(k))) {
    // "payment due" / "upcoming payment" / "next payment" — inherently
    // about an existing recurring arrangement, not a one-off purchase.
    eventType = "subscription_invoice";
  } else if (
    combined.includes("invoice") || combined.includes("receipt") || combined.includes("payment received") ||
    combined.includes("charge successful") || combined.includes("card charged") ||
    ONE_TIME_PURCHASE_PHRASES.some((k) => combined.includes(k))
  ) {
    // The core one-time-vs-recurring split: an explicit recurring keyword
    // co-occurring in THIS message settles it either way. If neither a
    // recurring nor a clearly-one-time signal is present, we genuinely
    // can't tell — flag it as ambiguous (confidence penalty) rather than
    // silently guessing one direction.
    if (hasRecurring) {
      eventType = "subscription_invoice";
    } else if (ONE_TIME_PURCHASE_PHRASES.some((k) => combined.includes(k))) {
      eventType = "one_time_purchase";
    } else {
      eventType = "one_time_purchase";
      ambiguousOneTimeVsRecurring = true;
    }
  } else {
    eventType = "unknown_subscription_event";
  }

  const confidence = scoreSubscriptionEventConfidence({
    text: combined,
    from,
    fromDomain,
    hasPrice: !!amount,
    endDateSource,
    isProcessorDomain,
    merchantClear,
    hasInterval,
    hasRecurring,
    ambiguousOneTimeVsRecurring,
  });

  return {
    eventType,
    extractedPrice: amount,
    extractedCurrency: currency,
    extractedDate,
    extractedMerchant,
    previousPrice,
    newPrice,
    confidence,
    billingInterval,
    amountSource,
    intervalSource,
    dateSource,
  };
}

// ─── Gmail list with pagination (Phase 3B.7.2) ────────────────────────────────
//
// Phase 3B.7.1's audit found that the old maxTotal=500 was a silent global
// cap: since it equaled Gmail's own per-page maximum, the do/while loop's
// `all.length < maxTotal` condition went false the instant page 1 filled up,
// so a second page was never actually fetched in any real scenario — any
// account with >500 matching messages in a phase silently lost the rest.
//
// Fixed shape: DEFAULT_MAX_SCAN_MESSAGES (overridable via MAX_SCAN_MESSAGES)
// is now an explicit, operator-visible safety limit, not an accidental page
// cap — pagination genuinely continues across pages until either Gmail runs
// out of results (pageToken exhausted) or the limit is hit. When the limit
// IS hit, this never happens silently: the caller gets back an exact
// totalAvailable (see below) and scanComplete=false to report on.

const DEFAULT_MAX_SCAN_MESSAGES = 5000;

export function getMaxScanMessages(): number {
  const raw = process.env.MAX_SCAN_MESSAGES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SCAN_MESSAGES;
}

export type ListMessagesResult = {
  ids: Array<{ id: string; phase: "A" | "B" }>;
  totalAvailable: number;
  scanComplete: boolean;
};

export async function listMessages(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
  maxScanMessages: number,
  phase: "A" | "B"
): Promise<ListMessagesResult> {
  const all: Array<{ id: string; phase: "A" | "B" }> = [];
  let totalAvailable = 0;
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500, // Gmail API's own hard per-call maximum
      ...(pageToken ? { pageToken } : {}),
    });
    const pageIds = res.data.messages || [];
    totalAvailable += pageIds.length;
    for (const m of pageIds) {
      if (m.id && all.length < maxScanMessages) all.push({ id: m.id, phase });
    }
    pageToken = res.data.nextPageToken || undefined;
    // Deliberately keep paginating past the cap: these list calls only
    // return message IDs (cheap) rather than the per-message metadata.get()
    // calls done later (expensive) — so continuing lets totalAvailable stay
    // an EXACT count instead of an estimate. Phase 3B.7.1 found Gmail's own
    // resultSizeEstimate field to be unreliable (it returned a smaller
    // number than an exact 90-day count in the same account), so this
    // scan deliberately does not rely on it anywhere.
  } while (pageToken);

  return { ids: all, totalAvailable, scanComplete: totalAvailable <= maxScanMessages };
}

// ─── Incremental scanning (Phase 3B.7.2) ──────────────────────────────────────
//
// users.lastEmailScanAt already existed and was already being written
// (PHASE1_AUDIT.md §7 flagged it as unused for this exact purpose) — this is
// the "read side" of that finding. Gmail's after:/before: search operators
// are DATE-granular (YYYY/MM/DD), not timestamp-granular, so scoping exactly
// to lastEmailScanAt's instant isn't possible; a 1-day overlap is subtracted
// so no message is ever missed due to that coarseness. Re-fetching a message
// already seen inside that overlap day is a guaranteed no-op, never a
// duplicate — decideCanonicalization() (Phase 3B.5) already makes every
// write in this pipeline idempotent regardless of how many times the same
// message is re-scanned.
export function buildScanTimeFilter(lastEmailScanAt: Date | null | undefined): string {
  if (!lastEmailScanAt) return "newer_than:90d";
  const overlapDate = new Date(lastEmailScanAt.getTime() - 24 * 60 * 60 * 1000);
  const y = overlapDate.getUTCFullYear();
  const m = String(overlapDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(overlapDate.getUTCDate()).padStart(2, "0");
  return `after:${y}/${m}/${d}`;
}

// ─── Gmail disconnect state reset (Account Switching audit, TASK 1) ────────────
//
// Pure mirror of the exact object server/storage.ts's clearUserGmailTokens()
// passes to `db.update(users).set(...)` — same "pure function mirrors the
// SQL write shape" pattern as server/aiCredits.ts's decideCreditBucket().
// Nulling lastEmailScanAt/lastScanMessagesProcessed alongside the token
// fields is the fix: without it, reconnecting a DIFFERENT Gmail account
// would have buildScanTimeFilter() reuse the DISCONNECTED account's last
// scan timestamp as the new account's search lower-bound, silently skipping
// any of its mail older than that date. Resetting to null means the very
// next scan — same account reconnected, or a genuinely different one —
// always starts from buildScanTimeFilter(null)'s full 90-day default.
export function buildGmailDisconnectUpdate(): {
  gmailAccessToken: null;
  gmailRefreshToken: null;
  gmailTokenExpiry: null;
  gmailConnected: false;
  lastEmailScanAt: null;
  lastScanMessagesProcessed: null;
} {
  return {
    gmailAccessToken: null,
    gmailRefreshToken: null,
    gmailTokenExpiry: null,
    gmailConnected: false,
    lastEmailScanAt: null,
    lastScanMessagesProcessed: null,
  };
}

// ─── Main scan function ───────────────────────────────────────────────────────

export type ScanResult = {
  suggestions: Array<Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status">>;
  scanComplete: boolean;
  messagesFound: number;
  messagesProcessed: number;
  messagesRemaining: number;
  scanStartedAt: Date;
  scanCompletedAt: Date;
};

export async function scanGmailForTrials(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiry: Date | null,
  // Added for Phase 2 Step 5's parallel subscription-event write path only.
  // Existing return shape and existing trial-write behavior are unchanged;
  // this is purely additive so the two existing callers can pass user.id,
  // which they already have in scope.
  userId?: string,
  // Phase 3B.7.2: null/undefined = first scan ever for this user (90-day
  // window, as before). Non-null = an incremental scan scoped to new mail
  // only via buildScanTimeFilter() above.
  lastEmailScanAt?: Date | null,
  // Phase 3B.9.9: the user's own aiScanningEnabled flag, passed through
  // rather than re-fetched per-message inside the loop (both existing
  // callers already have the full user row in scope). Purely additive,
  // defaults to false (no AI queueing) when omitted — existing callers/tests
  // that don't pass it keep behaving exactly as before.
  aiScanningEnabled?: boolean,
  // PHASE C (Account Isolation): the email_connections row id captured
  // ONCE at scan start, alongside the token snapshot above — same "capture
  // now, never re-read live state mid-scan" discipline the token params
  // already follow. Stamped onto every subscription_events row this scan
  // writes. Purely additive/optional: omitted (or the connection lookup
  // came back empty, e.g. a user who hasn't reconnected since PHASE B
  // shipped) means every event this scan writes gets emailConnectionId=null,
  // identical to pre-PHASE-C behavior.
  emailConnectionId?: string | null
): Promise<ScanResult> {
  const scanStartedAt = new Date();
  const gmail = buildGmailClient(accessToken, refreshToken, tokenExpiry);

  const timeFilter = buildScanTimeFilter(lastEmailScanAt);

  const phaseAQuery =
    `${timeFilter} -category:promotions (` +
    '"free trial has started" OR "trial started" OR "trial ends" OR "trial expires" OR ' +
    '"trial ending" OR "subscription started" OR "subscription is now active" OR ' +
    '"renews on" OR "next billing date" OR "will be charged on" OR "auto-renewal" OR ' +
    '"cancel before" OR "your trial" OR "free trial" OR "billing starts" OR ' +
    '"upcoming payment" OR "next payment" OR "payment due"' +
    ')';

  const phaseBQuery =
    `${timeFilter} -category:social -category:promotions (` +
    'subject:(trial OR subscription OR renewal OR invoice OR receipt OR billing)' +
    ')';

  const maxScanMessages = getMaxScanMessages();
  const [phaseAList, phaseBList] = await Promise.all([
    listMessages(gmail, phaseAQuery, maxScanMessages, "A"),
    listMessages(gmail, phaseBQuery, maxScanMessages, "B"),
  ]);
  const phaseAMsgs = phaseAList.ids;
  const phaseBMsgs = phaseBList.ids;

  // Combine + deduplicate by message_id (Phase A takes priority)
  const seenIds = new Map<string, "A" | "B">();
  for (const m of phaseAMsgs) seenIds.set(m.id, "A");
  for (const m of phaseBMsgs) { if (!seenIds.has(m.id)) seenIds.set(m.id, "B"); }
  const allMessages = Array.from(seenIds.entries()).map(([id, phase]) => ({ id, phase }));

  // Scan-completeness bookkeeping (Phase 3B.7.2 Step 1B). messagesFound/
  // messagesProcessed/messagesRemaining are all tracked PER PHASE against
  // each phase's own exact Gmail-reported total (listMessages'
  // totalAvailable) and summed — that's the only number that can
  // distinguish "the cap was hit" from "there just weren't more matching
  // messages," and keeps found - processed = remaining exact even though
  // Phase A/B overlap (allMessages below is the deduplicated set that
  // actually goes through the classify loop; messagesProcessed reports the
  // raw per-phase fetch count that determines scan completeness, not the
  // post-dedup work count).
  const messagesFound = phaseAList.totalAvailable + phaseBList.totalAvailable;
  const messagesFetched = phaseAMsgs.length + phaseBMsgs.length;
  const messagesRemaining = messagesFound - messagesFetched;
  const scanComplete = phaseAList.scanComplete && phaseBList.scanComplete;

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
  let subDetectorExcluded = 0;
  let subDetectorCandidates = 0;
  let subDetectorWritten = 0;
  // Phase 3B.9.7: Layer 2 (full body) benchmark counters — reported the same
  // way, never the body content itself.
  let subDetectorBodyFetched = 0;
  let subDetectorBodyUnavailable = 0;
  let subDetectorBodyCharsTotal = 0;
  let subDetectorBodyImproved = 0;
  let subDetectorCancellationUrlsFound = 0;

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

      // Noise-filter-gap fix: confirmed noise domains (recalltrial.app's
      // own reminder emails, Meta's ad-billing template) are now excluded
      // HERE, before EITHER pipeline runs. Previously this check (Phase
      // 3B.3.1) was scoped to the subscription-intelligence sub-detector
      // only — the ORIGINAL trial-suggestion pipeline below it (whose
      // filters only ever look at subject/snippet keywords, never sender
      // domain) had no noise-domain protection at all. That gap let a
      // RecallTrial reminder email like "[RecallTrial] YouTube Premium
      // renews in 3 days" pass straight through the trial pipeline's
      // keyword filters and get suggested as a trial for "Recalltrial"
      // itself, in addition to being independently caught (or, before this
      // fix, sometimes NOT caught depending on scan timing) by the
      // sub-detector. isKnownNoiseDomain() itself is unchanged — it already
      // correctly matches subdomains via getRootDomain(); the bug was
      // purely that only one of the two pipelines ever consulted it.
      if (isKnownNoiseDomain(fromDomain)) {
        if (userId) {
          subDetectorProcessed++;
          subDetectorExcluded++;
          console.log(`[SubDetector] excluded: ${fromDomain} (noise domain)`);
        }
        continue;
      }

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
          // Phase 3B.9.7 Layer 2: full body fetch, ONLY for messages that
          // already pass the same relevance gate detectSubscriptionEvent()
          // checks internally — checked here too so the (expensive) body
          // fetch is skipped entirely for messages that were never going to
          // produce a candidate anyway. The body itself never leaves this
          // block as anything other than a function argument: not logged,
          // not stored, not assigned outside this scope.
          let fullBodyText: string | null = null;
          if (hasSubscriptionEventSignal(combined)) {
            fullBodyText = await fetchMessageBody(gmail, msgId);
            if (fullBodyText) {
              subDetectorBodyFetched++;
              subDetectorBodyCharsTotal += fullBodyText.length;
              console.log(`[SubDetector] full body fetched for candidate ${msgId} (${fullBodyText.length} chars)`);
              if (extractCancellationUrl(subject + " " + snippet, fullBodyText)) {
                subDetectorCancellationUrlsFound++;
              }
            } else {
              subDetectorBodyUnavailable++;
              console.log(`[SubDetector] full body unavailable for ${msgId} (fallback to snippet only)`);
            }
          }

          const candidate = detectSubscriptionEvent(subject, snippet, from, dateStr, fullBodyText);
          if (candidate) {
            subDetectorCandidates++;
            if (candidate.amountSource === "body" || candidate.intervalSource === "body" || candidate.dateSource === "body") {
              subDetectorBodyImproved++;
            }
            // Phase 3B.3: canonical merchant/processor resolution, run
            // after classification using the same raw inputs plus the
            // classifier's own extractedMerchant guess. resolveMerchant()
            // never influences eventType/confidence above — it only adds
            // identity fields to what's already been decided. Dynamic
            // import for the same reason as the `storage` import below:
            // merchantResolver.ts itself imports from gmail.ts (reusing
            // resolveServiceName/getRootDomain/etc per Phase 3B.3's "reuse,
            // don't duplicate" instruction), so a static top-level import
            // here would be circular — deferring to call-time avoids that
            // rather than relying on function-hoisting semantics to make
            // an otherwise-circular static import safe.
            const { resolveMerchant } = await import("./merchantResolver");
            const merchantResolution = resolveMerchant({
              senderEmail: from,
              senderDomain: fromDomain,
              extractedMerchant: candidate.extractedMerchant,
              subject,
              snippet,
              eventType: candidate.eventType,
            });
            // Dynamic import: keeps gmail.ts free of a module-load-time
            // dependency on the storage/DB layer (which constructs a live
            // pg.Pool at import time), so the pure detection functions stay
            // safely importable in tests without a DATABASE_URL or DB-layer
            // alias resolution. Same lazy-import pattern already used
            // elsewhere in this codebase (e.g. stripeClient.ts).
            const { storage } = await import("./storage");
            const writtenRow = await storage.createSubscriptionEvent({
              userId,
              emailConnectionId: emailConnectionId ?? null,
              sourceMessageId: msgId,
              eventType: candidate.eventType,
              extractedPrice: candidate.extractedPrice,
              extractedCurrency: candidate.extractedCurrency,
              extractedDate: candidate.extractedDate,
              extractedMerchant: candidate.extractedMerchant,
              previousPrice: candidate.previousPrice,
              newPrice: candidate.newPrice,
              confidence: candidate.confidence,
              billingInterval: candidate.billingInterval,
              amountSource: candidate.amountSource,
              intervalSource: candidate.intervalSource,
              dateSource: candidate.dateSource,
              bodyFetched: !!fullBodyText,
              detectionSource: "deterministic",
              canonicalMerchantName: merchantResolution.canonicalMerchantName,
              canonicalMerchantDomain: merchantResolution.canonicalMerchantDomain,
              paymentProcessor: merchantResolution.paymentProcessor,
              merchantConfidence: merchantResolution.merchantConfidence,
              merchantResolutionStatus: merchantResolution.merchantResolutionStatus,
            });
            if (writtenRow) subDetectorWritten++;

            // Phase 3B.9.9 STEP 4: fire-and-forget AI enrichment queueing —
            // never awaited beyond the INSERT itself, never blocks or fails
            // the scan. isEligibleForAI() is checked against the row
            // ACTUALLY written (not the pre-write candidate), since the
            // source-aware conflict merge above may have preserved
            // different values than what this scan proposed.
            if (writtenRow) {
              try {
                const { isEligibleForAI } = await import("./aiEnrichment");
                if (isEligibleForAI(writtenRow, { aiScanningEnabled: !!aiScanningEnabled })) {
                  const queued = await storage.queueAIEnrichmentJob(userId, writtenRow.id);
                  if (queued) console.log(`[AI] queued enrichment job for event ${writtenRow.id}`);
                }
              } catch (aiQueueErr) {
                console.warn(`[AI] failed to queue enrichment job for event ${writtenRow.id}:`, aiQueueErr);
              }
            }
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
    const avgBodyChars = subDetectorBodyFetched > 0 ? Math.round(subDetectorBodyCharsTotal / subDetectorBodyFetched) : 0;
    console.log(
      `[SubDetector] processed ${subDetectorProcessed} messages, ${subDetectorExcluded} excluded, ${subDetectorCandidates} candidates, ${subDetectorWritten} written`
    );
    console.log(
      `[SubDetector] Layer 2: ${subDetectorBodyFetched} bodies fetched (avg ${avgBodyChars} chars), ${subDetectorBodyUnavailable} unavailable, ` +
      `${subDetectorBodyImproved} candidates improved by body, ${subDetectorCancellationUrlsFound} cancellation URLs found`
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

  const scanCompletedAt = new Date();

  if (userId) {
    console.log(
      `[SubDetector] scan complete=${scanComplete} found=${messagesFound} processed=${messagesFetched} ` +
      `remaining=${messagesRemaining} startedAt=${scanStartedAt.toISOString()} completedAt=${scanCompletedAt.toISOString()}`
    );
    if (!scanComplete) {
      console.log(
        `[SubDetector] scan partial: processed ${messagesFetched} of ${messagesFound} candidate messages`
      );
    }
  }

  return {
    suggestions: finalResults.map(({ _rootDomain, _priceKey, _dateKey, _isOngoing, _endDateSource, ...rest }) => rest),
    scanComplete,
    messagesFound,
    messagesProcessed: messagesFetched,
    messagesRemaining,
    scanStartedAt,
    scanCompletedAt,
  };
}

export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}
