# RecallTrial

## Overview
RecallTrial is a trust-first free-trial reminder app. Users add free trials manually, and the app sends email reminders before renewal with cancel links. Supports 3 pricing plans (Free/Plus/Pro) with Stripe billing in test mode.

**Tagline:** "Never get charged for a free trial again."

## Tech Stack
- **Frontend:** React + TypeScript + TailwindCSS + shadcn/ui + wouter routing
- **Backend:** Express.js (API routes)
- **Database:** PostgreSQL with Drizzle ORM
- **Auth:** Email/password with bcrypt + express-session (pg-backed sessions)
- **Email:** Resend (graceful fallback to console logging if API key not set)
- **Payments:** Stripe (test mode, BILLING_ENABLED=true, Replit connector for SDK init)
- **Search:** Fuse.js fuzzy search over 585-service catalog
- **Scheduling:** Cron endpoints at POST /api/cron/reminders and POST /api/cron/email-scan (secured via X-CRON-KEY header)
- **Reminder Logic:** Fixed 3-offset reminders: THREE_DAYS (72h), TWO_DAYS (48h), ONE_DAY (24h) before end date. End date must be ≥4 days from today.
- **Gmail Scanning:** Pro-only opt-in feature. Uses googleapis + Google OAuth 2.0 per-user tokens. Scans metadata only (no body), keyword-based extraction.

## Project Structure
```
client/src/
  App.tsx           - Main router with auth provider
  lib/auth.tsx      - Auth context (login/signup/logout, billingEnabled, emailScanningEnabled, gmailConnected flags)
  lib/queryClient.ts - TanStack Query setup
  pages/
    landing.tsx     - Public landing page with pricing CTA
    auth-login.tsx  - Login page
    auth-signup.tsx - Signup page
    dashboard.tsx   - Main dashboard (urgent/upcoming/canceled trials, plan-aware limits, suggested trials for Pro)
    trial-new.tsx   - Add new trial form with fuzzy service search + calendar pickers
    trial-detail.tsx - Trial detail with reminders, calendar export
    settings.tsx    - User settings (timezone, plan, email scanning card, billing portal)
    pricing.tsx     - Pricing page (Free/Plus/Pro plans with Stripe checkout)
    billing-success.tsx - Post-checkout success page with plan sync
  components/
    trial-card.tsx  - Reusable trial card component
server/
  index.ts         - Express server setup, Stripe init gated by BILLING_ENABLED
  routes.ts        - All API routes (auth, trials CRUD, search, analytics, billing gated, gmail, suggested-trials, cron)
  storage.ts       - Database storage layer (IStorage interface + DatabaseStorage)
  gmail.ts         - Google OAuth + Gmail metadata scanning module
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
  schema.ts        - Drizzle schema (users, trials, reminders, analyticsEvents, suggestedTrials, reviews) + Zod schemas
```

## Key API Routes
- POST /api/auth/signup - Create account (logs signup event)
- POST /api/auth/login - Log in (logs login event)
- POST /api/auth/logout - Log out
- GET /api/auth/me - Current user (includes activeTrialCount, trialLimit, billingEnabled, emailScanningEnabled, gmailConnected, lastEmailScanAt)
- PATCH /api/auth/settings - Update timezone OR toggle emailScanningEnabled (Pro only)
- GET /api/trials - List user's trials
- POST /api/trials - Create trial (auto-creates reminders, enforces 3-trial limit, logs event)
- GET /api/trials/:id - Trial detail
- GET /api/trials/:id/reminders - Trial's reminders
- GET /api/trials/:id/calendar.ics - Calendar export
- POST /api/trials/:id/cancel - Mark trial as canceled (logs event)
- GET /api/trials/:id/cancel-click - Track cancel link click + redirect to cancel URL
- GET /api/services/search?q= - Fuzzy search 585 services (fuse.js, threshold 0.35, top 10)
- GET /api/admin/metrics - Admin metrics (requires X-ADMIN-KEY header or ?key= query param)
- GET /api/billing/prices - Plan price IDs (gated by BILLING_ENABLED)
- POST /api/billing/create-checkout-session - Stripe checkout (gated)
- POST /api/billing/sync - Sync subscription status from Stripe (gated)
- POST /api/billing/create-portal-session - Stripe billing portal (gated)
- POST /api/stripe/webhook - Stripe webhook (gated)
- POST /api/debug/send-test-email - Send test email (requires X-DEBUG-KEY header)
- POST /api/debug/run-reminders-now - Manually trigger due reminders (requires X-DEBUG-KEY header)
- POST /api/cron/reminders - Process due reminders (requires X-CRON-KEY header)
- POST /api/cron/email-scan - Scan Gmail for up to 10 Pro users (requires X-CRON-KEY header)
- GET /api/gmail/connect - Redirect to Google OAuth consent screen (Pro only)
- GET /api/gmail/callback - Handle OAuth callback, save tokens, redirect to /settings?gmailConnected=1
- POST /api/gmail/disconnect - Revoke token + clear gmail fields (Pro only)
- POST /api/gmail/scan - Run Gmail scan for current user (Pro + scanning enabled + gmail connected)
- GET /api/suggested-trials - List "new" status suggestions for current user (Pro + scanning enabled)
- POST /api/suggested-trials/:id/add - Create trial from suggestion, mark "added"
- POST /api/suggested-trials/:id/ignore - Mark suggestion "ignored"
- GET /api/reviews - All approved reviews (public)
- GET /api/reviews/featured - Up to 6 approved reviews for landing page (public)
- POST /api/reviews/submit - Submit a review (requires auth, source=in_app, pending approval)
- GET /api/admin/reviews - All reviews for admin (requires ADMIN_KEY)
- POST /api/admin/reviews/:id/approve - Approve a review (requires ADMIN_KEY)
- POST /api/admin/reviews/:id/feature - Toggle featured status (requires ADMIN_KEY)
- DELETE /api/admin/reviews/:id - Delete a review (requires ADMIN_KEY)

## Pricing Plans
- **Free ($0):** 3 active trials, email reminders, cancel link storage
- **Plus ($3.99/mo or $40.70/yr):** Unlimited trials, calendar export, reminder customization
- **Pro ($7.99/mo or $81.50/yr):** Everything in Plus, Gmail email scanning (opt-in), priority support
- **BILLING_ENABLED=true**: Stripe checkout, billing portal, webhook sync all active
- Trial limits: Free=3, Plus/Pro=unlimited (null limit)
- Stripe products created via `npx tsx server/seed-products.ts`

## Gmail Email Scanning (Pro Feature)
- **Privacy-first:** Opt-in only. Scans metadata + snippet only (no email body stored)
- **OAuth flow:** User clicks "Connect Gmail" → redirects to /api/gmail/connect → Google consent → /api/gmail/callback → tokens saved to DB
- **Scan process:** Keywords query searches last 60 days, extracts service name from sender domain, guesses end date via regex, guesses amount via regex, computes confidence score
- **Suggested trials:** Shown in dashboard for Pro users with scanning enabled and pending suggestions
- **Requires env vars:** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (set to {APP_URL}/api/gmail/callback)
- **Google Cloud setup needed:** Enable Gmail API, create OAuth 2.0 credentials, add redirect URI

## Analytics
- **analytics_events** table tracks: signup, login, trial_created, trial_canceled, cancel_link_clicked, email_scan
- Each event has userId, event name, JSON metadata, timestamp
- Admin metrics endpoint at GET /api/admin/metrics (protected by ADMIN_KEY env var)

## Database Models
- **users**: id, email, passwordHash, timezone, plan (FREE/PLUS/PRO/PREMIUM), stripeCustomerId, stripeSubscriptionId, subscriptionStatus, currentPeriodEnd, emailScanningEnabled, gmailConnected, gmailAccessToken, gmailRefreshToken, gmailTokenExpiry, lastEmailScanAt, createdAt
- **trials**: id, userId, serviceName, serviceUrl, domain, iconUrl, cancelUrl, startDate, endDate, renewalPrice, currency, status, canceledAt, createdAt
- **reminders**: id, trialId, userId, remindAt, type (THREE_DAYS/TWO_DAYS/ONE_DAY), status (PENDING/SENT/SKIPPED/FAILED), sentAt, provider, providerMessageId, lastError, createdAt
- **analytics_events**: id, userId, event, metadata (JSON string), createdAt
- **suggested_trials**: id, userId, provider, messageId (unique per user+messageId), fromEmail, fromDomain, subject, receivedAt, serviceGuess, endDateGuess, amountGuess, currencyGuess, confidence (0-100), status (new/added/ignored), createdAt
- **reviews**: id, rating (1-5), text, name, location, source (manual/in_app/import), isApproved, isFeatured, userId, createdAt

## Environment Variables
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- BILLING_ENABLED - "true" to enable Stripe billing, "false" for Early Access mode
- ADMIN_KEY - Secret key for admin metrics endpoint
- CRON_KEY - Secret for cron endpoint authentication
- APP_URL - Application URL for email links and OAuth redirect base
- RESEND_API_KEY - Resend email API key (optional, logs to console if not set)
- FROM_EMAIL - Email sender address (default: "RecallTrial <onboarding@resend.dev>", currently set to notifications@recalltrial.app)
- REPLY_TO_EMAIL - Reply-to address for emails (optional)
- DEBUG_KEY - Secret key for debug endpoints (send-test-email, run-reminders-now)
- STRIPE_PLUS_MONTHLY_PRICE_ID - Stripe price ID for Plus monthly
- STRIPE_PLUS_YEARLY_PRICE_ID - Stripe price ID for Plus yearly (15% off)
- STRIPE_PRO_MONTHLY_PRICE_ID - Stripe price ID for Pro monthly
- STRIPE_PRO_YEARLY_PRICE_ID - Stripe price ID for Pro yearly (15% off)
- GOOGLE_CLIENT_ID - Google OAuth client ID (for Gmail scanning)
- GOOGLE_CLIENT_SECRET - Google OAuth client secret (for Gmail scanning)
- GOOGLE_REDIRECT_URI - OAuth redirect URI, must be set to {APP_URL}/api/gmail/callback in Google Cloud Console

## Branding
- App name: RecallTrial
- Footer: "© 2026 RecallTrial - All Rights Reserved"
- Default timezone: Asia/Qatar
