import { google } from "googleapis";
import type { SuggestedTrial } from "@shared/schema";

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

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYMENT_PROCESSOR_DOMAINS = new Set([
  "stripe.com", "paypal.com", "apple.com", "google.com", "gumroad.com",
  "paddle.com", "fastspring.com", "lemonsqueezy.com", "chargebee.com",
  "recurly.com", "braintree.com", "2checkout.com", "klarna.com",
]);

const REQUIRED_TRIGGERS = [
  "trial has started", "trial started", "your trial", "trial ends",
  "trial expires", "trial will end", "trial expiration",
  "subscription started", "subscription is now active", "subscription activated",
  "renews on", "renewal", "next billing date", "next billing",
  "will be charged", "auto-renewal", "auto renew", "auto-renew",
  "cancel before", "cancel anytime before", "free trial",
];

const STRONG_NEGATIVES = [
  "shipping", "shipped", "your order has", "delivery", "out for delivery",
  "tracking number", "order delivered", "order confirmed",
  " job ", "interview", "job application", "job candidate",
  "court ", "hearing date", "legal notice", "trial date",
  "webinar", "register now", "join us live", "meetup",
  "newsletter", "weekly digest", "blog post", "announcement",
  "% off", "discount code", "promo code", "flash sale", "limited offer",
  "unsubscribe from", "manage preferences",
];

const RECURRING_INDICATORS = [
  "renews", "recurring", "monthly", "annual", "annually", "subscription",
  "membership", "auto-renew", "auto renew", "next billing date",
  "trial ends", "trial expires", "cancel before", "will be charged",
];

// ─── T002: Filter helpers ─────────────────────────────────────────────────────

function hasRequiredTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return REQUIRED_TRIGGERS.some((t) => lower.includes(t));
}

function hasStrongNegative(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONG_NEGATIVES.some((n) => lower.includes(n));
}

function passesReceiptFilter(text: string): boolean {
  const lower = text.toLowerCase();
  const hasReceipt = lower.includes("receipt") || lower.includes("invoice");
  if (!hasReceipt) return true;
  return RECURRING_INDICATORS.some((r) => lower.includes(r));
}

function hasOngoingSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return ["renews", "recurring", "auto-renew", "auto renew", "next billing", "will be charged"].some(
    (k) => lower.includes(k)
  );
}

// ─── T003: Service name resolution ───────────────────────────────────────────

function resolveServiceName(domain: string, snippet: string): string {
  const isPaymentProcessor = PAYMENT_PROCESSOR_DOMAINS.has(domain) ||
    [...PAYMENT_PROCESSOR_DOMAINS].some((d) => domain.endsWith("." + d));

  if (isPaymentProcessor) {
    const patterns = [
      /you subscribed to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s+for|\s+at|\s+\$)/i,
      /your ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?) subscription/i,
      /payment to ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40?})(?:\.|,|!|\s)/i,
      /charged by ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
      /from ([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40}?)(?:\.|,|!|\s)/i,
    ];
    for (const pattern of patterns) {
      const match = snippet.match(pattern);
      if (match && match[1]) {
        const name = match[1]
          .replace(/\b(Inc|LLC|Corp|Ltd|Co|GmbH|SAS|BV)\.?\b/gi, "")
          .replace(/[^\w\s\-]/g, "")
          .trim();
        if (name.length >= 2) return name;
      }
    }
  }

  const parts = domain.split(".");
  if (parts.length >= 2) {
    const name = parts[parts.length - 2];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return domain;
}

function extractDomainFromEmail(email: string): string {
  const match = email.match(/@([^>]+)/);
  return match ? match[1].toLowerCase().trim() : "";
}

// ─── T004: Date extraction ────────────────────────────────────────────────────

function extractDate(text: string, receivedAt: Date): string | null {
  const today = new Date();

  // Priority context patterns — specific billing/lifecycle phrases
  const priorityPatterns = [
    /next billing date[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /next billing (?:date )?is ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
    /renews on ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /will be charged on ([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:trial ends?|trial expires?|ends?|expir(?:es?|ation)|valid until|cancel (?:by|before)|charged on|due on)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /(?:trial ends?|trial expires?|ends?|expir(?:es?|ation)|valid until|cancel (?:by|before)|charged on|due on)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?)/i,
  ];

  for (const pattern of priorityPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const raw = match[1].replace(/(?:st|nd|rd|th)/i, "").trim();
      const withYear = raw.match(/\d{4}/) ? raw : `${raw}, ${today.getFullYear()}`;
      const d = new Date(withYear);
      if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
        if (d < today) d.setFullYear(today.getFullYear() + 1);
        return d.toISOString().slice(0, 10);
      }
    }
  }

  // "ends on the 6th" → infer month/year from receivedAt
  const ordinalDayMatch = text.match(/(?:ends?|expir(?:es?|ation)|cancel by|renews?) on the (\d{1,2})(?:st|nd|rd|th)/i);
  if (ordinalDayMatch) {
    const day = parseInt(ordinalDayMatch[1]);
    const d = new Date(receivedAt);
    d.setDate(day);
    if (d < today) d.setMonth(d.getMonth() + 1);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // "ends in X days"
  const inDaysMatch = text.match(/(?:ends?|expir(?:es?|ation)|trial ends?|trial will end)\s+in\s+(\d+)\s+days?/i);
  if (inDaysMatch) {
    const d = new Date(receivedAt.getTime() + parseInt(inDaysMatch[1]) * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Ordinal full dates: "March 6th, 2026", "6th of March 2026"
  const ordinalPatterns = [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s*(\d{4})\b/i,
  ];
  for (const p of ordinalPatterns) {
    const match = text.match(p);
    if (match) {
      try {
        const d = new Date(match[0].replace(/(?:st|nd|rd|th)/i, ""));
        if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
          return d.toISOString().slice(0, 10);
        }
      } catch { /* skip */ }
    }
  }

  // Standard absolute dates
  const standardPatterns = [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
  ];
  for (const p of standardPatterns) {
    const match = text.match(p);
    if (match) {
      try {
        const d = new Date(match[0]);
        if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
          return d.toISOString().slice(0, 10);
        }
      } catch { /* skip */ }
    }
  }

  // Short month+day: "Mar 6", "March 6" (infer year)
  const shortMatch = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (shortMatch) {
    const d = new Date(`${shortMatch[0]}, ${today.getFullYear()}`);
    if (!isNaN(d.getTime())) {
      if (d < today) d.setFullYear(today.getFullYear() + 1);
      return d.toISOString().slice(0, 10);
    }
  }

  return null;
}

function extractTrialDuration(text: string, receivedAt: Date): string | null {
  const dayMatch = text.match(/(\d+)[-\s]day(?:s)?\s+(?:free\s+)?trial/i) ||
                   text.match(/trial\s+(?:for|of|period(?:\s+of)?)\s+(\d+)\s+days?/i);
  if (dayMatch) {
    const d = new Date(receivedAt.getTime() + parseInt(dayMatch[1]) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const monthMatch = text.match(/(\d+)[-\s]month(?:s)?\s+(?:free\s+)?(?:trial|plan|subscription)/i) ||
                     text.match(/(?:trial|plan)\s+(?:for|of)\s+(\d+)\s+months?/i);
  if (monthMatch) {
    const d = new Date(receivedAt);
    d.setMonth(d.getMonth() + parseInt(monthMatch[1]));
    return d.toISOString().slice(0, 10);
  }

  const weekMatch = text.match(/(\d+)[-\s]week(?:s)?\s+(?:free\s+)?trial/i);
  if (weekMatch) {
    const d = new Date(receivedAt.getTime() + parseInt(weekMatch[1]) * 7 * 86400000);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

// ─── Amount extraction ────────────────────────────────────────────────────────

function extractAmount(text: string): { amount: string | null; currency: string } {
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

// ─── T005: Confidence scoring ─────────────────────────────────────────────────

export function scoreConfidenceDetailed(
  subject: string,
  snippet: string,
  hasDate: boolean,
  hasPrice: boolean
): { score: number; breakdown: Array<{ label: string; points: number }> } {
  const text = (subject + " " + snippet).toLowerCase();
  const breakdown: Array<{ label: string; points: number }> = [];
  let score = 30;

  const add = (label: string, points: number) => {
    score += points;
    breakdown.push({ label, points });
  };

  if (REQUIRED_TRIGGERS.some((t) => text.includes(t))) add("Lifecycle trigger", 30);
  if (["renews", "recurring", "auto-renew", "next billing", "will be charged"].some((k) => text.includes(k))) add("Renewal/billing phrase", 15);
  if (hasDate) add("Date detected", 10);
  if (hasPrice) add("Price detected", 10);
  if (["free trial", "free trial has started", "starter plan free trial"].some((k) => text.includes(k))) add("Free trial confirmed", 10);
  if (!passesReceiptFilter(text)) { score -= 25; breakdown.push({ label: "Receipt without recurring indicator", points: -25 }); }

  return { score: Math.min(Math.max(score, 0), 95), breakdown };
}

// ─── Gmail list with pagination ───────────────────────────────────────────────

async function listMessages(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
  maxTotal: number
): Promise<Array<{ id: string; phase: "A" | "B" }>> {
  const phase = query.includes("-category:promotions") ? "A" : "B";
  const allMessages: Array<{ id: string; phase: "A" | "B" }> = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(500, maxTotal - allMessages.length),
      ...(pageToken ? { pageToken } : {}),
    });

    const msgs = res.data.messages || [];
    for (const m of msgs) {
      if (m.id) allMessages.push({ id: m.id, phase });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && allMessages.length < maxTotal);

  return allMessages;
}

// ─── Main scan function ───────────────────────────────────────────────────────

export async function scanGmailForTrials(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiry: Date | null
): Promise<Array<Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status">>> {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
    expiry_date: tokenExpiry?.getTime(),
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // T001: Two-phase search
  const phaseAQuery =
    'newer_than:90d -category:promotions (' +
    '"free trial has started" OR "trial started" OR "trial ends" OR "trial expires" OR ' +
    '"subscription started" OR "subscription is now active" OR "renews on" OR ' +
    '"next billing date" OR "will be charged on" OR "auto-renewal" OR "cancel before" OR ' +
    '"your trial" OR "free trial"' +
    ')';

  const phaseBQuery =
    'newer_than:90d -category:social (' +
    'subject:(trial OR subscription OR renewal OR invoice OR receipt OR billing)' +
    ')';

  const [phaseAMsgs, phaseBMsgs] = await Promise.all([
    listMessages(gmail, phaseAQuery, 500),
    listMessages(gmail, phaseBQuery, 500),
  ]);

  // Combine + deduplicate by message_id, Phase A takes priority
  const seenIds = new Map<string, "A" | "B">();
  for (const m of phaseAMsgs) seenIds.set(m.id, "A");
  for (const m of phaseBMsgs) { if (!seenIds.has(m.id)) seenIds.set(m.id, "B"); }

  const allMessages = Array.from(seenIds.entries()).map(([id, phase]) => ({ id, phase }));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  type RawResult = Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status"> & {
    _serviceKey: string;
    _price: string | null;
    _isOngoing: boolean;
  };
  const rawResults: RawResult[] = [];

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
      const combinedText = subject + " " + snippet;

      const fromDomain = extractDomainFromEmail(from);
      if (!fromDomain || fromDomain.includes("gmail.com")) continue;

      // T002: Apply filters
      if (hasStrongNegative(combinedText)) continue;
      if (!passesReceiptFilter(combinedText)) continue;
      // Phase B requires a required trigger; Phase A already matched strong terms
      if (phase === "B" && !hasRequiredTrigger(combinedText)) continue;

      const receivedAt = dateStr ? new Date(dateStr) : new Date();
      const isOngoing = hasOngoingSignal(combinedText);

      // T004: Date extraction
      let endDateGuess = extractDate(combinedText, receivedAt);
      if (!endDateGuess) endDateGuess = extractTrialDuration(combinedText, receivedAt);

      // T006: Validity — reject if end date exists and is in the past with no ongoing signal
      if (endDateGuess) {
        const endDate = new Date(endDateGuess);
        if (endDate < today && !isOngoing) continue;
        if (endDate < today) endDateGuess = null; // clear stale date but keep if ongoing
      }

      const { amount, currency } = extractAmount(combinedText);

      // T003: Service name resolution
      const serviceGuess = resolveServiceName(fromDomain, snippet);
      const { score: confidence } = scoreConfidenceDetailed(subject, snippet, !!endDateGuess, !!amount);

      if (confidence < 40) continue;

      // T005: Dedupe key includes price + date to allow up to 2 per service
      const priceKey = amount ? `_${amount}` : "";
      const dateKey = endDateGuess ? `_${endDateGuess}` : "";
      const serviceKey = `${serviceGuess.toLowerCase()}${priceKey}${dateKey}`;

      rawResults.push({
        _serviceKey: serviceKey,
        _price: amount,
        _isOngoing: isOngoing,
        provider: "gmail",
        messageId: msgId,
        fromEmail: from,
        fromDomain,
        subject: subject.slice(0, 255),
        receivedAt,
        serviceGuess,
        endDateGuess: endDateGuess || null,
        amountGuess: amount || null,
        currencyGuess: currency,
        confidence,
      });
    } catch {
      // skip individual message errors
    }
  }

  // T005: Dedupe — keep highest confidence per unique key, max 2 per base service name
  const bestByKey = new Map<string, RawResult>();
  for (const r of rawResults) {
    const existing = bestByKey.get(r._serviceKey);
    if (!existing || r.confidence > existing.confidence) {
      bestByKey.set(r._serviceKey, r);
    }
  }

  // Enforce max 2 per base service name
  const countPerService = new Map<string, number>();
  const finalResults: RawResult[] = [];
  for (const r of bestByKey.values()) {
    const baseName = r.serviceGuess.toLowerCase();
    const count = countPerService.get(baseName) || 0;
    if (count < 2) {
      finalResults.push(r);
      countPerService.set(baseName, count + 1);
    }
  }

  return finalResults.map(({ _serviceKey, _price, _isOngoing, ...rest }) => rest);
}

export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}
