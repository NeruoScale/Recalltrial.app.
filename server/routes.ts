import type { Express, Request, Response, NextFunction } from "express";
import { type Server } from "http";
import session from "express-session";
import { storage } from "./storage";
import { signupSchema, loginSchema, insertTrialSchema } from "@shared/schema";
import { extractDomain, getIconUrl } from "./icon";
import { sendReminderEmail } from "./email";
import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";

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

function computeReminderTimeInUTC(endDateStr: string, daysBefore: number, timezone: string): Date {
  const [year, month, day] = endDateStr.split("-").map(Number);
  const reminderDay = day - daysBefore;

  const localDateStr = `${year}-${String(month).padStart(2, "0")}-${String(reminderDay).padStart(2, "0")}T10:00:00`;

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

    const targetDate = new Date(endDateStr + "T12:00:00Z");
    targetDate.setUTCDate(targetDate.getUTCDate() - daysBefore);

    const utcEstimate = new Date(targetDate);
    const parts = formatter.formatToParts(utcEstimate);
    const localHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0");

    const offsetHours = localHour - utcEstimate.getUTCHours();

    const result = new Date(targetDate);
    result.setUTCHours(10 - offsetHours, 0, 0, 0);

    return result;
  } catch {
    const fallback = new Date(endDateStr + "T10:00:00Z");
    fallback.setUTCDate(fallback.getUTCDate() - daysBefore);
    return fallback;
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const PgStore = connectPgSimple(session);

  app.use(
    session({
      store: new PgStore({
        pool: pool,
        createTableIfMissing: true,
      }),
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
    return res.json({ id: user.id, email: user.email, timezone: user.timezone, createdAt: user.createdAt });
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

      const threeDaysBefore = new Date(trial.endDate + "T00:00:00Z");
      threeDaysBefore.setUTCDate(threeDaysBefore.getUTCDate() - 3);
      const alarmTrigger3 = "-P3D";

      const oneDayBefore = new Date(trial.endDate + "T00:00:00Z");
      oneDayBefore.setUTCDate(oneDayBefore.getUTCDate() - 1);
      const alarmTrigger1 = "-P1D";

      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//RecallTrial//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${endDate}`,
        `DTEND;VALUE=DATE:${dtEnd}`,
        `SUMMARY:Cancel ${trial.serviceName} - Free Trial Ends`,
        `DESCRIPTION:${description}`,
        `URL:${cancelUrl}`,
        "STATUS:CONFIRMED",
        "BEGIN:VALARM",
        "TRIGGER:" + alarmTrigger3,
        "ACTION:DISPLAY",
        `DESCRIPTION:${trial.serviceName} free trial ends in 3 days - cancel now!`,
        "END:VALARM",
        "BEGIN:VALARM",
        "TRIGGER:" + alarmTrigger1,
        "ACTION:DISPLAY",
        `DESCRIPTION:${trial.serviceName} free trial ends tomorrow - cancel now!`,
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
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

      const user = await storage.getUserById(req.session.userId!);
      const now = new Date();
      const tz = user?.timezone || "Asia/Qatar";

      const threeDayRemind = computeReminderTimeInUTC(data.endDate, 3, tz);
      if (threeDayRemind > now) {
        await storage.createReminder({
          trialId: trial.id,
          userId: req.session.userId!,
          remindAt: threeDayRemind,
          type: "THREE_DAYS",
        });
      }

      const oneDayRemind = computeReminderTimeInUTC(data.endDate, 1, tz);
      if (oneDayRemind > now) {
        await storage.createReminder({
          trialId: trial.id,
          userId: req.session.userId!,
          remindAt: oneDayRemind,
          type: "ONE_DAY",
        });
      }

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
      return res.json(trial);
    } catch (err) {
      console.error("Cancel trial error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  app.post("/api/cron/reminders", async (req: Request, res: Response) => {
    const cronKey = req.headers["x-cron-key"];
    if (cronKey !== process.env.CRON_KEY) {
      return res.status(403).json({ message: "Forbidden" });
    }

    try {
      const now = new Date();
      const dueReminders = await storage.getDueReminders(now);

      let sent = 0;
      let failed = 0;

      for (const reminder of dueReminders) {
        const marked = await storage.claimAndSendReminder(reminder.id);
        if (!marked) {
          continue;
        }

        const success = await sendReminderEmail(reminder.trial, reminder.user, reminder.type);
        if (success) {
          sent++;
        } else {
          failed++;
        }
      }

      return res.json({ processed: dueReminders.length, sent, failed });
    } catch (err) {
      console.error("Cron error:", err);
      return res.status(500).json({ message: "Internal error" });
    }
  });

  return httpServer;
}
