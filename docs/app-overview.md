# Relay — Complete Application Overview

_Generated as a feedback-gathering document. Reflects the actual implementation as of 2026-09-22, not aspirational design._

## 1. What Relay is

Relay is a multi-channel AI Customer Agent for commerce merchants (currently WhatsApp-first, with Instagram DM and Email also supported). A merchant connects their WhatsApp Business number (and optionally Instagram/Email) to Relay. From then on:

- Customers message the merchant's number like normal.
- Relay's AI holds the sales conversation autonomously — answers questions from the merchant's real product catalogue, collects items/address/payment method, places real orders, and creates real payment links — with **no human approval step** in the default path.
- A separate, deterministic (non-AI) button-driven shopping flow also exists for customers who prefer tapping through a menu instead of chatting.
- The merchant manages everything (conversations, orders, inventory, promotions, analytics) from a Next.js web dashboard.
- A background worker handles delayed/scheduled work: abandoned-cart nudges, order-status progression (simulated fulfillment), and proactive "opportunity" scans (back-in-stock, repeat-purchase, low-engagement, etc.).

It is **live in production** on Railway, currently operated by a single merchant while awaiting Meta App Review (for broader WhatsApp/Instagram access) and Razorpay Live Mode KYC (for real payment collection at scale).

## 2. Tech stack & repo layout

pnpm + Turborepo monorepo:

```
apps/
  api/     NestJS 11 — the only system of record / API boundary
  web/     Next.js 15.5 — merchant-facing dashboard
  worker/  BullMQ workers — scheduled/delayed jobs, some with their own AI calls
packages/
  database/    Prisma 6.19 schema + migrations, shared by api and worker
  types/       shared TypeScript types
  ui/          shared UI primitives
  config/      shared config
  integrations/  email/instagram/razorpay/shipping/shopify client wrappers
```

Infra: PostgreSQL (system of record), Redis (BullMQ queues), all three apps deployed as separate Railway services (`api`, `web`, `worker`, plus `postgres`/`redis`). CI is GitHub Actions (typecheck → build → test, Docker matrix build). `apps/api` has a real Jest suite (138 tests as of this writing); `apps/web` and `apps/worker` currently have none.

## 3. Data model (PostgreSQL via Prisma)

Core entities and how they relate:

- **Business** — one row per merchant tenant. Holds channel config (WhatsApp/Instagram phone/page IDs, support email), **per-merchant encrypted credentials** (WhatsApp/Instagram/Postmark/Razorpay tokens, AES-256-GCM at rest, falling back to shared `.env` tokens if unset — this is how a single-business demo setup coexists with real multi-tenant credentials), autonomy/threshold settings (`autonomyMaxOrderValue`, `defaultLowStockThreshold`, etc.), and the `proactiveSuggestionsEnabled` master switch.
- **User** — belongs to exactly one Business. `role` is `OWNER | ADMIN | MEMBER` (per-business RBAC). A separate, unrelated `isPlatformAdmin` boolean (default false) grants access to new cross-business `/platform` endpoints — this is NOT a business role, it's a rare, manually-set operator flag for the Relay founder.
- **Customer** ↔ **Identity** — a Customer can have multiple channel Identities (WhatsApp number, Instagram handle, email address) that all resolve to one unified customer record and timeline.
- **Conversation** ↔ **Message** — one Conversation per customer+channel; Messages are INBOUND/OUTBOUND/SYSTEM. `shoppingState` on the Conversation drives the deterministic shopping-flow state machine (see §5). `escalated`/`escalationReason` freezes AI replies once a human needs to take over.
- **Product** ↔ **Variant** ↔ **Category** — catalogue. Variants carry price/currency/inventory/SKU/attributes; Products can be `DRAFT`/`PUBLISHED`.
- **Cart** ↔ **CartItem** — one active cart per conversation; becomes an **Order** at checkout.
- **Order** ↔ **OrderItem** — full lifecycle: `DRAFT → AWAITING_APPROVAL? → PENDING_PAYMENT → PAID → FULFILLED` (or `CANCELLED`/`REFUNDED`), plus a separate `fulfillmentStatus` (`NOT_STARTED → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED`/`FAILED`/`RETURNED`). Orders above `autonomyMaxOrderValue` land in `AWAITING_APPROVAL` instead of proceeding straight to payment.
- **InventoryAlert** / **StockAdjustment** — every stock change is logged (audit trail), and crossing a threshold creates/resolves a `LOW_STOCK`/`OUT_OF_STOCK` alert; a 0→positive transition triggers back-in-stock notifications.
- **Opportunity** ↔ **Suggestion** ↔ **OpportunityOutcome** — the proactive AI suggestions system (see §7).
- **AutomationRule** — per-business, per-opportunity-type config (enabled, auto-send, min confidence, business hours, personalized timing, daily frequency cap).
- **ProductRelation** — merchant-configured CROSS_SELL/UPSELL links between products, drives post-purchase suggestions.
- **CustomerSignal** — lightweight interest signals (`PRODUCT_VIEWED`, `PRODUCT_ENQUIRY`, `BACK_IN_STOCK_WANTED`) that feed opportunity detection.
- **AiActionLog** / **ActivityEvent** — audit trails: every autonomous AI decision (action, reason, result) and every business-visible event (message sent, order placed, etc.).
- **LeadScore** — deterministic (not AI) score from conversation/order counts + recency.
- **RefreshToken** — opaque, rotated-on-use tokens for session persistence.
- **Promotion** — merchant-authored broadcast campaigns targeting segments (all customers / category buyers / high-value customers).

## 4. Two parallel customer-facing systems

This is the most important architectural fact about Relay: **there are two completely separate mechanisms for a customer to shop**, and understanding which one is "in control" of a given conversation at any moment matters a lot.

### 4a. Deterministic shopping flow (`ShoppingFlowService`)
A pure state machine, **no LLM involved at all**. Driven by WhatsApp interactive buttons/lists and `Conversation.shoppingState`. States: `IDLE → BROWSING_CATEGORIES → BROWSING_PRODUCTS → VIEWING_PRODUCT → AWAITING_QUANTITY → CART_REVIEW → COLLECTING_ADDRESS → COLLECTING_PAYMENT → ORDER_CONFIRMATION → IDLE`. Handles: menu, category/product browsing (list messages, max 10 rows), variant selection, quantity, cart, checkout (address → payment method buttons → order summary → confirm), and now also two new capabilities:
- **Back-in-stock / cross-sell / upsell product cards**: a suggestion of these types is sent as a photo + tap-to-choose **🛒 Add to Cart** / **Maybe Later** buttons (not plain text). "Add to Cart" reuses the existing `variant_<id>` entry point, so it correctly merges into whatever's already in that conversation's active cart rather than replacing it.
- **Payment method as buttons, not typed text**: checkout now shows exactly 3 buttons — Card / UPI / COD (WhatsApp's hard limit is 3 buttons per message).

### 4b. AI conversational flow (`AiService`)
Free-text conversations go through OpenAI's Responses API with a **strict JSON schema** output (`REPLY_SCHEMA`): every turn, the model returns `{reply, items, shippingAddress, paymentMethod, orderConfirmed, cancelOrder, needsHumanReview, needsHumanReviewReason, showProductImages}`. The system prompt encodes an 11-step order-taking script (greet → collect items → address → payment method → summary → confirmation → status/amend/cancel → escalation → product cards), fed the last 20 messages of transcript, up to 30 catalogue products, and the customer's 3 most recent orders for grounding. Notably:
- Payment method is **not asked for in free text either** — once items+address are known, the AI's reply is intercepted and sent as the same 3 tap-to-choose buttons (Card/UPI/COD) instead of plain text, via a `sendButtons` call with `ai_pay_*` button IDs.
- Because WhatsApp interactive taps are normally routed straight to the deterministic flow (see §4c), there's a special-case bypass so `ai_pay_*` taps fall through to the AI instead.
- The model is instructed never to fabricate links, prices, stock, or policies, and never to repeat product cards/prices in its own text (those are sent as separate structured messages).
- Order creation, cancellation, and amendment (`executeCreateOrder`) go through the same `OrderService` used by the deterministic flow, so both paths produce identical, valid Order records.

### 4c. Webhook routing (the seam between 4a and 4b)
`WhatsAppWebhookService.processMessage()` is the single entry point for every inbound message. Routing order: duplicate-message guard → interactive tap (routes to `ShoppingFlowService.handleInteractive`, **except** `ai_pay_*` IDs, which fall through to the AI) → plain greeting (always reopens the deterministic main menu, regardless of current state, so a customer stuck mid-flow can always escape) → non-IDLE shopping state (routes to `ShoppingFlowService.handleFreeText`, which itself falls through to the AI if the current state doesn't recognize the text) → otherwise, the AI (`AiService.generateAndSendReply`). Instagram and Email currently only ever reach the AI path (no deterministic flow equivalent for those channels yet).

## 5. Payments

- **Razorpay** integration is real (not simulated) for Card/UPI: `RazorpayService.createPaymentLink()` creates an actual Razorpay Standard Payment Link, which itself natively offers Card/UPI/Netbanking/Wallet once opened — so "Card" and "UPI" as customer-facing choices are functionally identical under the hood, both hitting the same link-creation path (`ONLINE_PAYMENT_METHODS` set in `OrderService`). Only **COD** is genuinely different (no payment step; cash collected on delivery, order goes straight to "placed").
- Each business can have its **own** Razorpay key/secret (encrypted) with its own webhook secret — unlike WhatsApp/Instagram, which share one app-level secret across all businesses (`RazorpayWebhookController` resolves per-business via the URL path `/webhooks/razorpay/:businessId`).
- `RazorpayWebhookService` marks orders PAID on real payment confirmation, which kicks off the (simulated) fulfillment pipeline via the worker.
- **Fulfillment is currently simulated**: once PAID, `worker`'s order-progress jobs auto-advance `fulfillmentStatus` through PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED on a timer — there's no real courier/shipping integration wired up yet (packages/integrations/shipping exists but isn't the live path).

## 6. Proactive AI Suggestions (the "Opportunities" system)

Off by default (`proactiveSuggestionsEnabled`). When on, various triggers (inbound signals, and worker-scheduled scans) create an `Opportunity` + AI-drafted `Suggestion` for: abandoned cart, product enquiry, back-in-stock, high purchase intent, repeat purchase, cross-sell, upsell, new-product-match, unanswered conversation, low engagement, high-value customer, promotion. Each opportunity gets a **deterministic** 0–100 score (base-by-type + value/confidence/lead-score bonuses) and priority (LOW/MEDIUM/HIGH) — scoring is intentionally never AI-derived, so it's fully auditable.

Per-business, **per-type** automation rules control: enabled, auto-send (skips merchant review entirely if true), minimum confidence for auto-send, business-hours window, "personalized timing" (send at the customer's own historically-inferred best reply hour instead of a fixed window — only matters when auto-send is also on), and a daily-per-customer frequency cap.

Merchant-facing "Suggestions" inbox: tabs for Active/Sent/Converted/Dismissed, each card editable before sending, with Send/Dismiss/Snooze(4h/1d/3d) actions. `BACK_IN_STOCK`/`CROSS_SELL`/`UPSELL` suggestions are sent as a **product photo + Add to Cart / Maybe Later buttons** (added this session) rather than plain text — Add to Cart routes through the same shopping-flow variant entry point, so it correctly merges into any existing cart.

Attribution: a SENT suggestion followed by a matching order within a 7-day window gets that revenue attributed to it (`ATTRIBUTION_WINDOW_DAYS`) — a simple, explainable heuristic, not causal modelling.

## 7. Merchant web dashboard (`apps/web`)

Pages: **Overview** (revenue/leads/conversations/orders summary + weekly chart + AI opportunities teaser + recent activity), **Leads**, **Inbox** (conversation view, escalation), **Suggestions** (§6), **Products** (catalogue + variants + cross-sell/upsell relation editor + bulk import via CSV with AI-suggested category/description), **Orders**, **Promotions** (broadcast campaigns), **Analytics** (funnel, revenue-by-channel, customer metrics, conversation outcomes, opportunity type/trend analytics), **Settings** (channel connections, encrypted credential entry, autonomy/threshold config, proactive-suggestions master switch + per-type automation rules, team/user management), and (new) **Platform** — a founder-only cross-business view (see §9).

Auth: JWT access token + rotated refresh token, account lockout after repeated failed logins, per-business RBAC (`OWNER`/`ADMIN`/`MEMBER`) enforced via `@Roles()` + `RolesGuard`, every business-scoped route additionally checks `user.businessId === :id` in the controller.

## 8. Background worker (`apps/worker`, BullMQ over Redis)

Queues: `follow-up` (abandoned-cart / general re-engagement drafts), `order-progress` (simulated PAID→fulfillment stage advancement), `order-expiry` (auto-cancels orders still `AWAITING_APPROVAL`/`PENDING_PAYMENT` past their window — guards against acting on a stale expectation if the order's status already moved on), `abandoned-cart`, `repeat-purchase-scan`, `unanswered-conversation-scan`, `customer-health-scan`. Several of these jobs call OpenAI directly (not through the API) to draft the outreach message before creating an Opportunity — same lazy-init/fallback-to-template pattern as the API's AI services. `apps/worker/src/agents/`, `workflows/`, and `activities/` directories exist in the repo but are currently **empty scaffolding** — not wired into anything yet.

## 9. Platform-admin (cross-business) view — newly added

Until this session, **every** dashboard page and API endpoint was strictly single-tenant (`user.businessId === :id` checks everywhere) — there was no way to see totals across merchants. Added:
- `User.isPlatformAdmin` (default false, manually set — no self-serve UI for granting it, deliberately).
- `PlatformAdminGuard` + new `GET /api/platform/overview` (total merchants/orders/revenue/customers) and `GET /api/platform/businesses` (per-merchant order count, revenue, WhatsApp/Instagram connection status).
- A new `/platform` web page + sidebar link, visible only when `me.isPlatformAdmin` is true.
- **Security fix bundled in the same change**: `GET`/`POST /api/businesses` previously had **no** per-business or role check at all (only the global JWT-auth requirement) — any authenticated user from *any* merchant could list every business on the platform, including WhatsApp/Instagram IDs and support emails (not secrets, but still cross-tenant leakage). Now gated behind `isPlatformAdmin` too.

## 10. Security posture (current state, not aspirational)

- Per-merchant credentials encrypted at rest (AES-256-GCM), decrypted only in-memory when a channel send actually needs them.
- WhatsApp/Instagram webhook signatures verified against a shared app secret; Razorpay webhook signatures verified per-business against that business's own secret.
- Rate limiting (`ThrottlerGuard`, global 100 req/min, stricter on auth endpoints), account lockout after repeated failed logins, opaque rotated refresh tokens.
- RBAC via roles + explicit businessId ownership checks on every business-scoped controller method.
- Known-fixed issue (this session): the `GET/POST /businesses` cross-tenant leak above.
- **Known gaps** (not yet addressed): no automated alerting on repeated AI/webhook/payment failures — you only find out via `railway logs` or a customer complaint; no error-tracking service (Sentry etc.) wired in; no external uptime monitor pinging `/api/health`; `apps/web`/`apps/worker` have zero automated test coverage (only `apps/api` does).

## 11. Testing & deployment

- `apps/api`: Jest unit/integration-style tests (138 as of writing) covering pure helpers, auth, orders, Razorpay, the shopping-flow state machine, webhook routing, cart stock validation, opportunities, and the new platform-admin guard/service. Wired into CI before the build step.
- CI: GitHub Actions — typecheck → build → test → Docker matrix build, on every push to `main`.
- Deployment: Railway, one service per app (`api`, `web`, `worker`) plus managed `postgres`/`redis`. `preDeploy` runs `prisma migrate deploy` automatically before each release. Production URLs: `api-production-da33.up.railway.app`, `web-production-fd8c3.up.railway.app`.
- Notably, this session hit a real operational constraint worth flagging to any reviewer: the current network environment blocks all outbound ports except 80/443, which breaks Railway's SSH-based DB console/tunnel (`railway connect`/`ssh`, and the dashboard's own DB browser) — any one-off production DB change currently has to go through the deployed application itself over HTTPS, not a direct DB connection.

## 12. Things not yet built / explicitly deferred

- Real shipping/courier integration (fulfillment progression is simulated on a timer).
- Meta App Review (pending Udyam registration) — currently limits WhatsApp/Instagram reach.
- Razorpay Live Mode KYC — currently likely test/sandbox mode for real money collection at scale.
- No tests for `apps/web` or `apps/worker` (explicit team decision to skip, so far).
- No alerting/error-tracking/uptime-monitoring service.
- `apps/worker/src/agents`, `workflows`, `activities` — empty, unused scaffolding.
- No self-serve way to grant `isPlatformAdmin` (by design, but means every grant is a manual one-off).
- Deterministic shopping-flow equivalent doesn't exist for Instagram/Email — those channels only ever get the AI conversational flow.

## 13. Open questions worth AI/reviewer feedback on

- Is running the AI conversational flow **fully autonomous** (no merchant approval before a reply is sent, order is placed, or a payment link is created) the right trust model at this stage, or should there be a human-in-the-loop gate for orders above a certain value (there is a partial one already: `autonomyMaxOrderValue` routes to `AWAITING_APPROVAL`)?
- Is treating "Card" and "UPI" as literally the same backend path (both just open a Razorpay Payment Link) the right long-term design, or should Card go through a more tailored checkout experience eventually?
- The two-parallel-flow architecture (deterministic buttons vs. free-text AI) is powerful but adds real complexity (see the `ai_pay_*` bypass hack in webhook routing) — is this worth consolidating, or is keeping them separate the right call given WhatsApp's UI constraints?
- What's the right prioritization between: (a) real shipping integration, (b) alerting/observability, (c) broader channel/App-Review reach, (d) deeper proactive-suggestion intelligence (e.g., actual ML-based scoring instead of the current deterministic formula)?
