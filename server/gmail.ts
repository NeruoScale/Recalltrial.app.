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

function extractDate(text: string): string | null {
  // Matches: "March 4, 2026", "Mar 4, 2026", "04/03/2026", "2026-03-04"
  const patterns = [
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const d = new Date(match[0]);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) {
          return d.toISOString().slice(0, 10);
        }
      } catch {
        // skip
      }
    }
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

function scoreConfidence(subject: string, snippet: string): number {
  const text = (subject + " " + snippet).toLowerCase();
  let score = 30;
  if (text.includes("free trial")) score += 25;
  if (text.includes("trial")) score += 15;
  if (text.includes("renew") || text.includes("renewal")) score += 20;
  if (text.includes("subscription")) score += 15;
  if (text.includes("will be charged") || text.includes("charge")) score += 20;
  if (text.includes("cancel")) score += 10;
  if (text.includes("invoice") || text.includes("receipt")) score += 10;
  return Math.min(score, 95);
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
    "newer_than:60d (subject:(trial OR subscription OR renewal OR receipt OR invoice) OR \"free trial\" OR \"renews on\" OR \"will be charged\")";

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  const messages = listRes.data.messages || [];
  const results: Array<Omit<SuggestedTrial, "id" | "userId" | "createdAt" | "status">> = [];

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
      const endDateGuess = extractDate(combinedText);
      const { amount, currency } = extractAmount(combinedText);
      const confidence = scoreConfidence(subject, snippet);
      const receivedAt = dateStr ? new Date(dateStr) : new Date();

      results.push({
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

  return results;
}

export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}
