import type { Express, Request, Response, NextFunction } from "express";
import { type Server } from "http";
import session from "express-session";
import { storage } from "./storage";
import { signupSchema, loginSchema, insertTrialSchema } from "@shared/schema";
import { extractDomain, getIconUrl } from "./icon";
import { sendReminderEmail, sendTestEmail } from "./email";
import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { searchServices } from "./serviceSearch";

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

type ReminderPlan = { remindAt: Date; type: string };

function getTimezoneOffsetMs(timezone: string, refDate: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(refDate);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0");
    const localH = get("hour");
    const localM = get("minute");
    const utcH = refDate.getUTCHours();
    const utcM = refDate.getUTCMinutes();
    return ((localH - utcH) * 60 + (localM - utcM)) * 60 * 1000;
  } catch {
    return 0;
  }
}

function computeReminders(endDateStr: string, now: Date, timezone: string): ReminderPlan[] {
  const tzOffsetMs = getTimezoneOffsetMs(timezone, now);
  const endDateTimeUtc = new Date(new Date(endDateStr + "T23:59:59.000Z").getTime() - tzOffsetMs);

  const timeLeftMs = endDateTimeUtc.getTime() - now.getTime();
  const timeLeftHours = timeLeftMs / (1000 * 60 * 60);
  const minFutureMs = 2 * 60 * 1000;

  let offsets: { hoursBeforeEnd: number; type: string }[];

  if (timeLeftHours <= 0) {
    return [];
  } else if (timeLeftHours < 24) {
    offsets = [
      { hoursBeforeEnd: 6, type: "SIX_HOURS" },
      { hoursBeforeEnd: 1, type: "ONE_HOUR" },
    ];
  } else if (timeLeftHours < 72) {
    offsets = [
      { hoursBeforeEnd: 24, type: "TWENTY_FOUR_HOURS" },
      { hoursBeforeEnd: 3, type: "THREE_HOURS" },
    ];
  } else {
    offsets = [
      { hoursBeforeEnd: 72, type: "THREE_DAYS" },
      { hoursBeforeEnd: 24, type: "ONE_DAY" },
    ];
  }

  const results: ReminderPlan[] = [];
  for (const offset of offsets) {
    const remindAt = new Date(endDateTimeUtc.getTime() - offset.hoursBeforeEnd * 60 * 60 * 1000);
    if (remindAt.getTime() > now.getTime() + minFutureMs) {
      results.push({ remindAt, type: offset.type });
    }
  }

  return results;
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
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      },
    })
  );

  app.post("/api/auth/signup", async (req: Request, res: Response) => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { email, password } = parsed.data;
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
      const { email, password } = parsed.data;
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
      createdAt: user.createdAt,
    });
  });

  app.patch("/api/auth/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { timezone } = req.body;
      if (!timezone || typeof timezone !== "string") {
        return res.status(400).json({ message: "Invalid timezone" });
      }
      const user = await storage.updateUserTimezone(req.session.userId!, timezone);
      return res.json({ id: user.id, email: user.email, timezone: user.timezone });
    } catch (err) {
      console.error("Settings error:", err);
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
      const startD = new Date(data.startDate);
      if (endD < startD) {
        return res.status(400).json({ message: "End date must be after start date" });
      }

      const trial = await storage.createTrial({
        userId: req.session.userId!,
        serviceName: data.serviceName,
        serviceUrl: data.serviceUrl,
        domain,
        iconUrl,
        cancelUrl: data.cancelUrl || null,
        startDate: data.startDate,
        endDate: data.endDate,
        renewalPrice: data.renewalPrice || null,
        currency: data.currency || "USD",
        status: "ACTIVE",
      });

      const now = new Date();
      const tz = user.timezone || "Asia/Qatar";

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

      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;

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
      const { syncUserSubscriptionByUserId } = await import("./stripeWebhookHandler");
      await syncUserSubscriptionByUserId(req.session.userId!);
      const user = await storage.getUserById(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });
      const activeCount = await storage.countActiveTrials(user.id);
      return res.json({
        id: user.id,
        email: user.email,
        timezone: user.timezone,
        plan: user.plan,
        activeTrialCount: activeCount,
        trialLimit: getTrialLimit(user.plan),
      });
    } catch (err) {
      console.error("Billing sync error:", err);
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
      const appUrl = process.env.APP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;

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
    const approvedReviews = await storage.getApprovedReviews(6);
    return res.json(approvedReviews);
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
    if (cronKey !== process.env.CRON_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const result = await processRemindersNow();
      return res.json(result);
    } catch (err) {
      console.error("Cron error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  return httpServer;
}
