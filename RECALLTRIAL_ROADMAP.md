Save the following content as a new file in the project root:
RECALLTRIAL_ROADMAP.md

Create the file with exactly this content:

RECALLTRIAL
│
├── CORE MISSION
│   └── Help users understand, control, and reduce recurring
│       subscription spending.
│
├── PRODUCT EVOLUTION
│   │
│   ├── Stage 1 — Trial Protection
│   │   └── "Never get charged for a free trial again."
│   │
│   ├── Stage 2 — Subscription Intelligence
│   │   └── "Know what subscriptions you have."
│   │
│   ├── Stage 3 — Savings Intelligence
│   │   └── "Know what you're wasting."
│   │
│   ├── Stage 4 — Subscription Action
│   │   └── "Help me reduce/cancel unnecessary subscriptions."
│   │
│   └── Stage 5 — Subscription Infrastructure
│       └── "Monitor recurring spending everywhere."
│
│
├── PHASE 1 — TRIAL PROTECTION
│   │
│   ├── Gmail connection
│   ├── Trial email detection
│   ├── Trial start detection
│   ├── Trial end/renewal date
│   ├── Expected charge
│   ├── Trial reminders
│   │   ├── 3 days
│   │   ├── 2 days
│   │   └── 1 day
│   └── Email notifications
│
│   STATUS: ✅ COMPLETE
│
│
├── PHASE 2 — SUBSCRIPTION INTELLIGENCE FOUNDATION
│   │
│   ├── Gmail subscription scanning
│   ├── Subscription keyword discovery
│   ├── Merchant classification
│   ├── Event taxonomy
│   ├── Canonical events
│   ├── Historical classification reconciliation
│   ├── Noise filtering
│   │   └── Facebook billing noise
│   └── Merchant/entity resolution
│
│   STATUS: ✅ COMPLETE
│
│
├── PHASE 3B — SUBSCRIPTION INTELLIGENCE
│   │
│   ├── 3B.1 — Foundation
│   │
│   ├── 3B.2 — Merchant Resolution
│   │
│   ├── 3B.3 — Classification Precision
│   │   └── 3B.3.1 — Precision patch
│   │
│   ├── 3B.4 — Entity Resolution
│   │   └── Shadow mode
│   │
│   ├── 3B.5 — Shadow Subscriptions
│   │
│   ├── 3B.6 — GO / NO-GO Validation
│   │
│   ├── 3B.7 — Production Readiness
│   │   │
│   │   ├── 3B.7.1 — Gmail Audit
│   │   ├── 3B.7.2 — Pagination + Incremental Scanning
│   │   ├── 3B.7.3 — Subscription Dashboard
│   │   └── 3B.7.4 — Controlled Production Activation
│   │
│   │   STATUS: ✅ COMPLETE
│   │
│   └── 3B.8 — Subscription Lifecycle
│       │
│       ├── Lifecycle states
│       │   ├── trial
│       │   ├── active
│       │   ├── past_due
│       │   ├── cancelled
│       │   ├── expired
│       │   └── unknown
│       │
│       ├── Event → lifecycle transitions
│       ├── Existing subscription updates
│       ├── Idempotent lifecycle processing
│       ├── Subscription reminder generation
│       ├── Production subscription dashboard
│       └── Reminder integration foundation
│
│       STATUS: ✅ COMPLETE
│
│
├── PHASE 3B.9 — SUBSCRIPTION INTELLIGENCE V1
│   │
│   ├── 3B.9.1 — Cost Engine                          ✅ COMPLETE
│   │   ├── Monthly cost
│   │   ├── Annual cost
│   │   ├── Monthly equivalent
│   │   └── Annual equivalent
│   │
│   ├── 3B.9.2 — Billing + Upcoming Charges           ✅ COMPLETE
│   │   ├── Next 7 days
│   │   ├── Next 30 days
│   │   └── Upcoming recurring total
│   │
│   ├── 3B.9.3 — Billing Intelligence                 ✅ COMPLETE
│   │   ├── Monthly calendar
│   │   ├── Upcoming renewals
│   │   └── Upcoming charge totals
│   │
│   ├── 3B.9.4 — Renewal Calendar                     ✅ COMPLETE
│   │   ├── Merchant
│   │   ├── Cost
│   │   ├── Billing interval
│   │   ├── Renewal date
│   │   ├── Status
│   │   ├── Start date
│   │   ├── Detected emails
│   │   └── Subscription history
│   │
│   ├── 3B.9.5 — Subscription Vault                   ✅ COMPLETE
│   │   ├── Historical price
│   │   ├── Current price
│   │   ├── Price changes
│   │   └── Annual impact
│   │
│   ├── 3B.9.6 — Price History + subscriptionId FK    ✅ COMPLETE
│   │   ├── Detect increase
│   │   ├── Calculate percentage
│   │   ├── Calculate annual impact
│   │   └── Notify user
│   │
│   ├── 3B.9.7 — Full Gmail Body Extraction           🟡 IN PROGRESS
│   │       ├── Total subscriptions
│   │       ├── Monthly recurring cost
│   │       ├── Annual recurring cost
│   │       ├── Upcoming charges
│   │       └── Subscription health
│   │
│   ├── 3B.9.8 — Price Increase Detection             ⏳ NEXT
│   │
│   ├── 3B.9.9 — AI Enrichment (Claude Haiku)         ⏳ PLANNED
│   │
│   └── 3B.9.10 — AI Credits / Monetization           ⏳ PLANNED
│
│   STATUS: 🟡 IN PROGRESS (6/10 complete)
│
│
├── PHASE 3C — SAVINGS INTELLIGENCE
│   │
│   ├── 3C.1 — Usage / Activity Signals
│   │   ├── Last detected activity
│   │   ├── Activity frequency
│   │   └── Evidence confidence
│   │
│   ├── 3C.2 — Forgotten Subscription Detection
│   │
│   ├── 3C.3 — Unused Subscription Detection
│   │
│   ├── 3C.4 — Subscription Risk Score
│   │   ├── Cost
│   │   ├── Renewal proximity
│   │   ├── Activity
│   │   ├── Price changes
│   │   └── Cancellation urgency
│   │
│   ├── 3C.5 — Savings Recommendations
│   │   ├── Potential savings
│   │   ├── Monthly savings
│   │   └── Annual savings
│   │
│   ├── 3C.6 — "How Much Am I Wasting?"
│   │   ├── Total recurring spending
│   │   ├── Potential waste
│   │   ├── Potential savings
│   │   └── Savings opportunities
│   │
│   └── 3C.7 — AI Subscription Analyst
│       ├── "What subscriptions do I have?"
│       ├── "How much did I spend?"
│       ├── "Which increased in price?"
│       ├── "Which should I cancel?"
│       └── "How much could I save?"
│
│   STATUS: 🔴 NOT STARTED
│
│
├── PHASE 4 — SUBSCRIPTION CLEANUP
│   │
│   ├── 4.1 — Subscription Cleanup
│   │   ├── Essential
│   │   ├── Review
│   │   └── Probably unnecessary
│   │
│   ├── 4.2 — Keep / Review / Cancel
│   │
│   ├── 4.3 — Cancellation Assistant
│   │   ├── Official cancellation URL
│   │   ├── Cancellation instructions
│   │   └── Guided cancellation
│   │
│   ├── 4.4 — Cancellation Tracking
│   │   ├── Cancellation initiated
│   │   ├── Cancellation confirmed
│   │   └── Subscription removed
│   │
│   └── 4.5 — Savings Tracking
│       ├── Money saved
│       ├── Monthly savings
│       └── Annual savings
│
│   STATUS: 🔴 NOT STARTED
│
│
├── PHASE 5 — RETENTION & FINANCIAL INSIGHTS
│   │
│   ├── 5.1 — Monthly Subscription Report
│   │   ├── Active subscriptions
│   │   ├── Monthly cost
│   │   ├── Annualized cost
│   │   ├── New subscriptions
│   │   ├── Cancelled subscriptions
│   │   ├── Price increases
│   │   └── Potential savings
│   │
│   ├── 5.2 — Subscription Trends
│   ├── 5.3 — Monthly Spending History
│   ├── 5.4 — Savings History
│   └── 5.5 — Personalized Financial Insights
│
│   STATUS: 🔴 NOT STARTED
│
│
├── PHASE 6 — BANK / TRANSACTION INTELLIGENCE
│   │
│   ├── Financial-data provider integration
│   ├── Bank transaction ingestion
│   ├── Recurring payment detection
│   ├── Merchant matching
│   ├── Email ↔ transaction reconciliation
│   ├── Hidden subscription detection
│   └── Subscription confidence improvement
│
│   STATUS: 🔴 FUTURE
│
│
├── PHASE 7 — BROWSER / REAL-TIME PROTECTION
│   │
│   ├── Browser extension
│   ├── Trial detection during signup
│   ├── Price detection
│   ├── "Protect this trial"
│   └── Automatic trial tracking
│
│   STATUS: 🔴 FUTURE
│
│
├── PHASE 8 — FAMILY / SHARED SUBSCRIPTIONS
│   │
│   ├── Family accounts
│   ├── Shared subscription detection
│   ├── Family spending
│   ├── Duplicate service detection
│   └── Family savings
│
│   STATUS: 🔴 FUTURE
│
│
└── FINAL VISION
    │
    └── RECALLTRIAL
        │
        ├── Detect
        │   └── "What subscriptions do I have?"
        │
        ├── Understand
        │   └── "What am I paying and when?"
        │
        ├── Protect
        │   └── "What am I about to be charged?"
        │
        ├── Analyze
        │   └── "What am I wasting?"
        │
        ├── Recommend
        │   └── "What should I cancel?"
        │
        ├── Act
        │   └── "Help me cancel it."
        │
        └── Save
            └── "How much money did RecallTrial save me?"

## Architecture Notes

### Three-Layer Scanning Architecture (approved, implementing in 3B.9.7-3B.9.9)
Layer 1: Gmail metadata + snippet (free, all emails, candidate detection)
Layer 2: Full Gmail body format=full (candidates only, deterministic extraction, never stored)
Layer 3: Claude Haiku AI enrichment (ambiguous candidates only, explicit user opt-in)

### AI Credit System (planned for 3B.9.10)
- Free plan: no AI scanning
- Plus ($4.99/mo): 300 AI credits/month included (reset monthly)
- Pro ($7.99/mo): 600 AI credits/month included (reset monthly)
- Top-up packs: $0.15 per 100 emails (pay-as-you-go via Stripe)
- Internal credit ledger (not Stripe-managed)
- Explicit user opt-in required for AI

Do not modify any other files.
Do not commit yet — just create the file so it's available locally.

Project path: C:/Users/Ayoub/Recalltrial.app.-main/Recalltrial.app.-main