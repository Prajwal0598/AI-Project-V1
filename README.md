# AI Customer Agent

Multi-channel customer acquisition, sales, and support platform.

## Workspace

- `apps/web` — business dashboard
- `apps/api` — API, webhooks, and product modules
- `apps/worker` — asynchronous jobs and AI workflows
- `packages/*` — database, types, UI, configuration, and integrations
- `infrastructure` — local Docker and future cloud deployment

See `docs/architecture.md` for the initial system design.

## Run the backend locally

```powershell
docker compose -f infrastructure/docker/docker-compose.yml up -d
Copy-Item .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm --filter @ai-customer-agent/api dev
```

The API starts at `http://localhost:4000` and its health endpoint is `GET /health`.
