import { google } from "googleapis";
import type { SuggestedTrial } from "@shared/schema";

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

function extractDomainFromEmail(email: string): string {
  const match = email.match(/@([^>]+)/);
  return match ? match[1].toLowerCase() : "";
}

function extractServiceName(domain: string): string {
  const parts = domain.split(".");
  if (parts.length >= 2) {
    const name = parts[parts.length - 2];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return domain;
}

function extractDate(text: string, receivedAt: Date): string | null {
  const today = new Date();

  // Context-aware: "ends on March 6", "expires March 6", "valid until March 6", "through March 6", "before March 6"
  const contextPatterns = [
    /(?:ends?|expir(?:es?|ation)|valid until|through|before|renew(?:s|al)? on|charged on|due on|cancel by|cancel before)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
    /(?:ends?|expir(?:es?|ation)|valid until|through|before|renew(?:s|al)? on|charged on|due on|cancel by|cancel before)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?)/i,
  ];

  for (const pattern of contextPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const raw = match[1].replace(/(?:st|nd|rd|th)/, "").trim();
      const d = new Date(raw + (raw.match(/\d{4}/) ? "" : `, ${today.getFullYear()}`));
      if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
        return d.toISOString().slice(0, 10);
      }
    }
  }

  // "ends in X days" → compute from receivedAt
  const inDaysMatch = text.match(/(?:ends?|expir(?:es?|ation)|trial ends?)\s+in\s+(\d+)\s+days?/i);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1]);
    const d = new Date(receivedAt.getTime() + days * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Ordinal dates: "March 6th, 2026", "6th of March"
  const ordinalPatterns = [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s*(\d{4})\b/i,
  ];
  for (const pattern of ordinalPatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const d = new Date(match[0].replace(/(?:st|nd|rd|th)/, ""));
        if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
          return d.toISOString().slice(0, 10);
        }
      } catch { /* skip */ }
    }
  }

  // Standard patterns: "March 4, 2026", "04/03/2026", "2026-03-04"
  const standardPatterns = [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
  ];
  for (const pattern of standardPatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const d = new Date(match[0]);
        if (!isNaN(d.getTime()) && d.getFullYear() >= today.getFullYear()) {
          return d.toISOString().slice(0, 10);
        }
      } catch { /* skip */ }
    }
  }

  // Short month+day: "Mar 6", "March 6" (assume current or next year)
  const shortDateMatch = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (shortDateMatch) {
    const d = new Date(`${shortDateMatch[0]}, ${today.getFullYear()}`);
    if (!isNaN(d.getTime())) {
      if (d < today) d.setFullYear(today.getFullYear() + 1);
      return d.toISOString().slice(0, 10);
    }
  }

  return null;
}

function extractTrialDuration(text: string, receivedAt: Date): string | null {
  // "14-day free trial", "30 day trial", "7 days", "1-month trial", "2 months"
  const dayMatch = text.match(/(\d+)[-\s]day(?:s)?\s+(?:free\s+)?trial/i) ||
                   text.match(/trial\s+(?:for|of|period(?:\s+of)?)\s+(\d+)\s+days?/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1]);
    const d = new Date(receivedAt.getTime() + days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const monthMatch = text.match(/(\d+)[-\s]month(?:s)?\s+(?:free\s+)?(?:trial|plan|subscription)/i) ||
                     text.match(/(?:trial|plan)\s+(?:for|of)\s+(\d+)\s+months?/i);
  if (monthMatch) {
    const months = parseInt(monthMatch[1]);
    const d = new Date(receivedAt);
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  // "1 week trial", "2 week"
  const weekMatch = text.match(/(\d+)[-\s]week(?:s)?\s+(?:free\s+)?trial/i);
  if (weekMatch) {
    const weeks = parseInt(weekMatch[1]);
    const d = new Date(receivedAt.getTime() + weeks * 7 * 86400000);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function extractAmount(text: string): { amount: string | null; currency: string } {
  const match = text.match(/[\$\£\€]?\s*(\d+(?:\.\d{2})?)\s*(?:USD|EUR|GBP|QAR)?/i);
  if (match) {
    const currencyMatch = text.match(/(\$|£|€|USD|EUR|GBP|QAR)/i);
    let currency = "USD";
    if (currencyMatch) {
      const c = currencyMatch[1].toUpperCase();
      if (c === "$") currency = "USD";
      else if (c === "£") currency = "GBP";
      else if (c === "€") currency = "EUR";
      else currency = c;
    }
    return { amount: match[1], currency };
  }
  return { amount: null, currency: "USD" };
}

export function scoreConfidenceDetailed(subject: string, snippet: string): {
  score: number;
  breakdown: Array<{ label: string; points: number }>;
} {
  const text = (subject + " " + snippet).toLowerCase();
  const breakdown: Array<{ label: string; points: number }> = [];
  let score = 30;

  const check = (label: string, keywords: string[], points: number) => {
    if (keywords.some((k) => text.includes(k))) {
      score += points;
      breakdown.push({ label, points });
    }
  };

  check("Free trial", ["free trial", "free trial has started", "starter plan free trial"], 30);
  check("Trial period", ["trial period", "trial begins", "trial has started", "trial started", "your trial"], 20);
  check("Trial keyword", ["trial"], 15);
  check("Renewal", ["renew", "renewal", "renews on"], 20);
  check("Subscription", ["subscription", "subscription started", "billing starts"], 15);
  check("Upcoming charge", ["will be charged", "charge", "before you're charged", "your card will be"], 25);
  check("First payment", ["first payment", "payment due", "billing starts"], 20);
  check("Cancellation", ["cancel before", "cancel anytime", "cancel"], 15);
  check("Invoice/Receipt", ["invoice", "receipt"], 10);
  check("Expiry signal", ["expires", "expiration", "trial ends", "trial will end"], 15);
  check("Welcome/Plan start", ["welcome to your", "starter plan", "plan starts", "your plan"], 10);

  return { score: Math.min(score, 95), breakdown };
}

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

  const query =
    'newer_than:90d (' +
    '"free trial" OR "trial period" OR "trial has started" OR "trial begins" OR ' +
    '"trial ends" OR "trial expires" OR "trial will end" OR "trial expiration" OR ' +
    '"your trial" OR "starter plan" OR "free trial has started" OR ' +
    '"welcome to your" OR "plan starts" OR "subscription started" OR ' +
    '"billing starts" OR "first payment" OR "payment due" OR ' +
    '"renews on" OR "will be charged" OR "before you\'re charged" OR ' +
    '"cancel before" OR "cancel anytime" OR "your card will be" OR ' +
    'subject:(trial OR subscription OR renewal OR receipt OR invoice OR billing)' +
    ')';

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 100,
  });

  const messages = listRes.data.messages || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rawResults: Array<Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status"> & { _serviceKey: string }> = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    try {
      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
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

      const fromDomain = extractDomainFromEmail(from);
      if (!fromDomain || fromDomain.includes("google.com") || fromDomain.includes("gmail.com")) continue;

      const serviceGuess = extractServiceName(fromDomain);
      const combinedText = subject + " " + snippet;
      const receivedAt = dateStr ? new Date(dateStr) : new Date();

      // Try date extraction then fall back to duration extraction
      let endDateGuess = extractDate(combinedText, receivedAt);
      if (!endDateGuess) {
        endDateGuess = extractTrialDuration(combinedText, receivedAt);
      }

      // Skip if end date is already in the past
      if (endDateGuess) {
        const endDate = new Date(endDateGuess);
        if (endDate < today) {
          endDateGuess = null;
        }
      }

      const { amount, currency } = extractAmount(combinedText);
      const { score: confidence } = scoreConfidenceDetailed(subject, snippet);

      rawResults.push({
        _serviceKey: serviceGuess.toLowerCase(),
        provider: "gmail",
        messageId: msg.id,
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

  // Deduplicate by service name — keep the one with highest confidence per service
  const bestByService = new Map<string, typeof rawResults[0]>();
  for (const r of rawResults) {
    const existing = bestByService.get(r._serviceKey);
    if (!existing || r.confidence > existing.confidence) {
      bestByService.set(r._serviceKey, r);
    }
  }

  return Array.from(bestByService.values()).map(({ _serviceKey, ...rest }) => rest);
}

export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}
