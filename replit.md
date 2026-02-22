# RecallTrial

## Overview
RecallTrial is a trust-first free-trial reminder app. Users add free trials manually, and the app sends email reminders before renewal with cancel links. Currently in **Free Early Access** mode — all billing features are hidden behind `BILLING_ENABLED=false` flag (Stripe code preserved for future paid launch).

**Tagline:** "Never get charged for a free trial again."

## Tech Stack
- **Frontend:** React + TypeScript + TailwindCSS + shadcn/ui + wouter routing
- **Backend:** Express.js (API routes)
- **Database:** PostgreSQL with Drizzle ORM
- **Auth:** Email/password with bcrypt + express-session (pg-backed sessions)
- **Email:** Resend (graceful fallback to console logging if API key not set)
- **Payments:** Stripe (frozen behind BILLING_ENABLED flag, code intact via stripe-replit-sync)
- **Search:** Fuse.js fuzzy search over 585-service catalog
- **Scheduling:** Cron endpoint at POST /api/cron/reminders (secured via X-CRON-KEY header)
- **Reminder Logic:** Adaptive offsets based on time remaining: >=72h uses THREE_DAYS+ONE_DAY, <72h uses TWENTY_FOUR_HOURS+THREE_HOURS, <24h uses SIX_HOURS+ONE_HOUR. Past reminders filtered out (>now+2min)

## Project Structure
```
client/src/
  App.tsx           - Main router with auth provider
  lib/auth.tsx      - Auth context (login/signup/logout, billingEnabled flag)
  lib/queryClient.ts - TanStack Query setup
  pages/
    landing.tsx     - Public landing page (Free Early Access messaging)
    auth-login.tsx  - Login page
    auth-signup.tsx - Signup page
    dashboard.tsx   - Main dashboard (urgent/upcoming/canceled trials, 3-trial limit)
    trial-new.tsx   - Add new trial form with fuzzy service search + calendar pickers
    trial-detail.tsx - Trial detail with reminders, calendar export
    settings.tsx    - User settings (timezone)
  components/
    trial-card.tsx  - Reusable trial card component
server/
  index.ts         - Express server setup, Stripe init gated by BILLING_ENABLED
  routes.ts        - All API routes (auth, trials CRUD, search, analytics, billing gated, cron)
  storage.ts       - Database storage layer (IStorage interface)
  serviceSearch.ts - Fuse.js fuzzy search over services catalog
  services_catalog.json - 585 services with name, domain, aliases, cancelUrl
  stripeClient.ts  - Stripe SDK initialization via Replit connector
  webhookHandlers.ts - Stripe webhook processing via stripe-replit-sync
  stripeWebhookHandler.ts - User plan sync from Stripe subscriptions
  seed-products.ts - Script to create Stripe products/prices
  db.ts            - PostgreSQL + Drizzle connection
  email.ts         - Resend email sending + HTML templates
  icon.ts          - Domain extraction + favicon URL generation
shared/
  schema.ts        - Drizzle schema (users, trials, reminders, analyticsEvents) + Zod schemas
```

## Key API Routes
- POST /api/auth/signup - Create account (logs signup event)
- POST /api/auth/login - Log in (logs login event)
- POST /api/auth/logout - Log out
- GET /api/auth/me - Current user (includes activeTrialCount, trialLimit=3, billingEnabled)
- PATCH /api/auth/settings - Update timezone
- GET /api/trials - List user's trials
- POST /api/trials - Create trial (auto-creates reminders, enforces 3-trial limit, logs event)
- GET /api/trials/:id - Trial detail
- GET /api/trials/:id/reminders - Trial's reminders
- GET /api/trials/:id/calendar.ics - Calendar export
- POST /api/trials/:id/cancel - Mark trial as canceled (logs event)
- GET /api/trials/:id/cancel-click - Track cancel link click + redirect to cancel URL
- GET /api/services/search?q= - Fuzzy search 585 services (fuse.js, threshold 0.35, top 10)
- GET /api/admin/metrics - Admin metrics (requires X-ADMIN-KEY header or ?key= query param)
- POST /api/billing/* - Billing routes (gated, return 404 when BILLING_ENABLED=false)
- POST /api/stripe/webhook - Stripe webhook (gated, return 404 when BILLING_ENABLED=false)
- POST /api/debug/send-test-email - Send test email (requires X-DEBUG-KEY header)
- POST /api/debug/run-reminders-now - Manually trigger due reminders (requires X-DEBUG-KEY header)
- POST /api/cron/reminders - Process due reminders (requires X-CRON-KEY header)
- GET /api/reviews - All approved reviews (public)
- GET /api/reviews/featured - Up to 6 approved reviews for landing page (public)
- POST /api/reviews/submit - Submit a review (requires auth, source=in_app, pending approval)
- GET /api/admin/reviews - All reviews for admin (requires ADMIN_KEY)
- POST /api/admin/reviews/:id/approve - Approve a review (requires ADMIN_KEY)
- POST /api/admin/reviews/:id/feature - Toggle featured status (requires ADMIN_KEY)
- DELETE /api/admin/reviews/:id - Delete a review (requires ADMIN_KEY)

## Early Access Mode
- **BILLING_ENABLED=false**: All billing routes return 404, Stripe initialization skipped
- **Trial limit: 3** active trials per user (was 5 for Free plan)
- **No pricing page** in frontend routes when billing disabled
- All Stripe code preserved in codebase for future paid launch
- Landing page shows "100% Free during Early Access" messaging

## Analytics
- **analytics_events** table tracks: signup, login, trial_created, trial_canceled, cancel_link_clicked
- Each event has userId, event name, JSON metadata, timestamp
- Admin metrics endpoint at GET /api/admin/metrics (protected by ADMIN_KEY env var)

## Database Models
- **users**: id, email, passwordHash, timezone, plan (FREE/PRO/PREMIUM), stripeCustomerId, stripeSubscriptionId, subscriptionStatus, currentPeriodEnd, createdAt
- **trials**: id, userId, serviceName, serviceUrl, domain, iconUrl, cancelUrl, startDate, endDate, renewalPrice, currency, status, canceledAt, createdAt
- **reminders**: id, trialId, userId, remindAt, type, status (PENDING/SENT/SKIPPED/FAILED), sentAt, provider, providerMessageId, lastError, createdAt
- **analytics_events**: id, userId, event, metadata (JSON string), createdAt
- **reviews**: id, rating (1-5), text, name, location, source (manual/in_app/import), isApproved, isFeatured, userId, createdAt

## Environment Variables
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- BILLING_ENABLED - "true" to enable Stripe billing, "false" for Early Access mode
- ADMIN_KEY - Secret key for admin metrics endpoint
- CRON_KEY - Secret for cron endpoint authentication
- APP_URL - Application URL for email links
- RESEND_API_KEY - Resend email API key (optional, logs to console if not set)
- FROM_EMAIL - Email sender address (default: "RecallTrial <onboarding@resend.dev>", currently set to notifications@recalltrial.app)
- REPLY_TO_EMAIL - Reply-to address for emails (optional)
- DEBUG_KEY - Secret key for debug endpoints (send-test-email, run-reminders-now)
- STRIPE_PRO_MONTHLY_PRICE_ID - Stripe price ID for Pro monthly
- STRIPE_PRO_YEARLY_PRICE_ID - Stripe price ID for Pro yearly
- STRIPE_PREMIUM_MONTHLY_PRICE_ID - Stripe price ID for Premium monthly
- STRIPE_PREMIUM_YEARLY_PRICE_ID - Stripe price ID for Premium yearly

## Branding
- App name: RecallTrial
- Footer: "© 2026 RecallTrial - All Rights Reserved"
- Default timezone: Asia/Qatar
