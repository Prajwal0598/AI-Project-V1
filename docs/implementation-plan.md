# Implementation Plan

Multi-channel AI customer agent — phase-wise roadmap from current state to production.

---

## Current state (as of 2026-08-18)

### Done
- JWT auth — register, login, global guard, `@Public()` bypass
- Products API — list, create, update
- Orders API — list, create, update status
- WhatsApp webhook — inbound ingestion, outbound send via Meta Cloud API
- `PATCH /businesses/:id` — update business settings incl. `whatsappPhoneNumberId`
- Conversation list endpoint — `GET /api/businesses/:id/conversations`
- Frontend auth — login/register page, token management, `getBusinessId()` from JWT
- Inbox wired to real API — conversations, messages, send, AI draft
- Leads wired to real API — real customers with score and activity counts
- Products wired to real API — list and create persist to DB
- Prisma schema migrations applied — `passwordHash`, `whatsappPhoneNumberId`

### Not started
- Settings page save flow, Orders UI, Analytics data, worker, Instagram/Email channels, Shopify/Razorpay, production infra

---

## Phase 2 — UI fully connected

**Goal:** every page shows real data and all write actions persist.

### 2.1 Settings page
- Wire form to `PATCH /api/businesses/:id`
- Fields: business name, timezone, WhatsApp Phone Number ID, WhatsApp Access Token (stored in env, not DB)
- Save confirmation toast

### 2.2 Orders page (`/orders`)
- New route in `apps/web/app/orders/page.tsx`
- `GET /api/businesses/:id/orders` — list with customer name, total, status, date
- Status badge colour per `OrderStatus` enum
- `PATCH /api/orders/:id/status` — dropdown to advance status

### 2.3 Analytics page
- New backend endpoint `GET /api/businesses/:id/stats`
  - Returns: `{ leads, customers, conversations, orders, revenue }` — simple `COUNT` / `SUM` queries
- Wire the 4 metric cards on the analytics page to real numbers

### 2.4 Overview dashboard
- Same `/stats` endpoint feeds the hardcoded metric cards on the home page

### 2.5 Inbox polish
- Message timestamps visible in thread
- Auto-scroll to bottom on new message
- Reload conversation list after a message is sent
- Channel badge (WhatsApp / Email / Instagram) per conversation row

---

## Phase 3 — WhatsApp end-to-end

**Goal:** a real customer can message on WhatsApp and a human can reply from the Inbox.

### 3.1 Tunnel setup
```bash
ngrok http 4000
# Copy the HTTPS URL, e.g. https://abc123.ngrok.io
```

### 3.2 Meta webhook registration
1. In Meta Developer Console → WhatsApp → Configuration
2. Webhook URL: `https://abc123.ngrok.io/api/webhooks/whatsapp`
3. Verify token: value of `WHATSAPP_VERIFY_TOKEN` in `.env`
4. Subscribe to `messages` field

### 3.3 Business setup
```bash
PATCH /api/businesses/:id
{ "whatsappPhoneNumberId": "YOUR_PHONE_NUMBER_ID" }
```

### 3.4 End-to-end flow
```
Customer sends WhatsApp message
  → Meta delivers POST to /api/webhooks/whatsapp
  → WhatsAppWebhookService upserts Customer, Identity, Conversation, Message
  → Message appears in Inbox
  → Agent clicks Generate AI Draft → approves → message sent via Meta Cloud API
  → Customer receives reply on WhatsApp
```

---

## Phase 4 — ActivityEvent + Lead scoring

**Goal:** activity feed shows real events; leads have computed intent scores.

### 4.1 ActivityEvent logging
Add writes to `ActivityEvent` table in existing services — no new endpoints needed until dashboard needs it.

| Event | Where to add |
|-------|-------------|
| `CUSTOMER_TAGGED` | `CustomerService.create` |
| `CONVERSATION_CREATED` | `ConversationService.create` |
| `MESSAGE_SENT` | `ConversationService.sendMessage` |
| `ORDER_PLACED` | `OrderService.create` |
| `ORDER_UPDATED` | `OrderService.updateStatus` |

New endpoint: `GET /api/businesses/:id/activity?limit=20` — feeds the recent activity feed on the overview.

### 4.2 Lead scoring
Scoring formula (max 100):

```
score = min(100,
  (conversation_count × 10)
  + (has_placed_order ? 30 : 0)
  + (days_since_last_message < 1 ? 20 : days_since_last_message < 7 ? 10 : 0)
)
```

- Recalculate on every inbound message (`WhatsAppWebhookService`) and on order creation (`OrderService`)
- Use Prisma `upsert` on `LeadScore`
- Leads page already renders `leadScore.score` — scores will appear automatically

---

## Phase 5 — Async worker (BullMQ)

**Goal:** AI drafts don't block HTTP requests; follow-ups are scheduled automatically.

### 5.1 Worker app setup
```bash
pnpm --filter @ai-customer-agent/worker add bullmq ioredis
```

- `apps/worker/src/queues.ts` — define queue names as constants
- `apps/worker/src/worker.ts` — entry point, connects to Redis, registers processors

### 5.2 Queues

| Queue | Trigger | Processor |
|-------|---------|-----------|
| `ai-draft` | API enqueues on `POST /ai-draft` | Worker calls OpenAI, saves draft message to DB |
| `lead-score` | Enqueued on inbound message or order | Worker recalculates `LeadScore` |
| `follow-up` | Scheduled if conversation has no reply after N hours | Worker generates follow-up draft, flags in Inbox |

### 5.3 API changes
- `POST /conversations/:id/ai-draft` → enqueue job, return `{ jobId }` immediately
- Frontend polls `GET /conversations/:id/ai-draft/status/:jobId` or refreshes conversation after a delay

---

## Phase 6 — Instagram channel

**Goal:** Instagram DMs appear in Inbox alongside WhatsApp conversations.

### 6.1 Backend
- `apps/api/src/modules/webhooks/instagram-webhook.controller.ts`
  - `GET /api/webhooks/instagram` — hub verification (same pattern as WhatsApp)
  - `POST /api/webhooks/instagram` — ingest `messaging` events
- `apps/api/src/modules/webhooks/instagram-parser.ts` — parse Meta Instagram webhook payload
- Extend `ConversationService.sendMessage` to handle `Channel.INSTAGRAM` via Graph API `POST /me/messages`

### 6.2 Payload format difference from WhatsApp
```json
// Instagram
{ "entry": [{ "messaging": [{ "sender": { "id": "..." }, "message": { "text": "..." } }] }] }
// WhatsApp
{ "entry": [{ "changes": [{ "value": { "messages": [...] } }] }] }
```

### 6.3 Settings page
- Add Instagram Page ID + Page Access Token fields
- Store `instagramPageId` on `Business` model (new migration)

---

## Phase 7 — Email channel

**Goal:** inbound emails create conversations; agents can reply by email from Inbox.

### 7.1 Inbound (Postmark or SendGrid inbound parse)
- Register webhook URL with provider: `POST /api/webhooks/email`
- Parser extracts: `from`, `subject`, `text`, `messageId`, `inReplyTo`
- Thread matching: find existing open conversation by `inReplyTo` header or create new one
- Customer lookup/upsert by email address

### 7.2 Outbound
```bash
pnpm --filter @ai-customer-agent/api add @postmark/client
# or
pnpm --filter @ai-customer-agent/api add resend
```
- Extend `ConversationService.sendMessage` for `Channel.EMAIL`
- Include `In-Reply-To` header for correct threading in email clients

### 7.3 New `.env` vars
```
EMAIL_FROM=hello@yourdomain.com
POSTMARK_SERVER_TOKEN=...
```

---

## Phase 8 — Shopify + Razorpay

**Goal:** orders from Shopify sync automatically; Razorpay payments update order status.

### 8.1 Shopify
- `POST /api/webhooks/shopify/orders/create`
  - Match customer by email → upsert Customer → create Order with status `PENDING_PAYMENT`
  - Verify `X-Shopify-Hmac-Sha256` header
- `POST /api/webhooks/shopify/products/update`
  - Sync `inventory` on existing Product rows

### 8.2 Razorpay
- `POST /api/webhooks/razorpay`
  - On `payment.captured` → update Order status to `PAID`
  - Verify Razorpay signature (`X-Razorpay-Signature`)

### 8.3 Generate payment links
- `POST /api/orders/:id/payment-link` — calls Razorpay API, returns link
- Link can be sent to customer via `POST /conversations/:id/send`

---

## Phase 9 — Production readiness

**Goal:** deploy to cloud, secure, observable.

### 9.1 Infrastructure
- Fill `infrastructure/terraform/` with Railway or AWS ECS configs
- Separate environments: `staging`, `production`
- Secrets managed via environment variables (never committed)

### 9.2 Security
- Rate limiting on `POST /auth/login` and `POST /auth/register` — prevent brute force
  ```bash
  pnpm --filter @ai-customer-agent/api add @nestjs/throttler
  ```
- HMAC signature verification on all inbound webhooks (Meta, Shopify, Razorpay)
- Rotate `JWT_SECRET` per environment

### 9.3 Observability
```bash
pnpm --filter @ai-customer-agent/api add pino pino-http @sentry/nestjs
```
- Replace `console.error` with structured Pino logger
- Sentry for error tracking
- Health endpoint extended with DB + Redis connectivity check

### 9.4 Multi-user support
- `POST /api/businesses/:id/invites` — generate invite token, email link to invitee
- `POST /api/auth/accept-invite/:token` — create User with `MEMBER` role under existing Business
- Role guards: `OWNER`-only routes = business settings, billing; `MEMBER` = conversations, customers, orders

---

## Key open decisions

| Decision | Options | Notes |
|----------|---------|-------|
| Worker scheduler | BullMQ (Redis-based) vs Temporal | BullMQ simpler to add; Temporal better for complex workflows |
| Email provider | Postmark vs Resend vs SendGrid | Resend has cleanest API; Postmark best deliverability |
| Cloud platform | Railway vs Render vs AWS ECS | Railway simplest for monorepo; AWS for scale |
| Frontend auth | localStorage JWT vs httpOnly cookie | Cookie safer against XSS; requires CSRF protection |
