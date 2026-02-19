# RecallTrial

## Overview
RecallTrial is a trust-first free-trial reminder app. Users add free trials manually, and the app sends email reminders before renewal with cancel links.

**Tagline:** "Never get charged for a free trial again."

## Tech Stack
- **Frontend:** React + TypeScript + TailwindCSS + shadcn/ui + wouter routing
- **Backend:** Express.js (API routes)
- **Database:** PostgreSQL with Drizzle ORM
- **Auth:** Email/password with bcrypt + express-session (pg-backed sessions)
- **Email:** Resend (graceful fallback to console logging if API key not set)
- **Payments:** Stripe (via stripe-replit-sync for webhook + data syncing)
- **Scheduling:** Cron endpoint at POST /api/cron/reminders (secured via X-CRON-KEY header)

## Project Structure
```
client/src/
  App.tsx           - Main router with auth provider
  lib/auth.tsx      - Auth context (login/signup/logout, plan info)
  lib/queryClient.ts - TanStack Query setup
  pages/
    landing.tsx     - Public landing page
    auth-login.tsx  - Login page
    auth-signup.tsx - Signup page
    dashboard.tsx   - Main dashboard (urgent/upcoming/canceled trials, plan limits)
    trial-new.tsx   - Add new trial form with calendar pickers
    trial-detail.tsx - Trial detail with reminders view
    settings.tsx    - User settings (timezone)
    pricing.tsx     - Pricing page (Free/Pro/Premium)
    billing-success.tsx - Post-checkout success page
  components/
    trial-card.tsx  - Reusable trial card component
    upgrade-modal.tsx - Upgrade prompt modal
server/
  index.ts         - Express server setup + Stripe init + webhook route
  routes.ts        - All API routes (auth, trials CRUD, billing, cron)
  storage.ts       - Database storage layer (IStorage interface)
  stripeClient.ts  - Stripe SDK initialization via Replit connector
  webhookHandlers.ts - Stripe webhook processing via stripe-replit-sync
  stripeWebhookHandler.ts - User plan sync from Stripe subscriptions
  seed-products.ts - Script to create Stripe products/prices
  db.ts            - PostgreSQL + Drizzle connection
  email.ts         - Resend email sending + HTML templates
  icon.ts          - Domain extraction + favicon URL generation
shared/
  schema.ts        - Drizzle schema (users, trials, reminders) + Zod schemas + popular services
```

## Key API Routes
- POST /api/auth/signup - Create account
- POST /api/auth/login - Log in
- POST /api/auth/logout - Log out
- GET /api/auth/me - Current user (includes plan, activeTrialCount, trialLimit)
- PATCH /api/auth/settings - Update timezone
- GET /api/trials - List user's trials
- POST /api/trials - Create trial (auto-creates reminders, enforces plan limits)
- GET /api/trials/:id - Trial detail
- GET /api/trials/:id/reminders - Trial's reminders
- GET /api/trials/:id/calendar.ics - Calendar export
- POST /api/trials/:id/cancel - Mark trial as canceled
- POST /api/billing/create-checkout-session - Create Stripe checkout session
- GET /api/billing/prices - Get pricing info for Pro/Premium
- POST /api/billing/sync - Sync user plan from Stripe
- POST /api/stripe/webhook - Stripe webhook endpoint (registered before express.json())
- POST /api/cron/reminders - Process due reminders (requires X-CRON-KEY header)

## Billing / Plans
- **Free:** Up to 5 active trials, email reminders (3 days + 1 day before), calendar export
- **Pro ($4.99/mo or $49.90/yr):** Unlimited active trials, full reminder history
- **Premium ($9.99/mo or $99.90/yr):** Everything in Pro + priority reminders (6h before) + priority support
- Plan enforcement: Free users blocked from adding trials beyond limit (403 with PLAN_LIMIT_REACHED code)
- Stripe products/prices are created via seed-products.ts and IDs stored as env vars
- Webhook events sync subscription status to user plan via stripeWebhookHandler.ts

## Database Models
- **users**: id, email, passwordHash, timezone, plan (FREE/PRO/PREMIUM), stripeCustomerId, stripeSubscriptionId, subscriptionStatus, currentPeriodEnd, createdAt
- **trials**: id, userId, serviceName, serviceUrl, domain, iconUrl, cancelUrl, startDate, endDate, renewalPrice, currency, status, canceledAt, createdAt
- **reminders**: id, trialId, userId, remindAt, type, status, sentAt, createdAt
- **stripe schema**: Managed by stripe-replit-sync (products, prices, subscriptions, etc.)

## Environment Variables
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- CRON_KEY - Secret for cron endpoint authentication
- APP_URL - Application URL for email links
- RESEND_API_KEY - Resend email API key (optional, logs to console if not set)
- STRIPE_PRO_MONTHLY_PRICE_ID - Stripe price ID for Pro monthly
- STRIPE_PRO_YEARLY_PRICE_ID - Stripe price ID for Pro yearly
- STRIPE_PREMIUM_MONTHLY_PRICE_ID - Stripe price ID for Premium monthly
- STRIPE_PREMIUM_YEARLY_PRICE_ID - Stripe price ID for Premium yearly

## Branding
- App name: RecallTrial
- Footer: "Operated by SKAHM LTD (UK)."
- Default timezone: Asia/Qatar
