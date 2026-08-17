# RecallTrial — Phase 1 Audit: Subscription Intelligence Expansion

**Status: Analysis only. No code was written or modified to produce this report.**
Structured to answer every point in `AUDIT_CRITERIA.md` explicitly, in the same order, against the actual traced implementation.

---

## 1. Does this report actually understand the current system?

Traced, not theorized. Real files/functions for every area `AUDIT_CRITERIA.md` names:

| Area | Real implementation |
|---|---|
| Gmail OAuth | `server/gmail.ts:15-21` `getOAuthClient()` (scope `gmail.readonly` only, `gmail.ts:28`); `generateAuthUrl()` `gmail.ts:23-31`; `exchangeCodeForTokens()` `gmail.ts:33-45`; `revokeToken()` `gmail.ts:47-54`. |
| Gmail scanning | `server/gmail.ts:349-520` `scanGmailForTrials()` — two-phase `gmail.users.messages.list` query (`gmail.ts:363-380`), per-message `gmail.users.messages.get` with `format: "metadata"` only (`gmail.ts:404-409`), filter/score/extract pipeline, dedup (`gmail.ts:499-517`). |
| `suggested_trials` | Table: `shared/schema.ts:105-123`. Write path: `storage.upsertSuggestedTrial()` `server/storage.ts:362-380`, called from both `POST /api/gmail/scan` (`routes.ts:337`) and `POST /api/cron/email-scan` (`routes.ts:999`). |
| `trials` | Table: `shared/schema.ts:31-46`. Created via `POST /api/trials` (`routes.ts:498`), which calls `computeReminders()` (`routes.ts:92-108`) to generate the 3 reminder rows at creation time. |
| Reminder scheduling | `computeReminders()` `routes.ts:92-108` — the *only* generator of `reminders` rows, driven purely by `trials.endDate` at trial-creation time. `storage.createReminder()` `storage.ts:142-150`. |
| Cron email scanning | `POST /api/cron/email-scan` `routes.ts:979-1013`. Auth via `X-CRON-KEY` header match against `process.env.CRON_KEY` (`routes.ts:980-983`). Pulls candidates via `storage.getProUsersWithScanningEnabled()` (`storage.ts:339-347`), takes `.slice(0, 10)` (`routes.ts:987`). |
| Cron reminders | `POST /api/cron/reminders` `routes.ts:964-977`, same `X-CRON-KEY` gate, calls `processRemindersNow()` `routes.ts:807-839`. |
| User plans / Pro restrictions | `requirePro` `routes.ts:43-51` (plan ∈ {PRO, PREMIUM}); `requireEmailScanning` `routes.ts:53-61` (Pro **and** `user.emailScanningEnabled`); `requireBilling` `routes.ts:36-41` (global feature flag). |
| Database schema | `shared/schema.ts` — 8 tables total today: `users`, `trials`, `reminders`, `suggested_trials`, `password_reset_tokens`, `processed_purchase_events`, `reviews`, `analytics_events`. No subscription/event entity exists. |
| Storage layer | `server/storage.ts` — Drizzle query layer behind an `IStorage` interface; every user-scoped query hand-writes `and(eq(table.id, id), eq(table.userId, userId))` — there is no centralized ownership-enforcement helper. |
| API routes | `server/routes.ts` `registerRoutes()` — single 1000+ line file, all routes registered inline, Express 5. |
| Frontend trial UI | `client/src/pages/trial-new.tsx` (create), `client/src/pages/dashboard.tsx` (list, keyed off `user.activeTrialCount`), `client/src/pages/trial-detail.tsx` (single trial view). |
| Authentication | Session-based: `express-session` + `connect-pg-simple` (`routes.ts:118-134`), table auto-created as `session` (`createTableIfMissing: true`), `bcrypt.hash(password, 12)` (`routes.ts:148`), `requireAuth` `routes.ts:29-34` (session-presence check only). |
| Account deletion | **Does not exist.** No route, no UI. Verified: no match for delete-account anywhere in `client/src/pages/settings.tsx`, no corresponding route in `routes.ts`. |
| Gmail disconnect | `POST /api/gmail/disconnect` `routes.ts:306-319` — calls `revokeToken()` then `storage.clearUserGmailTokens()`. Does **not** touch `suggested_trials` rows already created from that connection. |

Example of the level of tracing this report holds itself to, per the criteria's own template:
> `server/gmail.ts:scanGmailForTrials()` currently returns `Array<Omit<SuggestedTrial, "id"|"userId"|"createdAt"|"status">>` and is written through `storage.upsertSuggestedTrial()` (`storage.ts:362`), which does **not** have a working uniqueness guarantee on `message_id` — see §16/§10 below, this is a confirmed production finding, not a guess.

---

## 2. 🚨 Replacing `trials` — explicitly rejected

This report does **not** recommend replacing or migrating away from `trials`. `trials` stays exactly as-is and keeps being the thing `computeReminders()` and the entire existing reminder pipeline operate on. The architecture this report proposes matches the criteria's own diagram:

```
Existing
trials
   │
   └──────────────┐
                  ↓
          Subscription Intelligence
                  ↑
                  │
Gmail → Subscription Events
```

Concretely: a new `subscriptions` table gets an optional `linkedTrialId` (nullable FK → `trials.id`). When the deterministic detector finds a trial-type event, it writes a `subscriptions` row *and* links it to a `trials` row (either an existing one the user already created, or — later phase — one the user accepted from a suggestion). `trials` is never read from `subscriptions`, never rewritten by it, and the existing reminder pipeline never has to know `subscriptions` exists. `trials` could, far later (explicitly **not** now), become "a specialized view of a subscription in trial state" — but that is not a Phase 1-4 concern and is not being designed for yet.

---

## 3. Proposed schema changes — new vs. extended, and why

**No 15-20-table proposal here.** Two new tables, one new link column, zero new tables for price history (folded into the event table). That's the entire schema footprint for Phase 2.

### New entities

| Table | Why it must be new (nothing existing represents this) |
|---|---|
| `subscriptions` | No existing table is a normalized, source-agnostic recurring-payment entity. `trials` only has `endDate`/`status ∈ {ACTIVE,CANCELED}` — no `billingInterval`, no price history, no concept of "this came from Gmail vs. was entered manually vs. came from a bank feed later." |
| `subscription_events` | Nothing today models a timestamped history against an entity. `reminders` is forward-scheduling only (rows get created once and consumed once); it has no concept of "this is the 4th observed event for this subscription." |

### Existing entities to extend, not replace

| Table | Extension | Why extend instead of duplicate |
|---|---|---|
| `trials` | Add nullable `subscriptionId` (or the link lives on `subscriptions.linkedTrialId` — one direction is enough, see §9 for which direction is correct) | `trials` already has everything the existing reminder flow needs; it just needs a pointer *out* to the new graph, not new fields describing subscription concepts it doesn't need for its own job. |
| `suggested_trials` | Not extended in Phase 2. Left running exactly as-is for backward compatibility (see §15). A generalized "candidate" concept is a Phase 3/4 design decision, deliberately deferred — see §18. |
| `users` | No schema change required for Phase 1-4. |

**No `subscription_price_history` table.** Per §11 below, price history is modeled as `event_type = 'price_changed'` rows inside `subscription_events`, carrying `previous_price`/`new_price` in that event's own columns. A dedicated history table would be redundant with the event log the architecture already needs — this is exactly the kind of unnecessary-table the criteria warns against.

---

## 4. The Subscription Graph — concrete data model

```
User
 │
 ├── Subscription: Spotify           (subscriptions row)
 │      ├── Event: trial_started     (subscription_events row, event_type='trial_started')
 │      ├── Event: trial_ending
 │      ├── Event: payment_received
 │      └── Event: price_changed     (carries previous_price=9.99, new_price=11.99)
 │
 ├── Subscription: Adobe
 │      ├── Event: subscription_started
 │      ├── Event: payment_received
 │      └── Event: price_changed
 │
 └── Subscription: Netflix
        └── Event: subscription_renewed
```

`subscriptions` is the persistent entity — one row per real-world recurring commitment, mutated in place as new evidence arrives (`current price`, `status`, `next_renewal_date` all live here and get **updated**, not re-inserted). `subscription_events` is the append-only evidence log — every Gmail message that contributed evidence becomes one event row, immutable once written, always attributable back to a `message_id`. The subscription's current state is a *derived summary* of its event history; the events are the source of truth for "why do we believe this," the subscription row is the source of truth for "what do we currently believe."

Concretely, minimum viable columns:

```
subscriptions
  id, userId, linkedTrialId (nullable FK → trials.id),
  serviceName, normalizedServiceName, merchantDomain,
  category, status, subscriptionType, billingInterval,
  price, currency, monthlyEquivalent, annualEquivalent,
  trialStartDate, trialEndDate, nextRenewalDate, subscriptionStartDate, cancellationDate,
  cancellationUrl, source, confidence, lastDetectedAt, createdAt, updatedAt

subscription_events
  id, subscriptionId (FK), userId, eventType,
  sourceMessageId, extractedPrice, extractedCurrency, extractedDate,
  previousPrice, newPrice,          -- only populated for price_changed events
  confidence, detectionSource ('deterministic' | 'ai'), aiModel (nullable),
  rawSnippetHash (nullable — see §5, never the snippet itself),
  createdAt
```

---

## 5. Raw email storage — explicitly avoided, and here's proof of the current baseline

Traced precisely: today, `scanGmailForTrials()` calls `gmail.users.messages.get({ format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })` (`gmail.ts:404-409`). This fetches **headers plus Gmail's own short `snippet` field** — it does **not** fetch `format: "full"` or the message body at any point in the current codebase. This is a genuine existing privacy advantage and this report does not touch it.

Proposed pipeline preserves that shape exactly:

```
Gmail (metadata + snippet only, as today)
 ↓
Extract        (existing regex/keyword functions, extended per §5 of VISION.md)
 ↓
Normalize      (new: entity resolution, §10 below)
 ↓
Subscription Event (structured fields only)
 ↓
Store structured data
```

Not this:

```
Gmail → store email → AI analyzes entire mailbox   ❌ rejected
```

Nothing in `subscription_events` stores the snippet or body text verbatim — extracted *fields* only (price, date, service name, event type). If a future optional second-stage fetch is ever built (VISION.md §6 mentions this as a possibility, gated behind "only for candidate subscription emails, optionally"), that is out of scope for Phase 1-4 and would need its own dedicated privacy review before being built, not a default.

---

## 6. AI is not the center of this architecture

The current codebase has **zero** AI/LLM dependencies anywhere (verified by project-wide grep for `openai|anthropic|gemini|gpt-4|claude-|chat.completions` earlier in this engagement — the only hits were the unrelated string `"ChatGPT Plus"` in the trackable-services list). That's the honest starting point, and this report does not propose making AI foundational.

Proposed architecture matches the criteria's own diagram exactly:

```
                    ┌─ high confidence → accept
Gmail
 ↓
Deterministic
parser (existing gmail.ts pipeline, extended)
 ↓
Confidence ────────┤
                    └─ ambiguous → AI → validate (Zod) → accept/reject
```

AI is Phase 11-12 (of 15), strictly **after** the deterministic subscription graph already works end-to-end without it. Concretely:
- AI is never called per-email during the main scan loop by default.
- AI is only invoked for messages the deterministic scorer marks ambiguous (a confidence band, not "everything under 70").
- AI must return Zod-validated structured JSON — never free text written directly to a DB column (VISION.md §18 already specifies this and this report agrees with it as a hard requirement, not a suggestion).
- If no AI provider is configured, the product must be 100% functional on deterministic detection alone — this is already true today (there's nothing to "fall back" from), and Phase 2-10 do not create a dependency on AI existing.

---

## 7. Current Gmail scan limitation — acknowledged, not immediately "solved" by brute force

Traced exactly: `phaseAQuery`/`phaseBQuery` (`gmail.ts:363-375`) both scoped `newer_than:90d`; `listMessages()` (`gmail.ts:322-345`) paginates up to `maxTotal=500` per phase (`gmail.ts:378-379`); cron batch is `proUsers.slice(0, 10)` with **no `ORDER BY` in the underlying query** (`storage.ts:339-347` — `getProUsersWithScanningEnabled()` has no ordering clause at all).

This last point is a **new finding**, not called out in the previous audit pass: because the query has no `ORDER BY` and there's no scan-cursor/rotation mechanism, if there are ever more than 10 Pro users with scanning enabled, **the same first ~10 users (by whatever stable order Postgres happens to return) get scanned every single hour, and any Pro user beyond that set may never get scanned at all.** This isn't a hypothetical scaling concern for "someday" — it's a correctness bug that exists in production *today*, independent of anything in this vision.

This report does **not** propose immediately scanning more messages or more users per run. Per the criteria's own preferred direction, the correct fix is incremental scanning, not brute force:

```
Initial scan (unchanged): 90-day historical scan, as today.

Subsequent scans:
lastScanTime (users.lastEmailScanAt — already exists! schema.ts:27)
      ↓
Gmail query: after:{lastScanTime}
      ↓
process only new messages
```

`users.lastEmailScanAt` already exists in the schema and is already being written by `storage.updateLastEmailScan()` — it's just not being *read* anywhere to scope the query. That makes "switch to incremental scanning" a much smaller change than it sounds: no new column needed for the basic version, just a change to how `phaseAQuery`/`phaseBQuery` are constructed for returning users. The rotation-fairness bug above does need a small new column (a `lastScanAttemptAt` or similar cursor used only for `ORDER BY` in `getProUsersWithScanningEnabled`) — cheap, additive, low risk.

---

## 8. Cron architecture — idempotency, failure modes, concurrency

Traced both cron endpoints in full.

**Authentication**: both `/api/cron/reminders` and `/api/cron/email-scan` check `req.headers["x-cron-key"] === process.env.CRON_KEY` (`routes.ts:965`/`980`) before doing anything. Simple shared-secret header check, not scoped per-service, not rotated — acceptable for the current scale, worth noting as a hardening item for Phase 15, not a blocker now.

**How jobs are triggered**: two standalone Railway services (`lucky-enjoyment` for reminders, `noble-vibrancy` for email-scan — configured earlier in this engagement via `railway.cron-reminders.json`/`railway.cron-email-scan.json`), each a one-shot `node -e "fetch(...)"` process running on Railway's native `cronSchedule`. Each service is configured `numReplicas: 1` and `restartPolicyType: "NEVER"` — confirmed directly from the live Railway deployment manifest. Railway's own platform guarantee (confirmed via their docs during that earlier setup) is that a new tick is skipped entirely if the previous execution of *that same cron service* hasn't finished — so same-service double-firing is mitigated at the platform level, not the application level.

**Is reminder processing idempotent?** **Yes, verifiably** — this was proven empirically earlier in this engagement, not just reasoned about: `storage.claimAndSendReminder()` (`storage.ts:163-169`) does a single atomic `UPDATE reminders SET status='SENT' ... WHERE id=$1 AND status='PENDING'` and checks `rowCount > 0` before sending the email. A concurrent or repeated call against the same reminder can only ever win the claim once — the second caller's `UPDATE` matches zero rows and does nothing. We ran this exact scenario live (create a real trial → make one reminder due → run the debug endpoint twice) and confirmed the second run processed 0 reminders with `sentAt`/`providerMessageId` unchanged from the first run.

**Is email-scan processing idempotent? No — confirmed broken.** `POST /api/cron/email-scan`'s inner loop (`routes.ts:990-1006`) has no claim/lock step of any kind, and `storage.upsertSuggestedTrial()` (`storage.ts:362-380`) calls `.onConflictDoNothing()` with no explicit target — meaning it relies on a unique constraint existing on `suggested_trials.message_id`. **I checked this directly against the production database** (`information_schema.table_constraints` and `pg_indexes` for `suggested_trials`): the table has **only a primary-key constraint on `id`. No unique constraint or index exists on `message_id`.** This means `.onConflictDoNothing()` currently has nothing to conflict on and is a no-op guard — every re-scan of a message already suggested (which will happen repeatedly across the 90-day window until a user reviews it) inserts a fresh duplicate row. This is a real, currently-live bug, not a theoretical risk for the new system to inherit — it needs fixing as a prerequisite for Phase 2/4, not as a nice-to-have.

**What happens if the email-scan job fails halfway through?** Each user in the batch is individually wrapped in `try/catch` (`routes.ts:992-1005`) — one user's failure is recorded in `results` and does not stop the loop. If the whole process is killed mid-request (container OOM, deploy restart), users not yet reached simply aren't scanned that hour and get picked up next run — no partial-write corruption, because per-user writes (`upsertSuggestedTrial` + `updateLastEmailScan`) complete fully before moving to the next user. The real gap is the duplicate-row issue above, not partial-failure handling.

**Duplicate processing possible?** Yes, for email-scan (see above) — not for reminders (proven safe).

**Multiple Railway instances executing the same job?** No — both cron services are configured `numReplicas: 1`, and Railway's own scheduler skips overlapping ticks per-service.

**Design requirement for the new subscription event system**: writes into `subscription_events` must either (a) use a real unique constraint on `(subscriptionId, sourceMessageId, eventType)` with a proper `onConflictDoNothing({ target: [...] })`, or (b) use the same atomic-claim pattern proven for reminders. Given §10 below (entity resolution isn't just "one message = one event, done"), a unique constraint on `(userId, sourceMessageId)` at minimum is the non-negotiable baseline — copying today's `suggested_trials` pattern uncorrected would just propagate the same bug into the new table.

---

## 9. Reminder logic — single source of truth, decided explicitly

Today: `computeReminders()` (`routes.ts:92-108`) is the **only** place `reminders` rows are created, and it only runs once, at trial-creation time (`POST /api/trials`, `routes.ts:498` and the trial-accept-from-suggestion path `routes.ts:553`), driven by `trials.endDate`. Nothing else writes to `reminders`.

The direction this report commits to, matching the criteria's own preferred shape:

```
Subscription
     ↓
Renewal date (subscriptions.nextRenewalDate)
     ↓
Reminder engine (existing `reminders` table + computeReminders-equivalent logic)
```

Concretely: `subscriptions.linkedTrialId` is the pointer, and the **rule is: if a subscription has a `linkedTrialId`, the existing `trials`/`reminders` pipeline is the sole owner of reminder scheduling for it — the subscription layer must never independently create a competing reminder for the same underlying date.** Only subscriptions **without** a linked trial (e.g., a detected recurring Netflix subscription that was never a "trial" in RecallTrial's sense) are eligible for new subscription-native alerts (VISION.md §22), and those must be a distinct notification type so they're visually/structurally distinguishable from trial reminders even if they ever did collide on the same day. This prevents exactly the "Canva reminder from trials + Canva renewal reminder from subscriptions, same day" scenario the criteria warns about — by construction, not by hoping the two systems stay in sync.

---

## 10. Entity resolution — merchant vs. payment processor, in detail

Current state: `resolveServiceName()` (`gmail.ts:119-144`) already has the *beginning* of this distinction — it checks `isPaymentProcessor(domain)` (`gmail.ts:112-115`, backed by `PAYMENT_PROCESSOR_DOMAINS` in `gmailKeywords.ts:79-83`: `stripe.com`, `paypal.com`, `apple.com`, `google.com`, `gumroad.com`, `paddle.com`, `fastspring.com`, `lemonsqueezy.com`, `chargebee.com`, `recurly.com`, `braintree.com`, `2checkout.com`, `klarna.com`) and if so, tries to regex the *actual merchant name* out of the snippet text (`"you subscribed to X"`, `"your X subscription"`, etc. — `gmail.ts:122-126`) rather than naively using the processor's domain as the service name. If none of those patterns match, it silently falls through to title-casing the *processor's own* root domain (`gmail.ts:140-143`) — which would incorrectly produce `"Stripe"` as the service name for a Stripe-routed receipt with unparseable snippet text. **This fallback is the actual gap**, not the overall architecture, which already has the right idea.

The distinction the criteria asks for, mapped onto real fields:

```
Merchant           →  subscriptions.serviceName / normalizedServiceName   (e.g. "Spotify")
Payment processor  →  subscription_events.detectedVia / a paymentProcessor field on the event (e.g. "Stripe")
Subscription       →  the subscriptions row itself                        (e.g. "Spotify Premium")
```

Proposed resolution order (this is the "reusable service resolution abstraction" VISION.md §7 asks for):

1. **Known provider mapping** — a small static table/map of well-known domains → canonical merchant name (extends, doesn't replace, the existing `PAYMENT_PROCESSOR_DOMAINS` idea — but for *merchants*, not processors).
2. **Sender domain** (non-processor) — root domain via existing `getRootDomain()` (`gmail.ts:64-74`), already handles `.co.uk`-style eTLD+1 correctly.
3. **Payment-processor snippet extraction** — the existing `resolveServiceName()` regexes, kept and extended, but the "fallback to processor's own domain name" path is removed and replaced with `null`/low-confidence rather than a wrong answer (matches VISION.md's "do not invent" principle applied to service names, not just cancellation URLs).
4. **Deterministic aliases** — a small `merchant_aliases` lookup (e.g. `billing.spotify.com` → `spotify.com` → `Spotify`) so multiple sender subdomains for the same real merchant collapse to one `normalizedServiceName`, which is what actually drives dedup in §11/§8 of the original VISION.md audit (the `_rootDomain` key already used in today's dedup, `gmail.ts:502`, is the right foundation — it just needs the alias layer in front of it).
5. **AI enrichment** — explicitly last-resort only, per §6 above, for domains that hit none of the above with sufficient confidence.

This is the single most underspecified area of VISION.md itself and deserves its own design pass at the start of Phase 4, not just an extension of `resolveServiceName()` — the criteria is right to flag it as harder than it looks.

---

## 11. Price-history design

No `subscriptions.price` overwrite-in-place with data loss. Confirmed design (already stated in §3/§4 above, restated here directly against this criterion): current price lives on `subscriptions.price` (mutable, always "the latest known price"), and **every** observed price is additionally recorded as a `subscription_events` row with `eventType='price_changed'` (or the *first* observed price as `eventType='subscription_started'`/`'trial_started'` carrying its own price) with `previousPrice`/`newPrice` columns on that event.

```
Subscription: Adobe
    │
    ├── current price: $23.99         (subscriptions.price, updated in place)
    │
    └── price history (derived from subscription_events, never deleted)
          ├── event: subscription_started, price=$19.99 — Jan 2026
          └── event: price_changed, previousPrice=$19.99, newPrice=$23.99 — Aug 2026
```

Detecting the transition: when a new event is resolved to an *existing* subscription (via §10's entity resolution) and its extracted price differs from `subscriptions.price` at write time, emit a `price_changed` event with both values, then update `subscriptions.price`. The percentage/absolute-increase math ("Adobe increased 20%, that's $48/year more") is then a pure read-time calculation over two adjacent event rows — no separate computed-and-stored delta needed, which keeps the schema smaller (consistent with §3's "don't over-model on day one").

---

## 12. "Unused subscription" detection — guardrails, not claims

Agreed and already baked into the phrasing plan from the earlier VISION.md-only audit, restated here explicitly against this criterion: the system will **never** claim "you don't use Netflix." Absence of subscription-related email is evidence of absence of *email activity*, not evidence of absence of *usage* — those are different things and the copy must never conflate them.

Approved phrasing pattern: **"No recent subscription-related activity detected"** / **"Worth reviewing."** Rejected phrasing pattern: **"You haven't used X in 30 days"** / **"You don't need this."** This constraint should be enforced structurally, not just as a copywriting guideline — e.g. the recommendation-engine function should be named/typed around "reviewWorthy: boolean + reasons: string[]" rather than anything with "unused" in a field name, so the underlying data model itself can't be misread later as a usage signal by a future developer who didn't read this document.

---

## 13. Confidence scores — event-specific, not one global number

Current state: `scoreConfidenceDetailed()` (`gmail.ts:288-318`) produces **one** score per message, tuned specifically around trial/renewal lifecycle phrases (`hasStrongPositive`, `hasRequiredTrigger`, renewal/billing phrase bonus, date-quality bonus, price-detected bonus, billing-sender bonus, receipt-without-recurring-indicator penalty). That scoring shape is reasonable for "is this a trial-lifecycle email at all," but as VISION.md §4 introduces more event types (`payment_received`, `cancellation_confirmed`, `price_changed`, etc.), a single 0-95 number stops being self-explanatory — an 82 for a trial-ending email and an 82 for a price-change email currently mean structurally different things even though they're the same shape of number.

Proposed: keep `scoreConfidenceDetailed()`'s overall approach (additive point system is easy to reason about and debug — don't throw it away), but store confidence **per dimension**, not just one blended total:

```
subscription_events.confidence         -- overall (kept, for simple UI display / threshold gating)
subscription_events.eventTypeConfidence -- how sure we are this IS a trial_started/price_changed/etc, not something else
subscription_events.dateConfidence     -- explicit/relative/duration/none, already exists conceptually as EndDateSource today (gmail.ts:148)
subscription_events.merchantConfidence -- how sure §10's resolution is correct
```

This is additive to the existing scoring function's internals (its component checks map fairly directly onto these dimensions already — `hasDate`/`endDateSource` already *is* date confidence, it's just currently folded into one number instead of surfaced separately), not a rewrite of the scoring logic.

---

## 14. Internationalization — architectural prep now, implementation later

Flagged, not blocking, and explicitly **not** turned into a Phase 1-9 project. Current state: `gmailKeywords.ts` is entirely English `.includes()` string matching, and `extractDate()`'s explicit-date regexes (`gmail.ts:157-168`) are US-format-leaning (`MM/DD/YYYY` assumed for slash-dates).

**Architectural preparation now** (cheap, worth doing as part of Phase 3 while extraction is already being touched): restructure `STRONG_POSITIVES`/`SOFT_NEGATIVES`/etc. from flat arrays into a `{ locale: string[] }` shape even if only `en` is populated — this is a data-shape change, not a translation project, and it means adding French/Arabic later is additive (`fr: [...]`, `ar: [...]`) rather than a rewrite of every call site that currently does `KEYWORDS.some(k => text.includes(k))`.

**Not now**: actually translating the keyword lists, building locale-aware date disambiguation (the `05/06/2026` MM/DD-vs-DD/MM problem the vision itself calls out), or any Arabic RTL/script-specific handling. Those are correctly scoped as VISION.md's own Phase 13, not folded into Phase 2-4.

---

## 15. Backwards compatibility — explicit answers

| Question | Answer |
|---|---|
| Existing user with 50 trials? | Untouched. `trials`/`reminders` schema and query paths are not modified by Phase 2-4. Their 50 trials keep reminding exactly as today. |
| Existing Pro user? | Untouched. `requirePro`/`requireEmailScanning` gates are unchanged; new subscription endpoints get the same gates applied fresh, not a modification of existing gate logic. |
| Existing Gmail connection? | No reconnect needed. OAuth scope (`gmail.readonly`) is unchanged — the new pipeline reads the exact same metadata+snippet data through the exact same `scanGmailForTrials()` entry point, just with expanded extraction inside it. |
| Existing suggested trial? | Remains valid and untouched. `suggested_trials` is not modified or migrated in Phase 2-4 (explicitly deferred per §3/§18). A user's pending suggestions keep working through the existing accept/ignore routes. |
| Existing reminder? | Still fires. `computeReminders()`/`processRemindersNow()`/`claimAndSendReminder()` are not touched by this plan — see §9's hard rule. |
| Existing subscription that was manually created? | N/A today (no manual-entry feature exists yet — VISION.md §34 defers bank integration and doesn't mandate manual entry in Phase 1-4 either), but the schema design accommodates it: `subscriptions.source` (`'gmail' | 'manual' | ...`) already distinguishes provenance, so a future manual-entry feature and Gmail-detected subscriptions coexist by construction, not by special-casing later. |
| User disconnects Gmail? | Today, `POST /api/gmail/disconnect` (`routes.ts:306-319`) revokes the token and clears `gmailAccessToken`/`gmailRefreshToken` — it does **not** delete existing `suggested_trials` rows (confirmed by reading the handler; it only calls `storage.clearUserGmailTokens`). The same policy should extend to `subscriptions`/`subscription_events`: disconnecting Gmail stops future scanning (cron and manual scan both already require `user.gmailConnected`/`gmailAccessToken`, so this is automatic) but does **not** retroactively delete already-detected subscription data — consistent with existing behavior and with VISION.md §28's own "do not automatically delete subscription history unless that matches current product policy." |

---

## 16. Migration risk classification

Per-change classification, using the exact 4-tier scale from `AUDIT_CRITERIA.md`:

| Change | Risk | Why |
|---|---|---|
| Add `subscriptions` table (new, nullable/defaulted columns throughout, no FK from existing tables pointing *into* it yet) | 🟢 Low | Pure addition. Nothing existing references it, so nothing existing can break if it's wrong. |
| Add `subscription_events` table | 🟢 Low | Same reasoning — pure addition, append-only by design. |
| Add nullable `trials.subscriptionId` (or `subscriptions.linkedTrialId`) | 🟢 Low | Nullable FK addition. Existing `trials` queries that don't select this column are entirely unaffected. |
| Add unique constraint on `suggested_trials.message_id` (fixing the confirmed dedup bug from §8) | 🟡 Medium | Low risk *going forward*, but backfilling/deduplicating **existing** duplicate rows first (if any already exist in production from the already-confirmed-broken `.onConflictDoNothing()`) is required before the constraint can be added, or the `ALTER TABLE` will fail outright on the first duplicate it finds. Needs a one-time cleanup query, run and reviewed carefully, before the constraint migration. |
| Backfilling existing `trials` into `subscriptions` rows (so old trials show up in the new dashboard too) | 🟡 Medium | Matches the criteria's own example exactly. Read-only source data (safe), but a bulk historical write with real judgment calls (what `status`/`confidence`/`source` do backfilled rows get?) — needs a reviewable script, dry-run count first, not a blind bulk INSERT. |
| Any change to `computeReminders()`, `processRemindersNow()`, `claimAndSendReminder()`, or the `reminders`/`trials` write paths | 🔴 High | Per §9, this plan requires **zero** changes to this logic through Phase 4. If a future phase proposes touching it (e.g. unifying reminder generation), that's exactly the "High risk" category this criterion wants called out explicitly, and it should get its own dedicated review, not ride along with an unrelated PR. |
| Any change to Gmail OAuth flow, token storage/encryption, or session/auth handling | 🔴 Very High | Not proposed anywhere in this plan. Flagging explicitly per the criteria's instruction, even though nothing here touches it — `getOAuthClient()`, `exchangeCodeForTokens()`, `revokeToken()`, and the session middleware (`routes.ts:118-134`) are all out of scope for Phases 2-4. |
| Fixing `getProUsersWithScanningEnabled()`'s missing rotation/`ORDER BY` (§7) | 🟢 Low | Query-shape change only, no schema change required for the basic fix (just add an `ORDER BY users.lastEmailScanAt ASC NULLS FIRST` or similar) — but flagging that it changes *which* users get scanned in a given hour, so it's a behavior change worth its own small deploy+observe cycle rather than bundling into a larger PR, per §17. |

---

## 17. No "big bang" — explicit incremental sequencing

This report does **not** recommend implementing VISION.md's 15 phases together, and does not recommend Phase 2-4 as one PR either. Matching the criteria's preferred loop:

```
Audit (this document) → review/approve → implement smallest slice → test → deploy → observe → next slice
```

Concretely, Phase 2 alone should ship as multiple small, independently-deployable increments, not one PR:

1. **Schema only** — `subscriptions` + `subscription_events` tables created, empty, nothing writes to them yet. Deploy. Confirm the app still boots and existing functionality is unaffected (this is the cheapest possible checkpoint).
2. **Fix the confirmed `suggested_trials` dedup bug** (§8/§16) — independent of the new tables, valuable on its own, low-risk once the backfill/cleanup is reviewed. Deploy separately.
3. **Fix the cron rotation bug** (§7/§16) — independent, low-risk, valuable on its own. Deploy separately.
4. **Wire the *smallest* detection path into the new tables** — see §18 immediately below. Deploy, observe real detection output for a few days before building anything that reads from it.
5. Only after step 4 is observed working in production: dashboard (Phase 5), upcoming renewals (Phase 6), etc., each their own deploy.

---

## 18. The smallest possible first implementation step

**The question that matters most, answered directly**: what is the smallest change that adds subscription detection without touching the existing trial-reminder system at all?

Concretely:

1. Add the two new tables (`subscriptions`, `subscription_events`) — pure addition, 🟢 Low risk, per §16.
2. In `scanGmailForTrials()` (`gmail.ts:349`), **do not change its existing return shape or its two callers' behavior at all.** Instead, add a second, parallel, best-effort classification pass over the *same already-fetched* `subject`/`snippet`/`from` data already sitting in memory in the existing loop (`gmail.ts:402-497`) — reusing the existing keyword/regex helpers (`hasStrongPositive`, `extractDate`, `extractAmount`, `resolveServiceName`, etc. — all already pure functions, already reusable). This pass produces a `subscriptionEventCandidate` object alongside (not instead of) whatever the existing trial-suggestion logic already decides.
3. Write that candidate into `subscription_events` (new table) via a **new, separate write call, in the same request, but not gating or being gated by the existing `suggested_trials` write.** If the new write throws, it must not roll back or block the existing trial-suggestion write — wrap it in its own try/catch, exactly like the existing per-user try/catch pattern already used in the cron handler (`routes.ts:992-1005`).
4. **Nothing reads from `subscription_events` yet.** No dashboard, no API route, no UI. This step is pure data collection — it lets the team observe real detection quality/volume against real production Gmail data for days before a single line of UI or reminder-integration code is written, which is exactly the kind of "test in production safely" step the criteria's own deploy-and-observe loop calls for.

```
Existing Gmail scanner (unchanged entry point, unchanged callers)
       │
       ├── existing trial detection → existing suggested_trials write → existing accept/reminder flow  (100% untouched)
       │
       └── new subscription-event detection → new subscription_events write → (nothing reads this yet)
```

This is the parallel-path shape the criteria explicitly asks for, and it is genuinely the smallest step that produces real signal: no new API surface, no new frontend, no touching `trials`/`reminders`/`computeReminders` at all, and if the new pass has bugs, the blast radius is "some rows in a brand-new, unread table are wrong" — not "existing trial reminders break."

---

## 19. Summary against the reviewer's checklist

| Area | Addressed in |
|---|---|
| Current architecture — did it trace the code? | §1, with file:line citations throughout the rest of the document |
| Database — minimal and logical? | §3 (2 new tables, 1 new column, no price-history table) |
| Gmail — extend without breaking current scanning? | §5, §18 (parallel pass, existing entry point/callers untouched) |
| Trials — existing functionality protected? | §2, §9, §15 (explicit, zero changes through Phase 4) |
| Reminders — one source of truth for dates? | §9 (explicit ownership rule via `linkedTrialId`) |
| Cron — idempotent/scalable? | §7 (rotation bug found), §8 (reminders proven idempotent; email-scan proven **not** idempotent, root cause identified) |
| Subscription Graph — coherent data model? | §4 |
| AI — optional, not foundational? | §6 |
| Privacy — raw emails avoided? | §5 |
| Entity resolution — merchant vs. processor? | §10 |
| Price history — preserved, not overwritten? | §11 |
| Migration — deployable safely? | §16 (4-tier classification), §17 (incremental sequencing) |
| Testing | Not yet designed — VISION.md §36's test list is extensive and this repo currently has **no test suite at all** (no `test` script in `package.json`, confirmed in the earlier architecture audit). Standing up test infrastructure is real, non-trivial work and belongs explicitly inside whichever phase first ships production behavior change (step 2 of §18's sequencing at the latest) — flagging this gap now rather than assuming it'll happen. |
| Complexity — realistic phase estimates | Table below |

---

## Complexity estimate per VISION.md phase (1-10)

| Phase | Estimate | Note |
|---|---|---|
| 2 — Subscription/event data model | 5 | Schema itself is simple (§3); most of the complexity is the migration-mechanism gap identified separately (no versioned migration system exists today — `server/migrate.ts` is hand-rolled idempotent raw SQL run on every boot, no rollback, no history table) and fixing the two confirmed cron/dedup bugs as prerequisites (§8, §16). |
| 3 — Expand deterministic Gmail extraction | 7 | New fields (billing interval, cancellation URL from available data, price-change fields) are individually easy regex work, but doing it as a genuinely parallel, non-breaking pass (§18) while reusing rather than duplicating the existing helper functions takes real care. |
| 4 — Entity resolution + deduplication | 8 | Hardest deterministic-logic phase — §10's merchant-vs-processor distinction plus the alias layer is real, underspecified design work, not a mechanical extension of `resolveServiceName()`. |
| 5 — Subscription dashboard | 4 | New page, existing component/query patterns to follow, low architectural risk once Phase 2-4 data exists. |
| 6 — Upcoming renewals | 3 | Filtered query + list view over data Phase 2-4 already produces. |
| 7 — Monthly/annual cost calculation | 3 | Pure arithmetic; currency-mixing avoided by design (VISION.md explicitly forbids inventing FX conversion). |
| 8 — Price-change detection | 5 | Comparison-at-write-time logic (§11) — needs care around formatting/rounding noise producing false positives, but no new architecture beyond what §11 already specifies. |
| 9 — Potential savings/review recommendations | 4 | Rule-based scoring over existing fields; most of the difficulty is copywriting discipline (§12), not engineering. |
| 10 — Monthly subscription report | 3 | Aggregation + existing `server/email.ts` HTML-template convention, already a proven pattern in this codebase. |
| 11 — AI analyst | 6 | New `SubscriptionIntelligenceProvider` abstraction (VISION.md §19) built from zero, strict Zod-validated Q&A over already-stored structured data only — real but bounded new infrastructure. |
| 12 — Optional AI fallback for ambiguous emails | 7 | Same provider abstraction, but now in the hot detection path with real cost/latency/failure-mode requirements (caching, AI-unavailable handling, malformed-JSON handling) — meaningfully harder than 11 despite code reuse. |
| 13 — Internationalization | 8 | VISION.md explicitly forbids "just translate the regex list" — real locale-aware date disambiguation (the `05/06/2026` ambiguity) is a genuinely hard, easy-to-silently-break problem. §14 above scopes what's prep-now vs. build-later. |
| 14 — Scan scalability/incremental scanning | 6 | Lower than previously estimated once §7's finding is accounted for: `users.lastEmailScanAt` already exists and is already written — the *basic* incremental-query change is cheap. The harder remaining pieces (resumable pagination, rate-limit/retry/backoff, optional job queue) are genuine new infrastructure, hence still a meaningful 6, not higher. |
| 15 — Comprehensive testing and production hardening | 7 | Raised from the earlier estimate: this repo has no test suite at all today, and VISION.md §36's list is extensive (detection, dates, money, entity resolution, AI-fallback edge cases) — this phase is "build a test suite from zero" plus "write all these cases," not just "write some tests." |

**No phase in this table assumes any other phase's code has been written yet** — each is independently deployable and observable, per §17.
