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
