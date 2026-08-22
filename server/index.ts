import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

const BILLING_ENABLED = process.env.BILLING_ENABLED === "true";

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!BILLING_ENABLED) {
      return res.status(404).json({ message: "Not found" });
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error('STRIPE WEBHOOK ERROR: req.body is not a Buffer. Type:', typeof req.body);
        return res.status(500).json({ error: 'Webhook processing error' });
      }

      const { WebhookHandlers } = await import("./webhookHandlers");
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);

      try {
        const { syncUserSubscriptionFromStripe, syncUserSubscriptionByUserId } = await import("./stripeWebhookHandler");
        const event = JSON.parse(req.body.toString());
        const eventData = event.data?.object;

        if (event.type === 'checkout.session.completed' && eventData?.metadata?.type === 'ai_credits') {
          // Phase 3B.9.10 STEP 6: AI-credit top-up fulfillment. Handled as
          // its own branch, BEFORE the subscription-purchase logic below
          // (which never applies here anyway — purchaseTracking.ts bails
          // out for non-subscription-mode sessions, and syncUserSubscription*
          // has nothing to sync for a one-time payment). Credits are
          // granted ONLY here, from the verified webhook event — never
          // from the browser's success_url redirect. Real money changed
          // hands, so failures are logged loudly rather than swallowed by
          // the bare catch{} this whole block otherwise sits inside.
          const userId = eventData?.metadata?.userId;
          const creditAmount = parseInt(eventData?.metadata?.creditAmount, 10);
          if (userId && Number.isFinite(creditAmount) && creditAmount > 0) {
            setTimeout(async () => {
              try {
                const { grantPurchasedCredits } = await import("./aiCredits");
                await grantPurchasedCredits(userId, creditAmount, eventData.id);
                console.log(`[AI Credits] granted ${creditAmount} purchased credits to user ${userId} (session ${eventData.id})`);
              } catch (err) {
                console.error(`[AI Credits] failed to grant purchased credits for session ${eventData?.id}:`, err);
              }
            }, 2000);
          } else {
            console.error(`[AI Credits] checkout.session.completed(type=ai_credits) missing/invalid userId or creditAmount for session ${eventData?.id}`);
          }
        } else if (event.type === 'checkout.session.completed') {
          const userId = eventData?.metadata?.userId;
          if (userId) {
            setTimeout(() => syncUserSubscriptionByUserId(userId), 2000);
          }
          const { trackCheckoutSessionPurchase } = await import("./purchaseTracking");
          setTimeout(() => trackCheckoutSessionPurchase(eventData), 2000);
        } else if (event.type?.startsWith('customer.subscription.')) {
          const customerId = eventData?.customer;
          if (customerId) {
            setTimeout(() => syncUserSubscriptionFromStripe(customerId), 2000);
          }
        }
      } catch {
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('Webhook error:', error.message);
      res.status(400).json({ error: 'Webhook processing error' });
    }
  }
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));

async function initBilling() {
  if (!BILLING_ENABLED) {
    console.log('Billing disabled (BILLING_ENABLED=false). Stripe initialization skipped.');
    return;
  }

  const { runMigrations } = await import('stripe-replit-sync');
  const { getStripeSync } = await import("./stripeClient");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL required for Stripe integration');
  }

  try {
    console.log('Initializing Stripe schema...');
    await runMigrations({ databaseUrl } as any);
    console.log('Stripe schema ready');

    const stripeSync = await getStripeSync();

    console.log('Setting up managed webhook...');
    const webhookBaseUrl = process.env.APP_URL || 'https://recalltrial.app';
    try {
      const result = await stripeSync.findOrCreateManagedWebhook(
        `${webhookBaseUrl}/api/stripe/webhook`
      );
      console.log('Webhook configured:', JSON.stringify(result, null, 2).slice(0, 200));
    } catch (webhookErr) {
      console.log('Webhook setup skipped (may need production domain):', (webhookErr as Error).message);
    }

    console.log('Syncing Stripe data...');
    stripeSync.syncBackfill()
      .then(() => console.log('Stripe data synced'))
      .catch((err: any) => console.error('Error syncing Stripe data:', err));
  } catch (error) {
    console.error('Failed to initialize Stripe:', error);
  }
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  const { runMigrations } = await import("./migrate");
  await runMigrations();

  await initBilling();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
