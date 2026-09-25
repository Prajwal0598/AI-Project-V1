// Railway Infrastructure as Code — https://docs.railway.com/infrastructure-as-code
// This is NOT applied automatically. From the repo root, with the Railway CLI installed and
// authenticated (`railway login`, `railway link`), run:
//   railway config plan     # preview what this would create/change
//   railway config apply    # apply after reviewing the plan
//
// Uses Railway's native builder (Railpack), not the apps/*/Dockerfile files — those stay
// useful for CI validation and other hosts, but Railway's own docs recommend plain
// `pnpm --filter <pkg> build/start` commands for a shared pnpm-workspace monorepo like this
// one, rather than fighting their Root-Directory-scoped Dockerfile build context.
import { defineRailway, github, group, postgres, preserve, project, redis, service, volume } from "railway/iac";

const REPO = "Prajwal0598/AI-Project-V1";

export default defineRailway(() => {
  const db = postgres("postgres");
  const cache = redis("redis");

  // product images are saved to local disk (apps/api/src/modules/products/image-storage.ts) with no
  // cloud storage backend yet — without this, every redeploy wipes every merchant's uploaded photos
  const productUploads = volume("api-uploads", { sizeMB: 500, region: "sfo" });
  // stopgap manual Postgres backups (jobs/database-backup.ts) until the account is on Railway Pro, which
  // includes automatic backups/PITR natively — deliberately a SEPARATE volume from the Postgres service's
  // own, so a problem with the live database volume doesn't also take out its own backups
  const postgresBackups = volume("postgres-backups", { sizeMB: 2000, region: "sfo" });

  const api = service("api", {
    source: github(REPO, { branch: "main" }),
    build: "pnpm db:generate && pnpm --filter @ai-customer-agent/api build",
    start: "pnpm --filter @ai-customer-agent/api start",
    // applies pending migrations before the new deploy goes live — never `migrate dev` in production
    preDeploy: "pnpm --filter @ai-customer-agent/database exec prisma migrate deploy",
    healthcheck: "/api/health",
    volumeMounts: {
      "/app/apps/api/uploads": productUploads,
    },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      PORT: "4000",
      // secrets — never written here; set once in the Railway dashboard (Variables tab) and left alone on every future apply
      JWT_SECRET: preserve(),
      JWT_EXPIRES_IN: preserve(),
      OPENAI_API_KEY: preserve(),
      CREDENTIALS_ENCRYPTION_KEY: preserve(),
      WHATSAPP_APP_SECRET: preserve(),
      META_APP_ID: preserve(),
      INSTAGRAM_APP_SECRET: preserve(),
      EMAIL_WEBHOOK_SECRET: preserve(),
      WHATSAPP_VERIFY_TOKEN: preserve(),
      INSTAGRAM_VERIFY_TOKEN: preserve(),
      // set these to the real deployed domains after the first `apply` (avoids a circular
      // reference between api<->web at plan time) — see NEXT_PUBLIC_API_URL below on `web`
      WEB_ORIGIN: preserve(),
      API_PUBLIC_URL: preserve(),
      SENTRY_DSN: preserve(),
    },
  });

  const worker = service("worker", {
    source: github(REPO, { branch: "main" }),
    build: "pnpm db:generate && pnpm --filter @ai-customer-agent/worker build",
    start: "pnpm --filter @ai-customer-agent/worker start",
    healthcheck: "/health",
    volumeMounts: {
      "/app/apps/worker/backups": postgresBackups,
    },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      PORT: "4001",
      BACKUP_DIR: "/app/apps/worker/backups",
      BACKUP_RETENTION_DAYS: "14",
      DATABASE_BACKUP_CRON: preserve(),
      OPENAI_API_KEY: preserve(),
      CREDENTIALS_ENCRYPTION_KEY: preserve(),
      SENTRY_DSN: preserve(),
    },
  });

  const web = service("web", {
    source: github(REPO, { branch: "main" }),
    build: "pnpm --filter @ai-customer-agent/web build",
    start: "pnpm --filter @ai-customer-agent/web start",
    env: {
      // Next.js inlines NEXT_PUBLIC_* at BUILD time — set to the api service's real public URL
      // after its first deploy (Railway's own dashboard shows the generated domain)
      NEXT_PUBLIC_API_URL: preserve(),
      // Meta App ID + WhatsApp Embedded Signup configuration_id — not secret (used client-side by the FB JS
      // SDK), but only meaningful once Meta App Review/Business Verification is complete (see docs/app-overview.md)
      NEXT_PUBLIC_META_APP_ID: preserve(),
      NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID: preserve(),
      NEXT_PUBLIC_SENTRY_DSN: preserve(),
    },
  });

  const backend = group("Backend", [db, cache, api, worker, productUploads]);

  return project("relay", {
    resources: [backend, web],
  });
});
