1. Most important: does it actually understand the current system?

Don't accept a generic report saying:

“Create subscriptions table, add APIs, update frontend.”

We need evidence that it actually traced the existing implementation.

The report should identify the real files/functions involved in:

Gmail OAuth
Gmail scanning
suggested_trials
trials
reminder scheduling
cron email scanning
cron reminders
user plans/Pro restrictions
database schema
storage layer
API routes
frontend trial UI
authentication
account deletion
Gmail disconnect

For example, it should be able to say something like:

server/gmail.ts:scanGmailForTrials() currently produces SuggestedTrial objects and writes through storage.upsertSuggestedTrial().

That's much more useful than architectural theory.

2. 🚨 Watch for a dangerous recommendation: replacing trials

I would be very cautious if Claude recommends:

“Replace the existing trials table with subscriptions.”

Don't do that initially.

RecallTrial already has working trial functionality.

The safer architecture is:

Existing
trials
   │
   │
   └──────────────┐
                  ↓
          Subscription Intelligence
                  ↑
                  │
Gmail → Subscription Events

Eventually, trials can become a specialized representation of a subscription/trial state.

But we shouldn't destroy something that's already working.

3. Look carefully at proposed schema changes

The report should distinguish between:

New entities

For example:

subscriptions
subscription_events
subscription_price_history

and:

Existing entities that should be extended

For example:

trials
suggested_trials
users

I want Claude to explain why each table is needed.

A warning sign is a schema proposal containing 15–20 new tables immediately.

We don't need to create a massive enterprise data model on day one.

4. The biggest architectural question: what is the Subscription Graph?

Claude should explain this concretely.

I would expect something conceptually like:

User
 │
 ├── Subscription: Spotify
 │      ├── Event: trial_started
 │      ├── Event: trial_ending
 │      ├── Event: payment
 │      └── Event: price_changed
 │
 ├── Subscription: Adobe
 │      ├── Event: subscription_started
 │      ├── Event: payment
 │      └── Event: price_changed
 │
 └── Subscription: Netflix
        └── Event: renewal

The subscription is the persistent entity.

The emails are evidence/events that update it.

That's an important distinction.

5. Watch for raw email storage

This is a major one.

Claude should explicitly identify where email information currently exists.

Your current implementation is actually in a good position because, according to your audit, it uses:

Gmail metadata + snippet

rather than downloading entire email bodies.

We should preserve that privacy advantage.

The future architecture should ideally be:

Gmail
 ↓
Extract
 ↓
Normalize
 ↓
Subscription Event
 ↓
Store structured data

rather than:

Gmail
 ↓
Store email
 ↓
AI analyzes entire mailbox

If Claude proposes storing full email bodies, stop and challenge that recommendation.

6. AI should NOT become the center of the architecture

This is probably the biggest thing I'd watch.

If the Phase 1 report says something like:

“We need OpenAI/Claude to classify all emails.”

I'd reject that architecture.

The intended architecture is:

                    ┌─ high confidence → accept
Gmail
 ↓
Deterministic
parser
 ↓
Confidence ────────┤
                    └─ ambiguous → AI → validate → accept/reject

Not:

Gmail
 ↓
LLM
 ↓
Everything

This matters for:

cost
latency
privacy
reliability
debugging
reproducibility
7. Pay attention to the current Gmail limitation

Your current scanner searches roughly:

90 days
up to 500 messages per phase
two search phases
cron batch of 10 Pro users

Claude should identify this as a scaling concern, but shouldn't immediately solve it by massively increasing Gmail API calls.

The correct long-term architecture is likely:

Initial scan

90-day historical scan.

Subsequent scans

Incremental scan:

lastScanTime
      ↓
Gmail query:
after:lastScanTime
      ↓
process only new messages

This is much more scalable.

8. Cron architecture needs special attention

You currently have scheduled jobs.

Claude should inspect:

how cron authentication works
how jobs are triggered
whether jobs are idempotent
what happens if a job fails halfway through
whether duplicate processing is possible
whether multiple Railway instances could execute the same job
how the 10-user limit works

We don't want:

Cron
 ↓
scan 10 users
 ↓
failure
 ↓
same users scanned again
 ↓
duplicate processing

The new subscription event system should be idempotent.

9. Check the existing reminder logic before changing dates

This is subtle.

You already have:

3 days before
2 days before
1 day before

Those reminders are presumably tied to the existing trials model.

When we introduce:

nextRenewalDate

we need to decide which system owns reminders.

Ideally:

Subscription
     ↓
Renewal date
     ↓
Reminder engine

rather than having two competing date/reminder systems.

Otherwise you could eventually get:

Canva reminder from trials

and

Canva renewal reminder from subscriptions

on the same day.

10. Entity resolution will be harder than it looks

This is one section where I want Claude to be particularly detailed.

Example:

stripe.com
paypal.com
spotify.com
billing.spotify.com
noreply@spotify.com

may all relate to one subscription.

But:

stripe.com

doesn't mean the subscription is Stripe.

Stripe may simply be the payment processor.

So the system needs to distinguish:

merchant

from

payment processor

For example:

Merchant:
Spotify


Payment processor:
Stripe


Subscription:
Spotify Premium

This will be critical for accurate subscription detection.

11. Price-history design

The audit should explain how it plans to detect:

$19.99
   ↓
$23.99

It shouldn't simply overwrite:

subscriptions.price

because then we lose historical information.

Better:

Subscription
    │
    ├── current price: $23.99
    │
    └── price history
          ├── $19.99 — Jan 2026
          └── $23.99 — Aug 2026

That history is what allows the future:

“Adobe increased 20%.”

feature.

12. Be skeptical about “unused subscription” detection

This is another important issue.

From Gmail alone, we cannot reliably know whether someone actually uses Netflix.

For example:

No Netflix emails in 30 days

doesn't mean:

User hasn't watched Netflix in 30 days.

So Claude should NOT design:

“No email = unused.”

Instead:

“No recent subscription-related activity detected.”

And perhaps:

“Worth reviewing.”

This distinction protects the product from making misleading financial recommendations.

13. Check how confidence scores evolve

The current system has a global confidence score.

That's fine for the current MVP.

But when we start detecting:

trials
subscriptions
renewals
invoices
price changes
cancellations

one score may become inadequate.

Claude should consider event-specific confidence:

trial detection confidence
subscription confidence
price-change confidence
date confidence
merchant confidence

Rather than:

confidence = 82

without explaining what that 82 means.

14. Internationalization

This should be flagged, but I would not make it an immediate blocker.

Current system is English-centric.

Eventually:

English
French
Arabic

will be important.

But don't let Claude turn Phase 1 into a giant internationalization project.

The audit should distinguish:

architectural preparation

from

implementation now.

15. Check backwards compatibility

The report should explicitly answer:

Existing user with 50 trials?

What happens?

Existing Pro user?

What happens?

Existing Gmail connection?

Does it need to reconnect?

Existing suggested trial?

Does it remain valid?

Existing reminder?

Does it still fire?

Existing subscription that was manually created?

Can it coexist with detected subscriptions?

User disconnects Gmail?

What happens to existing subscription data?

Those questions are more important than adding another dashboard card.

16. Migration risk should be classified

I would want Claude to classify migrations as:

🟢 Low risk

Adding nullable columns/tables.

🟡 Medium risk

Backfilling existing trials into subscriptions.

🔴 High risk

Changing existing trial/reminder logic.

🔴 Very high risk

Changing authentication/OAuth/token handling.

That will help us decide implementation order.

17. Look for “big bang” implementation recommendations

If Claude says:

“Implement all 15 phases together.”

Don't do it.

Your current strategy is correct:

Audit
 ↓
Phase 1
 ↓
Test
 ↓
Deploy
 ↓
Observe
 ↓
Phase 2
 ↓
Test
 ↓
Deploy

For RecallTrial, I would actually break some phases into smaller production-safe increments.

For example:

Subscription schema

→ deploy

Subscription detection

→ deploy

Dashboard

→ deploy

Price history

→ deploy

Savings

→ deploy

rather than one giant PR.

18. The most important question Claude should answer

Ask:

What is the smallest change that lets us detect recurring subscriptions without touching the existing trial-reminder system?

That is probably our first implementation target.

Ideally:

Existing Gmail scanner
       │
       ├── existing trial detection → existing system
       │
       └── subscription detection → new subscription system

This gives us a parallel path.

That's much safer than modifying the production trial pipeline immediately.

19. What I want to see in Claude's Phase 1 report

When you get it, send me the full report, not just Claude's summary.

I'll specifically look for these sections:

Area	What we're checking
Current architecture	Did Claude actually trace the code?
Database	Are proposed changes minimal and logical?
Gmail	Can we extend without breaking current scanning?
Trials	Is existing functionality protected?
Reminders	Is there one source of truth for dates?
Cron	Is processing idempotent/scalable?
Subscription Graph	Is the data model actually coherent?
AI	Is AI optional rather than foundational?
Privacy	Are raw emails avoided?
Entity resolution	Merchant vs processor handled correctly?
Price history	Historical data preserved?
Migration	Can it be deployed safely?
Testing	Are regression tests included?
Complexity	Are phases realistically estimated?
One thing I would especially avoid

Don't let Claude Code start implementing anything just because it says:

“Phase 1 audit complete.”

Phase 1 should be analysis only.

Once you paste Claude's report here, we can do a technical review of the report before giving Claude permission to touch the code. That is the right checkpoint for protecting the current RecallTrial production system.