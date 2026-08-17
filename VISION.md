# RecallTrial — Subscription Intelligence Expansion

You are working on the existing RecallTrial codebase.

RecallTrial currently protects users from unwanted free-trial charges. The current Gmail scanning system is **100% deterministic/rule-based** using TypeScript regexes and keyword scoring. Do NOT replace the existing system blindly. Extend it into a broader **Subscription Intelligence & Savings Platform** while preserving all existing functionality.

## 1. PRODUCT VISION

RecallTrial should evolve from:

> “Never get charged for a free trial again.”

into:

> “Never pay for a subscription you don't need.”

The long-term product should detect, understand, monitor, and help users manage recurring subscriptions.

The first data surface is Gmail.

The architecture should eventually support:

1. Gmail
2. Outlook/email providers
3. Financial transaction providers
4. Browser extension
5. Manual subscription entry

But ONLY Gmail is in scope for the current implementation unless the existing codebase already has infrastructure that makes another source trivial.

The core product entity should become a normalized:

# Subscription

A subscription can originate from:

* free trial
* recurring subscription
* annual subscription
* monthly subscription
* recurring payment
* renewal
* detected invoice/receipt
* manually entered subscription

---

# 2. CRITICAL ENGINEERING PRINCIPLE

DO NOT destroy or rewrite the existing Gmail detection pipeline unless necessary.

Current relevant architecture:

* `server/gmail.ts`
* `server/gmailKeywords.ts`
* `server/storage.ts`
* `shared/schema.ts`
* Gmail OAuth using `gmail.readonly`
* metadata + Gmail snippet fetching
* `suggested_trials`
* `trials`
* Pro email scanning
* user-triggered scan
* hourly cron email scan

Current pipeline is deterministic and should remain the first-pass detection layer.

We want:

Gmail
↓
Existing deterministic detector
↓
Normalized email/subscription event
↓
Subscription intelligence engine
↓
Subscription records
↓
Insights / alerts / recommendations
↓
Dashboard

Do not introduce an LLM dependency into every scanned email.

The system should remain functional even if an AI provider is unavailable.

---

# 3. DATABASE MODEL EVOLUTION

Inspect the existing Drizzle/PostgreSQL schema before changing anything.

Create the minimum additional schema necessary to support subscription intelligence.

Prefer extending existing tables where appropriate instead of creating redundant data models.

The core normalized subscription should support at minimum:

* id
* userId
* serviceName
* normalizedServiceName
* merchantDomain
* category
* status
* subscriptionType
* billingInterval
* price
* currency
* monthlyEquivalent
* annualEquivalent
* trialStartDate
* trialEndDate
* nextRenewalDate
* subscriptionStartDate
* cancellationDate
* cancellationUrl
* source
* confidence
* lastDetectedAt
* createdAt
* updatedAt

Possible statuses:

* trial
* active
* canceled
* expired
* paused
* unknown

Possible subscription types:

* free_trial
* monthly
* annual
* recurring
* one_time
* unknown

Do not blindly add every field if an existing schema already represents the same concept.

Normalize carefully.

---

# 4. EMAIL EVENT MODEL

Instead of thinking of each email only as a “trial suggestion”, introduce the concept of a subscription-related email event.

Examples:

* trial_started
* trial_ending
* subscription_started
* subscription_renewed
* payment_received
* invoice_received
* price_changed
* cancellation_requested
* cancellation_confirmed
* subscription_expired
* subscription_paused
* unknown_subscription_event

A single subscription can have many events.

Example:

Canva:

trial_started
↓
trial_ending
↓
subscription_started
↓
payment_received
↓
payment_received
↓
price_changed

This allows RecallTrial to build a history instead of treating every email as an isolated event.

---

# 5. IMPROVE CURRENT GMAIL EXTRACTION

Preserve the current deterministic extraction but expand it.

Current system already extracts:

* service
* end date
* start date
* amount
* confidence

Add support for:

* billing interval
* renewal date
* cancellation deadline
* cancellation URL
* subscription status
* trial duration
* merchant/service name
* category
* price-change information
* previous price
* new price
* payment processor
* event type
* recurring-payment indicators

## Cancellation URL

This is currently missing.

Implement safe extraction from the available Gmail data.

Do NOT fetch arbitrary external pages.

If the relevant URL exists in the available Gmail message data, extract it.

If only the snippet is available and the URL is not available, mark:

`cancellationUrl = null`

Do not invent URLs.

---

# 6. IMPORTANT: FULL EMAIL BODY

The current implementation intentionally uses Gmail metadata + snippet and does not fetch the full email body.

Do NOT automatically change this for every email.

First determine whether the snippet is sufficient.

If a higher-confidence extraction requires more information, implement an optional second-stage fetch:

1. Search/filter using current lightweight method.
2. Only for candidate subscription emails, optionally fetch the minimal required message content.
3. Parse only what is necessary.
4. Do not persist the raw email body unless there is a compelling existing architectural reason.

Privacy is a first-class requirement.

The product should be able to say:

> “RecallTrial analyzes relevant subscription information from your email.”

It should NOT become:

> “RecallTrial stores your entire mailbox.”

---

# 7. SUBSCRIPTION ENTITY RESOLUTION

This is one of the most important features.

Different emails may refer to the same subscription:

Example:

* `billing@spotify.com`
* `no-reply@spotify.com`
* `receipts@stripe.com`
* subject: “Your Spotify payment”

These should resolve to:

**Spotify**

Build a normalized merchant/service resolution layer.

Use:

1. known provider mappings
2. sender domain
3. payment processor extraction
4. subject/body/snippet signals
5. deterministic aliases
6. optional AI enrichment as a fallback

Do not use an LLM as the primary resolver if deterministic information is sufficient.

Create a reusable service resolution abstraction.

---

# 8. SUBSCRIPTION DEDUPLICATION

Multiple emails should update the same subscription instead of creating duplicates.

Example:

Netflix:

Email 1 → subscription detected
Email 2 → renewal detected
Email 3 → payment detected
Email 4 → price increase detected

All should update one normalized Netflix subscription and create separate events/history records.

Use a robust identity strategy based on combinations such as:

* user
* normalized merchant
* merchant domain
* subscription identity
* billing/payment clues

Do not rely exclusively on message ID.

---

# 9. MONTHLY AND ANNUAL COST CALCULATION

For every subscription, calculate:

* current recurring price
* monthly equivalent
* annual equivalent

Examples:

$10/month:

Monthly = $10
Annual = $120

$120/year:

Monthly equivalent = $10
Annual = $120

Handle currencies correctly.

Do not blindly convert currencies without an FX source.

For different currencies, keep native currency totals unless a reliable FX infrastructure already exists.

Dashboard should show:

## Your recurring spending

Monthly:

$87.98

Annualized:

$1,055.76

---

# 10. SUBSCRIPTION DASHBOARD

Create a new dashboard section.

Users should be able to see:

## All subscriptions

For every subscription display:

* service
* category
* price
* billing interval
* next renewal
* status
* confidence
* source

Example:

Spotify
$11.99/month
Renews Sep 12
Entertainment

Canva
$15/month
Renews Aug 19
Design

Adobe
$19.99/month
Renews Sep 3
Software

---

# 11. UPCOMING CHARGES

Create a “Upcoming” view.

Show:

### Next 30 days

Spotify — $11.99 — Aug 20
Canva — $15 — Aug 22
Adobe — $19.99 — Aug 27

Total upcoming recurring charges:

$46.98

Allow filtering:

* 7 days
* 30 days
* 90 days

---

# 12. SUBSCRIPTION CALENDAR

Create a renewal timeline/calendar.

Users should be able to visually understand when recurring payments occur.

Example:

August 19
Canva — $15

August 22
Spotify — $11.99

August 27
Adobe — $19.99

September 3
Netflix — $17.99

This should integrate with the existing reminder infrastructure.

---

# 13. PRICE INCREASE DETECTION

Implement subscription price history.

If the system previously detected:

Adobe
$19.99/month

and later detects:

Adobe
$23.99/month

create a price-change event.

Calculate:

Previous price
New price
Absolute increase
Percentage increase
Annual additional cost

Example:

> Adobe increased from $19.99 to $23.99/month.

> That's $48 more per year.

This is a major product feature.

---

# 14. UNUSED / POTENTIALLY UNNECESSARY SUBSCRIPTIONS

Do NOT falsely claim that a subscription is unused unless the system has reliable usage data.

Email data alone generally cannot prove actual product usage.

Instead use careful language:

* “Possibly unnecessary”
* “Worth reviewing”
* “No recent subscription-related activity detected”
* “We haven't detected recent activity related to this service”

Create a recommendation engine.

Example:

### Worth reviewing

Adobe
$19.99/month

No recent subscription-related activity detected.

Potential annual savings:

$239.88

Never state that the user definitely does not use the product unless actual usage data is available.

---

# 15. POTENTIAL SAVINGS ENGINE

Create:

`potentialMonthlySavings`

and:

`potentialAnnualSavings`

based on subscriptions the system recommends reviewing.

Example:

3 subscriptions worth reviewing:

$19.99/month
$12.99/month
$9.99/month

Potential savings:

$42.97/month

$515.64/year

This should be clearly labeled as:

> Potential savings

NOT guaranteed savings.

---

# 16. THE ACTIVATION MOMENT

When a user completes their first Gmail scan, show a high-value summary.

Example:

# We found your subscriptions

18 subscriptions detected.

Estimated recurring cost:

$126.42/month

$1,517.04/year

We found:

* 3 upcoming renewals
* 2 price changes
* 3 subscriptions worth reviewing

Potential savings:

$428/year

This should be one of the most important onboarding/activation experiences.

Do not overwhelm the user.

---

# 17. AI SUBSCRIPTION ANALYST

Introduce an AI layer ONLY where it adds value.

The AI should NOT scan every email.

The deterministic pipeline should first create structured subscription data.

Then AI can operate on the structured data.

Example user questions:

“What subscriptions am I paying for?”

“How much do I spend every month?”

“Which subscriptions increased in price?”

“What subscriptions should I review?”

“How much could I save?”

“What renews this week?”

“Show me my annual subscriptions.”

The AI should answer using RecallTrial's structured data and available evidence.

Never fabricate information.

If evidence is insufficient, explicitly say so.

---

# 18. AI EMAIL CLASSIFICATION — OPTIONAL SECONDARY LAYER

If an LLM provider is introduced, use it as a fallback/enrichment layer.

Preferred architecture:

Deterministic detection
↓
High confidence?
YES → accept

NO / ambiguous
↓
AI classification
↓
Structured JSON result
↓
Validation with Zod
↓
Accept/reject

The AI must return structured data, not free-form text.

Example conceptual output:

```json
{
  "isSubscriptionRelated": true,
  "eventType": "trial_ending",
  "serviceName": "Canva",
  "price": 15,
  "currency": "USD",
  "billingInterval": "monthly",
  "trialEndDate": "2026-08-19",
  "confidence": 0.96
}
```

Use strict Zod validation.

Never allow AI output to directly write arbitrary database fields.

Do not send raw emails to an external AI provider unless the user has explicitly consented and the privacy architecture/legal requirements support it.

Prefer sending only the minimum relevant extracted text/signals.

---

# 19. AI PROVIDER ARCHITECTURE

Do not hard-code OpenAI/Claude/Gemini throughout the application.

Create an abstraction such as:

`SubscriptionIntelligenceProvider`

with an implementation that can later support:

* OpenAI
* Anthropic
* Gemini
* local model

The application should not depend directly on one provider.

Use environment variables.

Never expose AI API keys to the frontend.

If no AI provider is configured, the entire product must still function using deterministic logic.

---

# 20. AI COST CONTROL

Do NOT call an LLM for every Gmail message.

Use:

1. Gmail query
2. deterministic filtering
3. deterministic extraction
4. confidence threshold
5. only ambiguous candidates → AI

Cache AI results where appropriate.

Do not repeatedly classify the same Gmail message.

Store model/provider/version metadata for AI-generated classifications so results can be audited/reprocessed.

---

# 21. MONTHLY SUBSCRIPTION REPORT

Add a monthly report.

Example:

# Your August Subscription Report

14 active subscriptions

$126.42/month recurring cost

$1,517.04 annualized

This month:

3 new subscriptions
1 price increase
2 canceled
3 upcoming renewals

Potential savings:

$38/month

The report should be useful even when the user has no trial ending.

This is important for retention.

---

# 22. SMART ALERTS

Use the existing reminder infrastructure and expand it.

Potential alerts:

### Trial ending

“You'll be charged $15 in 3 days.”

### Renewal

“Spotify renews tomorrow for $11.99.”

### Price increase

“Adobe increased your subscription by 20%.”

### Upcoming expensive renewal

“Your annual Adobe renewal of $239 is coming in 7 days.”

### New subscription

“We detected a new recurring subscription.”

Do not spam users.

Create notification preferences.

---

# 23. SUBSCRIPTION RISK SCORE

Create an optional subscription review/risk score.

Do NOT pretend it is a financial or credit score.

It should represent:

> “How strongly RecallTrial recommends reviewing this subscription.”

Potential factors:

* upcoming renewal
* price increase
* high annual cost
* no recent subscription-related activity
* trial converting soon
* unusual price change
* insufficient information

Example:

Adobe

Review score: 82/100

Reasons:

* $239.88/year
* price recently increased
* renewal approaching
* no recent subscription-related email activity

Always explain the reasons behind the score.

---

# 24. CANCELLATION EXPERIENCE

Add cancellation support carefully.

For every subscription, provide:

* cancellation URL if reliably extracted
* official service URL if already known from trusted provider mapping
* cancellation instructions if available

Never invent a cancellation URL.

Do not automate cancellation actions against third-party services without explicit user interaction and appropriate authorization.

The UX can be:

[Review subscription]

[Cancel subscription]

[Keep subscription]

---

# 25. INTERNATIONALIZATION

The current detector is English-centric.

Improve architecture so language-specific detection can be added.

At minimum design the system for:

* English
* French
* Arabic

Do NOT simply translate the existing English regex list and assume the problem is solved.

Create language-aware keyword/configuration structures.

Date parsing must support:

* MM/DD/YYYY
* DD/MM/YYYY
* YYYY-MM-DD
* textual dates
* relative dates

Avoid ambiguous date interpretation when the source does not make locale clear.

Never silently turn:

`05/06/2026`

into the wrong date.

Use email/user locale where available.

---

# 26. GMAIL SCAN SCALE

Current system:

* up to 500 messages per phase
* two phases
* cron processes up to 10 users per hourly run

Do not leave this as an undocumented scalability bottleneck.

Design the scan system for:

* pagination
* resumable scans
* per-user scan cursor/state
* incremental scanning
* rate-limit handling
* retry/backoff
* job queue if existing architecture supports it

Do not suddenly scan unlimited Gmail data.

Keep the existing 90-day initial scan behavior unless there is a product reason to change it.

After initial scan, use incremental scanning.

---

# 27. DATA PRIVACY

This is extremely important.

RecallTrial's product is based on highly sensitive email-derived financial/subscription information.

Implement privacy-by-design.

Requirements:

* never store full email bodies unnecessarily
* store only extracted subscription intelligence
* minimize Gmail data retention
* encrypt sensitive tokens using existing secure architecture
* never log OAuth tokens
* never log raw email content
* never expose email snippets in frontend APIs unless required
* enforce user ownership on every subscription/event query
* AI calls must minimize submitted data
* document what data is processed and why

Review the existing privacy policy/terms requirements before shipping the new functionality.

Do not claim certifications or compliance that the application does not actually have.

---

# 28. USER DATA DELETION

When a user disconnects Gmail:

Define exactly what happens.

At minimum:

* revoke/stop Gmail scanning
* stop scheduled scans
* stop future email ingestion

Do NOT automatically delete subscription history unless that matches the current product policy.

Provide a clear mechanism to delete email-derived data if required by the application's privacy/data-deletion policy.

Audit the existing account deletion flow.

---

# 29. EXISTING TRIAL SYSTEM COMPATIBILITY

Existing trials must continue working.

Do not break:

* trial reminders
* trial creation
* suggested trials
* manual trial creation
* Gmail OAuth
* Pro restrictions
* cron reminders
* cron email scan
* existing notification preferences
* existing pricing/plan logic

A detected free trial should be represented as both:

1. a subscription intelligence event/entity
2. the existing trial workflow where appropriate

Avoid duplicate reminders.

There must be a single source of truth for dates/reminder scheduling.

---

# 30. API DESIGN

Inspect existing REST API conventions.

Add APIs for:

* subscriptions
* subscription detail
* subscription history/events
* upcoming renewals
* spending summary
* potential savings
* price changes
* AI analyst
* user preferences
* scan status

Use existing authentication middleware.

Every endpoint must verify ownership.

Use Zod for request/response validation where the project already uses Zod.

Do not expose internal database fields unnecessarily.

---

# 31. FRONTEND UX

Do not simply add a huge table.

The primary dashboard should answer four questions immediately:

### 1. What am I paying?

Monthly recurring cost.

### 2. What's coming up?

Upcoming renewals.

### 3. What changed?

Price increases/new subscriptions.

### 4. What can I save?

Potential savings.

Suggested dashboard:

---

## Subscription Overview

$126.42 / month

$1,517.04 / year

14 active subscriptions

---

## Upcoming

Canva — $15 — Aug 19
Spotify — $11.99 — Aug 22
Adobe — $23.99 — Aug 27

---

## Changes

Adobe ↑ 20%

---

## Potential Savings

3 subscriptions worth reviewing

$42/month potential savings

[Review]

---

## Ask RecallTrial

“How much did I spend on subscriptions this year?”

---

# 32. SERVICE CATEGORIES

Create normalized categories such as:

* Entertainment
* Software
* Productivity
* Cloud Storage
* Education
* Fitness
* Finance
* Shopping
* News
* Gaming
* AI
* Business
* Other

Do not over-categorize.

Unknown services should remain:

`Other`

AI may suggest a category, but it must be validated.

---

# 33. SUBSCRIPTION SEARCH/FILTER

Users should be able to search:

Netflix

and filter:

* active
* trial
* canceled
* monthly
* annual
* category
* upcoming renewal
* price

This becomes increasingly important as subscription count grows.

---

# 34. DO NOT BUILD BANK INTEGRATION YET

Design the architecture so financial integrations can be added later.

Do NOT implement bank connectivity in this phase.

Do NOT collect financial credentials.

Create a clean future abstraction:

`DataSource`

Potential future implementations:

* GmailDataSource
* OutlookDataSource
* BankDataSource
* BrowserDataSource
* ManualDataSource

Current implementation:

`GmailDataSource`

This allows RecallTrial to evolve without rewriting the subscription engine.

---

# 35. DO NOT BUILD BROWSER EXTENSION YET

Only design the interfaces needed for future browser integration.

Future use case:

User visits:

“Start 30-day free trial”

RecallTrial browser extension:

> 30-day trial → $19.99/month

[Protect this trial]

But this is future scope.

Do not build it now unless the existing repository already contains browser-extension infrastructure.

---

# 36. TESTING REQUIREMENTS

Before considering the implementation complete, add tests for:

## Detection

* trial
* subscription
* renewal
* invoice
* receipt
* price increase
* cancellation
* false positive
* newsletter
* shipping email
* security email

## Dates

* MM/DD/YYYY
* DD/MM/YYYY
* YYYY-MM-DD
* relative dates
* duration dates
* ambiguous dates

## Money

* USD
* EUR
* GBP
* decimal amounts
* annual plans
* monthly plans

## Entity resolution

* direct merchant sender
* Stripe
* PayPal
* billing subdomain
* multiple sender addresses
* duplicate emails

## AI fallback

* valid JSON
* malformed JSON
* missing fields
* low confidence
* AI unavailable
* API timeout
* rate limit

The deterministic system must continue functioning when AI fails.

---

# 37. MIGRATION SAFETY

Before modifying the database:

1. inspect current schema
2. inspect existing relationships
3. inspect current trial queries
4. inspect existing reminder jobs
5. inspect existing user deletion
6. inspect existing Gmail OAuth/token handling

Create proper migrations.

Never drop existing production data.

Never rename/remove existing columns without confirming every usage.

If data migration is required, create a reversible migration strategy.

---

# 38. OBSERVABILITY

Add structured logging for:

* scan started
* scan completed
* candidate detected
* subscription created
* subscription updated
* duplicate resolved
* AI fallback triggered
* AI failed
* price change detected

Do NOT log:

* raw email body
* OAuth tokens
* sensitive personal content

Track useful metrics:

* emails scanned
* candidates detected
* candidates accepted
* candidates rejected
* false-positive feedback
* AI fallback rate
* AI acceptance rate
* subscriptions detected
* duplicate resolution rate

---

# 39. USER FEEDBACK LOOP

Add a way for users to correct detection.

For example:

“This isn't my subscription.”

“This is the wrong service.”

“Wrong price.”

“Wrong renewal date.”

“Already canceled.”

Use these corrections to improve deterministic mappings/rules.

Do not automatically train an AI model from user data.

Store structured corrections.

---

# 40. IMPLEMENTATION ORDER

Implement in this order.

## Phase 1

Audit existing code.

Do not modify code yet.

Produce:

* current architecture summary
* relevant files
* schema changes required
* API changes required
* frontend changes required
* migration risks
* compatibility risks

Then implement.

## Phase 2

Create subscription/event data model.

## Phase 3

Expand deterministic Gmail extraction.

## Phase 4

Entity resolution + deduplication.

## Phase 5

Subscription dashboard.

## Phase 6

Upcoming renewals.

## Phase 7

Monthly/annual cost calculation.

## Phase 8

Price-change detection.

## Phase 9

Potential savings/review recommendations.

## Phase 10

Monthly subscription report.

## Phase 11

AI analyst.

## Phase 12

Optional AI fallback for ambiguous email classification.

## Phase 13

Internationalization improvements.

## Phase 14

Scan scalability/incremental scanning.

## Phase 15

Comprehensive testing and production hardening.

---

# 41. AI ANALYST SAFETY RULE

The AI assistant must never invent subscription information.

If the database says:

Spotify
$11.99/month

AI can explain it.

If the database does not know the renewal date:

Do NOT fabricate one.

Say:

> “I don't have a reliable renewal date for Spotify yet.”

Every financial claim must originate from structured RecallTrial data.

---

# 42. SUCCESS CRITERIA

After implementation, a user connecting Gmail should be able to go from:

“I want to avoid forgetting free trials.”

to:

“RecallTrial knows my subscriptions.”

The user should be able to see:

* all detected subscriptions
* current recurring spending
* annualized spending
* upcoming renewals
* trial conversions
* price increases
* subscription history
* potential savings
* cancellation information where available
* AI-powered answers about their subscription data

And the original free-trial reminder experience must continue working.

---

# 43. FINAL PRODUCT ARCHITECTURE

The target architecture should conceptually become:

GMAIL
↓
Gmail Data Source
↓
Deterministic Extraction
↓
Subscription Event
↓
Entity Resolution
↓
Subscription Graph
↓
┌───────────────────────────────────┐
│ Subscription Intelligence Engine │
├───────────────────────────────────┤
│ • Cost calculation                │
│ • Renewal prediction              │
│ • Price-change detection          │
│ • Review recommendations          │
│ • Potential savings               │
│ • Risk/review score               │
└───────────────────────────────────┘
↓
┌─────────────────────────────────────┐
│ RecallTrial User Experience         │
├─────────────────────────────────────┤
│ Dashboard                           │
│ Upcoming renewals                   │
│ Subscription history                │
│ Savings                             │
│ Alerts                              │
│ Monthly reports                     │
│ AI analyst                          │
└─────────────────────────────────────┘

Future:

Gmail
Outlook
Bank Data
Browser Extension
Manual Entry

should all feed the SAME Subscription Intelligence Engine.

---

# 44. MOST IMPORTANT RULE

Do not over-engineer this into an AI project.

The core competitive advantage should become:

> **RecallTrial builds a reliable, continuously updated map of a user's recurring financial commitments.**

AI is an enhancement layer.

The Subscription Graph is the core product.

Build for correctness, privacy, extensibility, and low operating cost first.

Before changing production code, inspect the existing implementation and explain the proposed changes and any conflicts with the current architecture. Then implement incrementally, run migrations/tests, and report exactly what was changed.
