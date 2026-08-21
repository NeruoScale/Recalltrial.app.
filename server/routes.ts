import type { Express, Request, Response, NextFunction } from "express";
import { type Server } from "http";
import session from "express-session";
import { storage } from "./storage";
import { signupSchema, loginSchema, insertTrialSchema } from "@shared/schema";
import { extractDomain, getIconUrl } from "./icon";
import { sendReminderEmail, sendTestEmail, sendPasswordResetEmail } from "./email";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { searchServices } from "./serviceSearch";
import { generateAuthUrl, exchangeCodeForTokens, revokeToken, scanGmailForTrials, isGoogleConfigured } from "./gmail";
import { backfillCanonicalEventBodies } from "./backfillBodyExtraction";
import { processAIEnrichmentBatch } from "./aiEnrichmentQueue";
import { computeReminders, getTimezoneOffsetMs } from "./reminderScheduling";
import { calculateSubscriptionCosts, calculateUpcomingCharges } from "./subscriptionCostEngine";
import { calculateRenewalCalendar } from "./renewalCalendar";
import { buildSubscriptionVaultResponse, determineSubscriptionAccessResult } from "./subscriptionVault";

const FREE_TRIAL_LIMIT = 3;
const BILLING_ENABLED = process.env.BILLING_ENABLED === "true";

function getTrialLimit(plan: string): number | null {
  if (plan === "PLUS" || plan === "PRO" || plan === "PREMIUM") return null;
  return FREE_TRIAL_LIMIT;
}

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

function requireBilling(_req: Request, res: Response, next: NextFunction) {
  if (!BILLING_ENABLED) {
    return res.status(404).json({ message: "Not found" });
  }
  next();
}

async function requirePro(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
  const user = await storage.getUserById(req.session.userId);
  if (!user || (user.plan !== "PRO" && user.plan !== "PREMIUM")) {
    return res.status(403).json({ code: "PRO_REQUIRED", message: "This feature requires a Pro plan." });
  }
  (req as any).currentUser = user;
  next();
}

async function requireEmailScanning(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ message: "Not authenticated" });
  const user = (req as any).currentUser || (await storage.getUserById(req.session.userId));
  if (!user || (user.plan !== "PRO" && user.plan !== "PREMIUM")) {
    return res.status(403).json({ code: "PRO_REQUIRED", message: "This feature requires a Pro plan." });
  }
  if (!user.emailScanningEnabled) {
    return res.status(403).json({ code: "SCANNING_NOT_ENABLED", message: "Email scanning is not enabled." });
  }
  (req as any).currentUser = user;
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const PgStore = connectPgSimple(session);

  app.use(
    session({
      store: new PgStore({ pool: pool, createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET || "recalltrial-dev-secret",
      resave: false,
      saveUninitialized: false,
      proxy: true,
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: "none",
      },
    })
  );

  app.post("/api/auth/signup", async (req: Request, res: Response) => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { email: rawEmail, password } = parsed.data;
      const email = rawEmail.trim().toLowerCase();
      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "Email already registered" });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await storage.createUser(email, passwordHash);
      req.session.userId = user.id;
      storage.logEvent(user.id, "signup", { email });
      return res.json({ id: user.id, email: user.email, timezone: user.timezone });
    } catch (err) {
      console.error("Signup error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { email: rawEmail, password } = parsed.data;
      const email = rawEmail.trim().toLowerCase();
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ message: "Invalid email or password" });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid email or password" });
      }
      req.session.userId = user.id;
      storage.logEvent(user.id, "login", { email });
      return res.json({ id: user.id, email: user.email, timezone: user.timezone });
    } catch (err) {
      console.error("Login error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required" });
      }
      const user = await storage.getUserByEmail(email.trim().toLowerCase());
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await storage.createPasswordResetToken(user.id, token, expiresAt);
        const appUrl = process.env.APP_URL || 'https://recalltrial.app';
        const resetUrl = `${appUrl}/auth/reset-password?token=${token}`;
        await sendPasswordResetEmail(user.email, resetUrl);
      }
      return res.json({ message: "If an account exists with that email, we've sent a password reset link." });
    } catch (err) {
      console.error("Forgot password error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ message: "Reset token is required" });
      }
      if (!password || typeof password !== "string" || password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const success = await storage.consumePasswordResetToken(token, passwordHash);
      if (!success) {
        return res.status(400).json({ message: "Invalid or expired reset link. Please request a new one." });
      }
      return res.json({ message: "Password has been reset. You can now log in." });
    } catch (err) {
      console.error("Reset password error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.get("/api/auth/me", requireAuth, async (req: Request, res: Response) => {
    const user = await storage.getUserById(req.session.userId!);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeCount = await storage.countActiveTrials(user.id);
    const limit = getTrialLimit(user.plan);
    return res.json({
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      currentPeriodEnd: user.currentPeriodEnd,
      activeTrialCount: activeCount,
      trialLimit: limit,
      billingEnabled: BILLING_ENABLED,
      emailScanningEnabled: user.emailScanningEnabled,
      aiScanningEnabled: user.aiScanningEnabled,
      gmailConnected: user.gmailConnected,
      lastEmailScanAt: user.lastEmailScanAt,
      createdAt: user.createdAt,
    });
  });

  app.patch("/api/auth/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const { timezone, emailScanningEnabled } = req.body;

      if (emailScanningEnabled !== undefined) {
        const user = await storage.getUserById(userId);
        if (!user || (user.plan !== "PRO" && user.plan !== "PREMIUM")) {
          return res.status(403).json({ code: "PRO_REQUIRED", message: "Email scanning requires Pro." });
        }
        const updated = await storage.toggleEmailScanning(userId, !!emailScanningEnabled);
        return res.json({ emailScanningEnabled: updated.emailScanningEnabled });
      }

      if (!timezone || typeof timezone !== "string") {
        return res.status(400).json({ message: "Invalid timezone" });
      }
      const user = await storage.updateUserTimezone(userId, timezone);
      return res.json({ id: user.id, email: user.email, timezone: user.timezone });
    } catch (err) {
      console.error("Settings error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Pre-3B.9.9 Privacy Gate: dedicated AI-scanning-consent endpoints,
  // separate from the existing /api/auth/settings (timezone +
  // emailScanningEnabled) — this setting governs a materially different
  // decision (sending email content to an external AI provider) and is
  // deployed ahead of the AI enrichment engine itself so the opt-in surface
  // exists before there's anything for it to gate. Deliberately no Pro-plan
  // gate here (unlike emailScanningEnabled's PRO_REQUIRED check) — nothing
  // in this pre-gate phase depends on plan, and adding a plan restriction
  // is a product decision for Phase 3B.9.9 itself, not this one.
  app.get("/api/user/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });
      return res.json({ aiScanningEnabled: user.aiScanningEnabled });
    } catch (err) {
      console.error("Get user settings error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.patch("/api/user/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { aiScanningEnabled } = req.body;
      if (typeof aiScanningEnabled !== "boolean") {
        return res.status(400).json({ message: "aiScanningEnabled must be a boolean" });
      }
      const updated = await storage.toggleAiScanning(req.session.userId!, aiScanningEnabled);
      return res.json({ aiScanningEnabled: updated.aiScanningEnabled });
    } catch (err) {
      console.error("Update user settings error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // ===== GMAIL ROUTES =====

  app.get("/api/gmail/connect", requireAuth, requirePro, async (req: Request, res: Response) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({ message: "Google OAuth is not configured on this server." });
    }
    const url = generateAuthUrl(req.session.userId!);
    return res.redirect(url);
  });

  app.get("/api/gmail/callback", async (req: Request, res: Response) => {
    const appUrl = process.env.APP_URL || "";
    try {
      const { code, state: userId } = req.query as { code?: string; state?: string };
      if (!code || !userId) {
        return res.redirect(`${appUrl}/settings?gmailError=missing_params`);
      }
      const tokens = await exchangeCodeForTokens(code);
      await storage.updateUserGmailTokens(userId, tokens);
      return res.redirect(`${appUrl}/settings?gmailConnected=1`);
    } catch (err) {
      console.error("Gmail callback error:", err);
      return res.redirect(`${appUrl}/settings?gmailError=callback_failed`);
    }
  });

  app.post("/api/gmail/disconnect", requireAuth, requirePro, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "Not found" });
      if (user.gmailAccessToken) {
        await revokeToken(user.gmailAccessToken);
      }
      await storage.clearUserGmailTokens(req.session.userId!);
      return res.json({ success: true });
    } catch (err) {
      console.error("Gmail disconnect error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/gmail/scan", requireAuth, requirePro, requireEmailScanning, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "Not found" });
      if (!user.gmailConnected || !user.gmailAccessToken) {
        return res.status(400).json({ message: "Gmail is not connected." });
      }

      const scanResult = await scanGmailForTrials(
        user.gmailAccessToken,
        user.gmailRefreshToken,
        user.gmailTokenExpiry,
        user.id,
        user.lastEmailScanAt,
        user.aiScanningEnabled
      );
      const { suggestions } = scanResult;

      let newCount = 0;
      for (const s of suggestions) {
        await storage.upsertSuggestedTrial({ ...s, userId: user.id });
        newCount++;
      }

      await storage.updateLastEmailScan(user.id, scanResult.messagesProcessed);
      storage.logEvent(user.id, "email_scan", { foundCount: suggestions.length });

      return res.json({
        success: true,
        found: suggestions.length,
        newSuggestions: newCount,
        scanComplete: scanResult.scanComplete,
        messagesFound: scanResult.messagesFound,
        messagesProcessed: scanResult.messagesProcessed,
        messagesRemaining: scanResult.messagesRemaining,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      const status = err?.response?.status || err?.status;
      const gdata = err?.response?.data;
      console.error("Gmail scan error:", message, gdata || "");
      if (status === 401 || message?.includes("invalid_grant") || message?.includes("Token has been expired")) {
        return res.status(400).json({ message: "Gmail token expired. Please disconnect and reconnect Gmail." });
      }
      return res.status(500).json({ message: "Internal error during scan.", detail: message });
    }
  });

  // Phase 3B.7.3: end-user "detected subscriptions" dashboard. Reads only
  // from `subscriptions` (isShadow=true, resolutionStatus="resolved") — see
  // storage.getShadowSubscriptionsForUser(). This is a read-only view: it
  // never creates/updates trials or reminders, never flips isShadow, never
  // sends email. Tenant-scoped via req.session.userId, same as every other
  // /api/trials-style route.
  // Phase 3B.9.1: response now runs through calculateSubscriptionCosts() —
  // pure, deterministic, no DB calls of its own — which adds
  // monthlyCost/annualCost/costConfidence per subscription and a cost
  // summary. userId scoping is unchanged (still req.session.userId).
  // Phase 3B.9.2B: also runs through calculateUpcomingCharges() (default
  // 30-day window) — same `subs` array, no extra DB query needed.
  // Phase 3B.9.3 Step 6: each subscription's billingIntervalSource/
  // billingIntervalConfidence are already present on `subs` (read straight
  // from the DB row) and pass through calculateSubscriptionCosts() via its
  // ShadowSubscription spread — no separate wiring needed here.
  // Phase 3B.9.4: renewalCalendar runs calculateRenewalCalendar() twice
  // (30/90-day windows), using the user's own configured timezone — same
  // `subs` array, still no extra DB query.
  app.get("/api/subscriptions", requireAuth, async (req: Request, res: Response) => {
    try {
      const [subs, user] = await Promise.all([
        storage.getShadowSubscriptionsForUser(req.session.userId!),
        storage.getUserById(req.session.userId!),
      ]);
      const { subscriptions: subscriptionsWithCosts, summary } = calculateSubscriptionCosts(req.session.userId!, subs);
      const { charges: upcomingCharges, summary: upcomingSummary } = calculateUpcomingCharges(subs, 30);
      const timezone = user?.timezone || "UTC";
      const next30days = calculateRenewalCalendar(subs, 30, timezone);
      const next90days = calculateRenewalCalendar(subs, 90, timezone);
      return res.json({
        subscriptions: subscriptionsWithCosts,
        summary,
        upcomingCharges,
        upcomingSummary,
        renewalCalendar: { next30days, next90days },
        messagesScanned: user?.lastScanMessagesProcessed ?? null,
      });
    } catch (err) {
      console.error("Get subscriptions error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.9.5: Subscription Vault detail view. STRICT SECURITY: the
  // storage lookup is scoped by (id AND userId) together, so a subscription
  // belonging to a different user comes back as undefined — indistinguishable
  // from a non-existent id, which is exactly why this always returns 404
  // (never 403) on any access failure. requireAuth above already returns 401
  // for a missing session before this handler ever runs.
  app.get("/api/subscriptions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const subscription = await storage.getShadowSubscriptionById(id, req.session.userId!);
      const access = determineSubscriptionAccessResult(req.session.userId, subscription);

      if (access.status === 401) return res.status(401).json({ message: "Not authenticated" });
      if (access.status === 404) return res.status(404).json({ message: "Subscription not found" });

      const events = await storage.getCanonicalEventsForSubscription(access.subscription);
      const paymentProcessor = events.find((e) => e.paymentProcessor)?.paymentProcessor ?? null;

      return res.json(buildSubscriptionVaultResponse(access.subscription, events, paymentProcessor));
    } catch (err) {
      console.error("Get subscription detail error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // ===== SUGGESTED TRIALS ROUTES =====

  app.get("/api/suggested-trials", requireAuth, requireEmailScanning, async (req: Request, res: Response) => {
    const suggestions = await storage.getSuggestedTrials(req.session.userId!);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Filter out suggestions where end date is already in the past
    const fresh = suggestions.filter((s) => {
      if (!s.endDateGuess) return true;
      return new Date(s.endDateGuess) >= today;
    });

    // Deduplicate by serviceGuess — keep highest confidence per service
    const bestByService = new Map<string, typeof fresh[0]>();
    for (const s of fresh) {
      const key = (s.serviceGuess || s.fromDomain || "unknown").toLowerCase();
      const existing = bestByService.get(key);
      if (!existing || (s.confidence ?? 0) > (existing.confidence ?? 0)) {
        bestByService.set(key, s);
      }
    }

    return res.json(Array.from(bestByService.values()));
  });

  app.post("/api/suggested-trials/:id/add", requireAuth, requireEmailScanning, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const suggestion = await storage.getSuggestedTrialById(req.params.id, userId);
      if (!suggestion) return res.status(404).json({ message: "Suggestion not found" });

      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ message: "Not found" });

      const startDate = suggestion.startDateGuess || null;
      const endDate = suggestion.endDateGuess || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

      const domain = suggestion.fromDomain || "";
      const serviceUrl = domain ? `https://${domain}` : "";
      const iconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null;

      const trial = await storage.createTrial({
        userId,
        serviceName: suggestion.serviceGuess || suggestion.fromDomain || "Unknown Service",
        serviceUrl,
        domain,
        iconUrl,
        cancelUrl: null,
        startDate,
        endDate,
        renewalPrice: suggestion.amountGuess ? String(suggestion.amountGuess) : null,
        currency: suggestion.currencyGuess || "USD",
        status: "ACTIVE",
      });

      const now = new Date();
      const tz = user.timezone || "Asia/Qatar";
      const reminderPlans = computeReminders(endDate, now, tz);
      for (const plan of reminderPlans) {
        await storage.createReminder({
          trialId: trial.id, userId, remindAt: plan.remindAt, type: plan.type as any,
        });
      }

      await storage.markSuggestedTrialAdded(suggestion.id, userId);
      storage.logEvent(userId, "trial_created", { trialId: trial.id, serviceName: trial.serviceName, source: "suggestion" });

      return res.json({ success: true, trial });
    } catch (err) {
      console.error("Add suggested trial error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/suggested-trials/:id/ignore", requireAuth, requireEmailScanning, async (req: Request, res: Response) => {
    try {
      const result = await storage.markSuggestedTrialIgnored(req.params.id, req.session.userId!);
      if (!result) return res.status(404).json({ message: "Suggestion not found" });
      return res.json({ success: true });
    } catch (err) {
      console.error("Ignore suggestion error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.get("/api/trials", requireAuth, async (req: Request, res: Response) => {
    const trialsList = await storage.getTrialsByUser(req.session.userId!);
    return res.json(trialsList);
  });

  app.get("/api/trials/:id", requireAuth, async (req: Request, res: Response) => {
    const trial = await storage.getTrialById(req.params.id, req.session.userId!);
    if (!trial) return res.status(404).json({ message: "Trial not found" });
    return res.json(trial);
  });

  app.get("/api/trials/:id/reminders", requireAuth, async (req: Request, res: Response) => {
    const remindersList = await storage.getRemindersByTrial(req.params.id, req.session.userId!);
    return res.json(remindersList);
  });

  app.get("/api/trials/:id/calendar.ics", requireAuth, async (req: Request, res: Response) => {
    try {
      const trial = await storage.getTrialById(req.params.id, req.session.userId!);
      if (!trial) return res.status(404).json({ message: "Trial not found" });

      const endDate = trial.endDate.replace(/-/g, "");
      const nextDay = new Date(trial.endDate + "T00:00:00Z");
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const dtEnd = nextDay.toISOString().slice(0, 10).replace(/-/g, "");

      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const cancelUrl = trial.cancelUrl || trial.serviceUrl;
      const description = `Your free trial for ${trial.serviceName} ends today. Cancel now to avoid being charged.\\n\\nCancel here: ${cancelUrl}`;
      const uid = `recalltrial-${trial.id}@recalltrial.app`;

      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RecallTrial//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${endDate}`, `DTEND;VALUE=DATE:${dtEnd}`,
        `SUMMARY:Cancel ${trial.serviceName} - Free Trial Ends`,
        `DESCRIPTION:${description}`, `URL:${cancelUrl}`, "STATUS:CONFIRMED",
        "BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY",
        `DESCRIPTION:${trial.serviceName} free trial ends in 3 days - cancel now!`, "END:VALARM",
        "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY",
        `DESCRIPTION:${trial.serviceName} free trial ends tomorrow - cancel now!`, "END:VALARM",
        "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n");

      const filename = `cancel-${trial.serviceName.toLowerCase().replace(/[^a-z0-9]/g, "-")}.ics`;
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(ics);
    } catch (err) {
      console.error("Calendar export error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/trials", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertTrialSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }

      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });

      const limit = getTrialLimit(user.plan);
      if (limit !== null) {
        const activeCount = await storage.countActiveTrials(user.id);
        if (activeCount >= limit) {
          return res.status(403).json({
            error: "TRIAL_LIMIT_REACHED",
            message: `Free plan allows up to ${limit} active trials. Upgrade to Plus for unlimited trials.`,
          });
        }
      }

      const data = parsed.data;
      const domain = extractDomain(data.serviceUrl);
      const iconUrl = await getIconUrl(domain);

      const endD = new Date(data.endDate);

      const now = new Date();
      const tz = user.timezone || "Asia/Qatar";
      const tzOffsetMs = getTimezoneOffsetMs(tz, now);
      const todayLocal = new Date(now.getTime() + tzOffsetMs);
      todayLocal.setUTCHours(0, 0, 0, 0);
      const minEndDate = new Date(todayLocal.getTime() + 4 * 86400000);

      if (endD < minEndDate) {
        return res.status(400).json({ message: "End date must be at least 4 days from today so we can send 3/2/1-day reminders." });
      }

      const trial = await storage.createTrial({
        userId: req.session.userId!,
        serviceName: data.serviceName,
        serviceUrl: data.serviceUrl,
        domain,
        iconUrl,
        cancelUrl: data.cancelUrl || null,
        startDate: data.startDate || null,
        endDate: data.endDate,
        renewalPrice: data.renewalPrice || null,
        currency: data.currency || "USD",
        status: "ACTIVE",
      });

      const reminderPlans = computeReminders(data.endDate, now, tz);
      for (const plan of reminderPlans) {
        await storage.createReminder({
          trialId: trial.id, userId: req.session.userId!, remindAt: plan.remindAt, type: plan.type as any,
        });
      }

      storage.logEvent(req.session.userId!, "trial_created", { trialId: trial.id, serviceName: data.serviceName });
      return res.json(trial);
    } catch (err) {
      console.error("Create trial error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/trials/:id/cancel", requireAuth, async (req: Request, res: Response) => {
    try {
      const trial = await storage.cancelTrial(req.params.id, req.session.userId!);
      if (!trial) return res.status(404).json({ message: "Trial not found" });
      await storage.skipRemindersByTrial(trial.id);
      storage.logEvent(req.session.userId!, "trial_canceled", { trialId: trial.id, serviceName: trial.serviceName });
      return res.json(trial);
    } catch (err) {
      console.error("Cancel trial error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/billing/create-checkout-session", requireBilling, requireAuth, async (req: Request, res: Response) => {
    try {
      const { priceId } = req.body;
      if (!priceId || typeof priceId !== "string") {
        return res.status(400).json({ message: "Price ID is required" });
      }

      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });

      const { getUncachableStripeClient } = await import("./stripeClient");
      const stripe = await getUncachableStripeClient();

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        });
        await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customer.id });
        customerId = customer.id;
      }

      const appUrl = process.env.APP_URL || 'https://recalltrial.app';

      const checkoutSession = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/pricing`,
        metadata: { userId: user.id },
        subscription_data: {
          metadata: { userId: user.id },
          trial_period_days: 14,
        },
      });

      return res.json({ url: checkoutSession.url });
    } catch (err) {
      console.error("Checkout error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/billing/sync", requireBilling, requireAuth, async (req: Request, res: Response) => {
    try {
      let user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });

      // If stripeCustomerId is missing, search Stripe by email to recover it
      if (!user.stripeCustomerId) {
        try {
          const { getUncachableStripeClient } = await import("./stripeClient");
          const stripe = await getUncachableStripeClient();
          const customers = await stripe.customers.list({ email: user.email, limit: 1 });
          if (customers.data.length > 0) {
            const customerId = customers.data[0].id;
            await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customerId });
            console.log(`[billing/sync] Recovered stripeCustomerId ${customerId} for user ${user.id}`);
          }
        } catch (stripeErr) {
          console.error("[billing/sync] Stripe customer lookup failed:", stripeErr);
        }
      }

      const { syncUserSubscriptionByUserId } = await import("./stripeWebhookHandler");
      await syncUserSubscriptionByUserId(req.session.userId!);

      user = await storage.getUserById(req.session.userId!)!;
      if (!user) return res.status(401).json({ message: "User not found" });
      const activeCount = await storage.countActiveTrials(user.id);
      return res.json({
        id: user.id,
        email: user.email,
        timezone: user.timezone,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        currentPeriodEnd: user.currentPeriodEnd,
        activeTrialCount: activeCount,
        trialLimit: getTrialLimit(user.plan),
      });
    } catch (err) {
      console.error("Billing sync error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/billing/sync-by-email", requireBilling, async (req: Request, res: Response) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(500).json({ message: "ADMIN_KEY not configured" });
    const key = req.headers["x-admin-key"];
    if (key !== adminKey) return res.status(403).json({ message: "Forbidden" });

    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "email is required" });
      }

      const user = await storage.getUserByEmail(email.trim().toLowerCase());
      if (!user) return res.status(404).json({ message: "User not found" });

      const { getUncachableStripeClient } = await import("./stripeClient");
      const stripe = await getUncachableStripeClient();

      // Find Stripe customer by email
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (customers.data.length === 0) {
        return res.status(404).json({ message: "No Stripe customer found for this email" });
      }

      const customerId = customers.data[0].id;
      await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customerId });
      console.log(`[sync-by-email] Set stripeCustomerId=${customerId} for user ${user.id}`);

      const { syncUserSubscriptionFromStripe } = await import("./stripeWebhookHandler");
      await syncUserSubscriptionFromStripe(customerId);

      const updated = await storage.getUserById(user.id);
      return res.json({
        id: updated!.id,
        email: updated!.email,
        plan: updated!.plan,
        subscriptionStatus: updated!.subscriptionStatus,
        currentPeriodEnd: updated!.currentPeriodEnd,
        stripeCustomerId: updated!.stripeCustomerId,
      });
    } catch (err) {
      console.error("sync-by-email error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.get("/api/trials/:id/cancel-click", async (req: Request, res: Response) => {
    try {
      const trial = await storage.getTrialByIdPublic(req.params.id);
      if (!trial) {
        return res.redirect("/dashboard");
      }
      storage.logEvent(trial.userId, "cancel_link_clicked", { trialId: trial.id, serviceName: trial.serviceName });
      const cancelLink = trial.cancelUrl || trial.serviceUrl;
      return res.redirect(cancelLink);
    } catch {
      return res.redirect("/dashboard");
    }
  });

  app.get("/api/admin/metrics", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const metrics = await storage.getMetrics();
      return res.json(metrics);
    } catch (err) {
      console.error("Metrics error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 2 Step 7 (PHASE1_AUDIT.md, subscription-detection observation
  // only — nothing in the app reads subscription_events besides this).
  // Phase 3B.5 Step 4: extended with canonical-event-identity and shadow-
  // subscription metrics — still observation only, no production behavior
  // reads this endpoint's response.
  app.get("/api/admin/subscription-events/metrics", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const [metrics, shadowMetrics] = await Promise.all([
        storage.getSubscriptionEventMetrics(),
        storage.getShadowSubscriptionMetrics(),
      ]);
      return res.json({ ...metrics, ...shadowMetrics });
    } catch (err) {
      console.error("Subscription-event metrics error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.9.9 STEP 6: AI enrichment observability, same X-ADMIN-KEY gate.
  app.get("/api/admin/ai-enrichment/metrics", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const metrics = await storage.getAIEnrichmentMetrics();
      return res.json(metrics);
    } catch (err) {
      console.error("AI enrichment metrics error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.6: admin-only shadow-subscription preview dashboard. Read-only,
  // same X-ADMIN-KEY gate as every other /api/admin/* route. isShadow is
  // always true today — this never drives reminders or any user-facing UX.
  app.get("/api/admin/subscriptions", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const rows = await storage.getShadowSubscriptionsForDashboard();
      return res.json(rows);
    } catch (err) {
      console.error("Admin shadow-subscriptions error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.7.4: controlled production activation. Same X-ADMIN-KEY gate.
  // dryRun=true (default, safest) runs the exact same eligibility SQL as a
  // read-only SELECT and changes nothing. dryRun=false runs the real
  // idempotent UPDATE. Does not touch trials/reminders/computeReminders and
  // does not send any email — it only flips is_shadow on rows that already
  // exist.
  app.post("/api/admin/subscriptions/promote", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const userId: string | undefined = req.body?.userId || undefined;
      const dryRun: boolean = req.body?.dryRun !== false; // default true — safest default

      const preview = await storage.previewShadowSubscriptionPromotion(userId);

      if (dryRun) {
        return res.json({
          dryRun: true,
          wouldPromote: preview.eligible.length,
          wouldSkip: preview.ineligible.length,
          alreadyActive: preview.alreadyActive.length,
          promotedList: preview.eligible,
          skippedList: preview.ineligible,
        });
      }

      const result = await storage.promoteEligibleShadowSubscriptions(userId);
      // Re-fetch the preview AFTER promotion so the response's promotedList
      // reflects what's now actually active, not a stale pre-promotion view.
      const after = await storage.previewShadowSubscriptionPromotion(userId);

      return res.json({
        dryRun: false,
        promoted: result.promoted,
        skipped: result.skipped,
        alreadyActive: result.alreadyActive,
        promotedList: after.alreadyActive,
        skippedList: after.ineligible,
      });
    } catch (err) {
      console.error("Admin subscription-promotion error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.8 Step 5: controlled trigger for subscription-native reminder
  // generation. Same X-ADMIN-KEY gate. Deliberately NOT wired into the
  // hourly cron yet — Step 5 is the last, most cautious step of this phase,
  // and creating reminder rows (never sends them — that's a separate,
  // future pipeline) stays admin-triggered until this has been observed
  // against real production data, consistent with how every other write
  // path in this feature line (entity resolution, promotion) was rolled
  // out.
  app.post("/api/admin/subscriptions/generate-reminders", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const subscriptionId: string | undefined = req.body?.subscriptionId || undefined;
      const result = await storage.generateRemindersForEligibleSubscriptions(subscriptionId);
      return res.json(result);
    } catch (err) {
      console.error("Admin reminder-generation error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.9.7-PATCH: one-time historical body-extraction backfill,
  // admin-triggered (same X-ADMIN-KEY gate as every other /api/admin/*
  // route) rather than wired into any cron — this is a one-off enrichment
  // pass, not a recurring job. dryRun=true (the default when omitted) runs
  // every extraction/comparison and returns the full count breakdown
  // without writing anything, matching this phase's explicit "dry-run
  // first, report the numbers" requirement.
  app.post("/api/admin/backfill-body-extraction", async (req: Request, res: Response) => {
    const adminKey = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const userId: string | undefined = req.body?.userId || undefined;
      const dryRun: boolean = req.body?.dryRun !== false; // default true — an explicit dryRun:false is required to write
      const report = await backfillCanonicalEventBodies(userId, dryRun);
      return res.json({ dryRun, ...report });
    } catch (err) {
      console.error("Admin body-extraction backfill error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.get("/api/services/search", (req: Request, res: Response) => {
    const q = (req.query.q as string || "").trim();
    if (!q || q.length < 2) {
      return res.json([]);
    }
    const results = searchServices(q, 10);
    return res.json(results);
  });

  app.get("/api/billing/prices", requireBilling, async (_req: Request, res: Response) => {
    return res.json({
      plus: {
        monthly: {
          priceId: process.env.STRIPE_PLUS_MONTHLY_PRICE_ID,
          amount: 399,
          currency: "usd",
          interval: "month",
        },
        yearly: {
          priceId: process.env.STRIPE_PLUS_YEARLY_PRICE_ID,
          amount: 4070,
          currency: "usd",
          interval: "year",
        },
      },
      pro: {
        monthly: {
          priceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
          amount: 799,
          currency: "usd",
          interval: "month",
        },
        yearly: {
          priceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID,
          amount: 8150,
          currency: "usd",
          interval: "year",
        },
      },
    });
  });

  app.post("/api/billing/create-portal-session", requireBilling, requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });
      if (!user.stripeCustomerId) {
        return res.status(400).json({ message: "No billing account found" });
      }

      const { getUncachableStripeClient } = await import("./stripeClient");
      const stripe = await getUncachableStripeClient();
      const appUrl = process.env.APP_URL || 'https://recalltrial.app';

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${appUrl}/settings`,
      });

      return res.json({ url: portalSession.url });
    } catch (err) {
      console.error("Portal session error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  async function processRemindersNow() {
    const now = new Date();
    const dueReminders = await storage.getDueReminders(now);
    console.log(`[Cron] processRemindersNow triggered at ${now.toISOString()} — ${dueReminders.length} due reminder(s) found`);
    let emailsAttempted = 0;
    let emailsSent = 0;
    let failedCount = 0;
    const failures: { reminderId: string; trialId: string; reason: string }[] = [];

    for (const reminder of dueReminders) {
      const claimed = await storage.claimAndSendReminder(reminder.id);
      if (!claimed) continue;

      emailsAttempted++;
      const result = await sendReminderEmail(reminder.trial, reminder.user, reminder.type);
      if (result.success) {
        await storage.markReminderSent(reminder.id, result.messageId);
        emailsSent++;
      } else {
        await storage.markReminderFailed(reminder.id, result.error || "Unknown error");
        failedCount++;
        failures.push({ reminderId: reminder.id, trialId: reminder.trialId, reason: result.error || "Unknown error" });
      }
    }

    return {
      remindersProcessedCount: dueReminders.length,
      emailsAttemptedCount: emailsAttempted,
      emailsSentCount: emailsSent,
      failedCount,
      failures,
    };
  }

  // ===== REVIEWS ROUTES =====

  app.get("/api/reviews", async (_req: Request, res: Response) => {
    const approvedReviews = await storage.getApprovedReviews();
    return res.json(approvedReviews);
  });

  app.get("/api/reviews/featured", async (_req: Request, res: Response) => {
    try {
      const approvedReviews = await storage.getApprovedReviews(6);
      console.log(`[API] Returning ${approvedReviews.length} featured reviews`);
      return res.json(approvedReviews);
    } catch (err) {
      console.error("[API] Error fetching featured reviews:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/reviews/submit", requireAuth, async (req: Request, res: Response) => {
    const { rating, text, name, location } = req.body;
    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be 1-5" });
    }
    if (!text || typeof text !== "string" || text.trim().length < 10) {
      return res.status(400).json({ message: "Review must be at least 10 characters" });
    }
    if (text.length > 300) {
      return res.status(400).json({ message: "Review must be under 300 characters" });
    }
    const plainText = text.replace(/<[^>]*>/g, "").trim();
    const review = await storage.createReview({
      rating,
      text: plainText,
      name: name?.trim()?.substring(0, 60) || null,
      location: location?.trim()?.substring(0, 60) || null,
      source: "in_app",
      userId: req.session.userId!,
    });
    return res.json({ success: true, message: "Thanks! Your review will appear after approval.", review });
  });

  // Admin reviews (protected by ADMIN_KEY)
  app.get("/api/admin/reviews", async (req: Request, res: Response) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(500).json({ message: "ADMIN_KEY not configured" });
    const key = req.headers["x-admin-key"] || req.query.key;
    if (key !== adminKey) return res.status(403).json({ message: "Forbidden" });
    const allReviews = await storage.getAllReviews();
    return res.json(allReviews);
  });

  app.post("/api/admin/reviews/:id/approve", async (req: Request, res: Response) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(500).json({ message: "ADMIN_KEY not configured" });
    const key = req.headers["x-admin-key"] || req.query.key;
    if (key !== adminKey) return res.status(403).json({ message: "Forbidden" });
    const review = await storage.approveReview(req.params.id);
    if (!review) return res.status(404).json({ message: "Review not found" });
    return res.json(review);
  });

  app.post("/api/admin/reviews/:id/feature", async (req: Request, res: Response) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(500).json({ message: "ADMIN_KEY not configured" });
    const key = req.headers["x-admin-key"] || req.query.key;
    if (key !== adminKey) return res.status(403).json({ message: "Forbidden" });
    const review = await storage.toggleFeaturedReview(req.params.id);
    if (!review) return res.status(404).json({ message: "Review not found" });
    return res.json(review);
  });

  app.delete("/api/admin/reviews/:id", async (req: Request, res: Response) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(500).json({ message: "ADMIN_KEY not configured" });
    const key = req.headers["x-admin-key"] || req.query.key;
    if (key !== adminKey) return res.status(403).json({ message: "Forbidden" });
    const deleted = await storage.deleteReview(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Review not found" });
    return res.json({ success: true });
  });

  app.post("/api/debug/send-test-email", async (req: Request, res: Response) => {
    const debugKey = process.env.DEBUG_KEY;
    if (!debugKey) {
      return res.status(500).json({ success: false, error: "DEBUG_KEY not configured" });
    }
    if (req.headers["x-debug-key"] !== debugKey) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const { to, subject, message } = req.body || {};
    if (!to || typeof to !== "string") {
      return res.status(400).json({ success: false, error: "Missing 'to' email address" });
    }

    const result = await sendTestEmail(to, subject, message);
    return res.json({
      success: result.success,
      resendMessageId: result.messageId || null,
      usedFromEmail: result.usedFromEmail,
      usedReplyToEmail: result.usedReplyToEmail,
      error: result.error || null,
    });
  });

  app.post("/api/debug/run-reminders-now", async (req: Request, res: Response) => {
    const debugKey = process.env.DEBUG_KEY;
    if (!debugKey) {
      return res.status(500).json({ success: false, error: "DEBUG_KEY not configured" });
    }
    if (req.headers["x-debug-key"] !== debugKey) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    try {
      const result = await processRemindersNow();
      return res.json(result);
    } catch (err: any) {
      console.error("Debug run-reminders error:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  app.post("/api/cron/reminders", async (req: Request, res: Response) => {
    const cronKey = req.headers["x-cron-key"];
    if (!process.env.CRON_KEY || cronKey !== process.env.CRON_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Step 1: existing trial reminders — unchanged call, unchanged
    // processRemindersNow(), runs first. Isolated in its own try/catch so a
    // failure here can never prevent Step 2 below from running.
    let trialReminders: Awaited<ReturnType<typeof processRemindersNow>> | { error: string };
    try {
      trialReminders = await processRemindersNow();
      console.log(`[Cron] trial reminders: ${JSON.stringify(trialReminders)}`);
    } catch (err: any) {
      console.error("[Cron] trial reminders failed:", err);
      trialReminders = { error: err.message || "Internal error" };
    }

    // Step 2 (Phase 3B.9.1): subscription-native reminder generation — a
    // separate, isolated step, same reasoning in the other direction: a
    // failure here must never affect the trial-reminder result above (it's
    // already been computed and won't be touched by anything below).
    // Reuses storage.generateRemindersForEligibleSubscriptions() exactly as
    // already proven via POST /api/admin/subscriptions/generate-reminders —
    // no algorithm duplicated or rewritten here, same idempotent
    // (subscription_id, type) dedup guarantee. Does not touch the
    // `reminders`/`trials` tables at all.
    let subscriptionReminders: { created: number; skipped: number } | { error: string };
    try {
      subscriptionReminders = await storage.generateRemindersForEligibleSubscriptions();
      console.log(`[Cron] subscription reminders: ${JSON.stringify(subscriptionReminders)}`);
    } catch (err: any) {
      console.error("[Cron] subscription reminders failed:", err);
      subscriptionReminders = { error: err.message || "Internal error" };
    }

    return res.json({ trialReminders, subscriptionReminders });
  });

  app.post("/api/cron/email-scan", async (req: Request, res: Response) => {
    const cronKey = req.headers["x-cron-key"];
    if (!process.env.CRON_KEY || cronKey !== process.env.CRON_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const proUsers = await storage.getProUsersWithScanningEnabled();
      const batch = proUsers.slice(0, 10);
      const results: {
        userId: string;
        found: number;
        error?: string;
        scanComplete?: boolean;
        messagesFound?: number;
        messagesProcessed?: number;
        messagesRemaining?: number;
      }[] = [];

      for (const user of batch) {
        if (!user.gmailAccessToken) continue;
        try {
          const scanResult = await scanGmailForTrials(
            user.gmailAccessToken,
            user.gmailRefreshToken,
            user.gmailTokenExpiry,
            user.id,
            user.lastEmailScanAt,
            user.aiScanningEnabled
          );
          for (const s of scanResult.suggestions) {
            await storage.upsertSuggestedTrial({ ...s, userId: user.id });
          }
          await storage.updateLastEmailScan(user.id, scanResult.messagesProcessed);
          results.push({
            userId: user.id,
            found: scanResult.suggestions.length,
            scanComplete: scanResult.scanComplete,
            messagesFound: scanResult.messagesFound,
            messagesProcessed: scanResult.messagesProcessed,
            messagesRemaining: scanResult.messagesRemaining,
          });
        } catch (err: any) {
          results.push({ userId: user.id, found: 0, error: err.message });
        }
      }

      return res.json({ usersScanned: batch.length, results });
    } catch (err) {
      console.error("Cron email-scan error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  // Phase 3B.9.9 STEP 5: AI enrichment batch processor. Same X-CRON-KEY
  // gate as every other /api/cron/* route. Deliberately its own endpoint —
  // enrichment jobs are QUEUED by the email-scan cron but PROCESSED on
  // their own schedule (retry backoff makes tight coupling to the scan
  // cadence wrong), so this stays a separate cron trigger rather than
  // folding into /api/cron/email-scan.
  app.post("/api/cron/ai-enrichment", async (req: Request, res: Response) => {
    const cronKey = req.headers["x-cron-key"];
    if (!process.env.CRON_KEY || cronKey !== process.env.CRON_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }
    try {
      const result = await processAIEnrichmentBatch(10);
      console.log(`[Cron] AI enrichment: ${JSON.stringify(result)}`);
      return res.json(result);
    } catch (err) {
      console.error("Cron AI enrichment error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  return httpServer;
}
