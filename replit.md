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
- **Scheduling:** Cron endpoint at POST /api/cron/reminders (secured via X-CRON-KEY header)

## Project Structure
```
client/src/
  App.tsx           - Main router with auth provider
  lib/auth.tsx      - Auth context (login/signup/logout)
  lib/queryClient.ts - TanStack Query setup
  pages/
    landing.tsx     - Public landing page
    auth-login.tsx  - Login page
    auth-signup.tsx - Signup page
    dashboard.tsx   - Main dashboard (urgent/upcoming/canceled trials)
    trial-new.tsx   - Add new trial form with calendar pickers
    trial-detail.tsx - Trial detail with reminders view
    settings.tsx    - User settings (timezone)
  components/
    trial-card.tsx  - Reusable trial card component
server/
  index.ts         - Express server setup
  routes.ts        - All API routes (auth, trials CRUD, cron)
  storage.ts       - Database storage layer (IStorage interface)
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
- GET /api/auth/me - Current user
- PATCH /api/auth/settings - Update timezone
- GET /api/trials - List user's trials
- POST /api/trials - Create trial (auto-creates reminders)
- GET /api/trials/:id - Trial detail
- GET /api/trials/:id/reminders - Trial's reminders
- POST /api/trials/:id/cancel - Mark trial as canceled
- POST /api/cron/reminders - Process due reminders (requires X-CRON-KEY header)

## Database Models
- **users**: id, email, passwordHash, timezone, createdAt
- **trials**: id, userId, serviceName, serviceUrl, domain, iconUrl, cancelUrl, startDate, endDate, renewalPrice, currency, status, canceledAt, createdAt
- **reminders**: id, trialId, userId, remindAt, type, status, sentAt, createdAt

## Environment Variables
- DATABASE_URL - PostgreSQL connection string
- SESSION_SECRET - Session encryption key
- CRON_KEY - Secret for cron endpoint authentication
- APP_URL - Application URL for email links
- RESEND_API_KEY - Resend email API key (optional, logs to console if not set)

## Branding
- App name: RecallTrial
- Footer: "Operated by SKAHM LTD (UK)."
- Default timezone: Asia/Qatar
