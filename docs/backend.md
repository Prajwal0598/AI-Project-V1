# Backend and database

The API is a NestJS service and PostgreSQL is the source of truth. Prisma owns the database schema and migrations.

## Local start

1. Start PostgreSQL and Redis: `docker compose -f infrastructure/docker/docker-compose.yml up -d`
2. Copy `.env.example` to `.env`.
3. Generate the Prisma client: `pnpm db:generate`.
4. Create the initial migration: `corepack pnpm db:migrate --name init`.
5. Start the API: `pnpm --filter @ai-customer-agent/api dev`.

## Initial API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health check |
| `GET`, `POST` | `/api/businesses` | List or create a tenant business |
| `GET`, `POST` | `/api/businesses/:businessId/customers` | Customer search and creation |
| `GET` | `/api/customers/:customerId` | Customer 360 profile and conversation history |
| `POST` | `/api/customers/:customerId/identities` | Link a channel identity to a customer |
| `POST` | `/api/customers/:customerId/conversations` | Open a customer conversation |
| `GET` | `/api/conversations/:conversationId` | Get a full conversation |
| `POST` | `/api/conversations/:conversationId/messages` | Add an inbound, outbound, or system message |

Authentication, provider webhooks, and the AI workflow worker should be added before exposing these endpoints publicly.

## AI reply draft

`POST /api/conversations/:conversationId/ai-draft` creates an OpenAI-backed **draft** from the business catalogue and the most recent conversation messages. It stores the draft in PostgreSQL but never sends it to a customer. The key is read only by the API process from the root `.env` file. Set `OPENAI_MODEL` there to a model your project can use.

## Meta callbacks: manual review runbook

Meta calls `POST /api/integrations/meta/deauthorize` when a Facebook user removes RelayShift, and `POST /api/integrations/meta/data-deletion` when they ask for their data to be deleted. Meta identifies the person only by an app-scoped user id. Nobody has yet seen a real Meta callback carry the same id this server stored when the merchant connected, so the match is treated as unverified. `META_CALLBACK_IDENTITY_MATCH_VERIFIED` stays unset (off) until that has been observed; do not set it as part of a review. While it is off, a matching callback changes nothing automatically and waits for a person.

| Event | Recorded as | Review route (platform admin only) |
| --- | --- | --- |
| Deauthorization that matched a stored link | `NO_ACTION_UNVERIFIED` | `/api/platform/meta-deauthorizations` |
| Data deletion with no link, or with a link while matching is unverified | `PENDING_REVIEW` | `/api/platform/meta-callbacks` |
| Deauthorization with no link | `NO_MATCH` | nothing to review |

The two reviews are separate: each route refuses the other's records, and neither can delete a business, customers, conversations or orders. The only effects are disconnecting the WhatsApp connection of businesses you name and revoking their link to the Facebook account.

### Who can do it

A RelayShift user whose `isPlatformAdmin` flag is set (a manual database change; merchants cannot reach these routes). Sign in with `POST /api/auth/login` and use the returned `accessToken` as `Authorization: Bearer <token>`. Do not paste tokens into tickets or shared channels. The routes are rate limited; resolving allows 5 requests a minute.

### Reviewing a deauthorization (`NO_ACTION_UNVERIFIED`)

1. List the queue: `GET /api/platform/meta-deauthorizations` (add `?status=COMPLETED` or `?status=NO_CHANGE_RECORDED` to look at closed events). The response never contains the Facebook user id.
2. Open one: `GET /api/platform/meta-deauthorizations/<id>`. The `PROCESSED` event lists `candidateBusinessIds`, the businesses holding a stored link to the account when the callback arrived, and `createdAt` is when it arrived. A candidate is only a suggestion; being listed authorises nothing.
3. Establish, outside the system, which candidate (if any) really belongs to the person who removed the app. There is no automated check. Contact the workspace through a channel you already trust and ask whether they removed RelayShift from their Facebook account around `createdAt`. Accept either a written confirmation from the merchant (`MERCHANT_WRITTEN_CONFIRMATION`) or a message from the workspace's registered email address (`EMAIL_FROM_REGISTERED_ADDRESS`), and keep it in your ticket. Your own reading of our records (`RECORDS_REVIEW`) is enough to close an event with no change, never to disconnect.
4. Preview: `POST /api/platform/meta-deauthorizations/<id>/resolve/preview` with `{"outcome":"DISCONNECT_VERIFIED","businessIds":["<id>"]}` or `{"outcome":"NO_CHANGE"}`. Nothing is written. It returns each candidate's state, `warnings`, the proposed action and the exact `confirmationRequired` text. Resolve any warning first: `LINK_NO_LONGER_ACTIVE` or `RECONNECTED_AFTER_EVENT` mean the business's current connection is not the one the event concerns, and `IDENTIFIER_DELETED` means only `NO_CHANGE` is possible.
5. Resolve: `POST /api/platform/meta-deauthorizations/<id>/resolve`.

| Outcome | Body fields | Effect |
| --- | --- | --- |
| `DISCONNECT_VERIFIED` | `businessIds` (only the businesses you verified), `verificationMethod` (`MERCHANT_WRITTEN_CONFIRMATION` or `EMAIL_FROM_REGISTERED_ADDRESS`), `resolutionReference`, `confirm` = `DISCONNECT_VERIFIED <id>` | Disconnects those businesses' WhatsApp connection (status `DEAUTHORIZED`) and revokes their link; status becomes `COMPLETED`. Unnamed candidates are untouched. |
| `NO_CHANGE` | `reason`, `verificationMethod`, `resolutionReference`, `confirm` = `NO_CHANGE <id>` | Changes nothing; status becomes `NO_CHANGE_RECORDED`. |

`resolutionReference` is a ticket id (3 to 64 characters from `A-Z a-z 0-9 . _ : -`), never personal data. `reason` is one of `IDENTITY_NOT_ESTABLISHED` (no candidate could be tied to the account), `MERCHANT_CONFIRMED_KEEP_CONNECTED` (the merchant confirmed the connection should stay), `CONNECTION_ALREADY_REPLACED` (the connection was replaced or disconnected since), `SUPERSEDED_BY_DATA_DELETION` (the identifier was deleted by a data-deletion resolution).

Sending the same resolution again (same outcome, reference, verification method, businesses and reason) returns the stored outcome with `alreadyResolved: true` and repeats nothing. A different reference, verification method, outcome, business set or reason returns 409 and leaves the stored resolution and its audit history unchanged. If a 409 or 404 says a business is not a candidate or its link changed, preview again; if a resolve fails with 500 nothing was changed and it is safe to retry with the same reference. `GET .../<id>` shows the full audit history, including who resolved it.

### Reviewing a data-deletion request (`PENDING_REVIEW`)

Use `/api/platform/meta-callbacks`: `GET` the list (`?status=PENDING_REVIEW&kind=DATA_DELETION`), `GET .../<id>`, `POST .../<id>/resolve/preview`, then `POST .../<id>/resolve` with outcome `COMPLETED` (naming the businesses) or `NO_DATA_HELD`, a `verificationMethod`, a `resolutionReference` and `confirm` = `RESOLVE <confirmationCode>`. The confirmation code is the key to the person's public status page, so keep it out of tickets and logs. Resolving removes the Facebook identifier everywhere and updates that public page. Sending the identical resolution again (same outcome, reference, verification method and businesses) returns the stored outcome with `alreadyResolved: true`; any difference returns 409 and leaves the stored resolution and its audit history unchanged.
