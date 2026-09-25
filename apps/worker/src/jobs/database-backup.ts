import { gzipSync } from "node:zlib";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../prisma";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/app/backups";
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;

/**
 * Stopgap manual backup, since Railway's automatic Postgres backups/point-in-time-recovery require the Pro
 * plan (not currently on it — see docs/app-overview.md). Originally shelled out to `pg_dump`, but Railway's
 * Railpack build only has Postgres 17 client tools available (via Debian's own apt repo) while the server
 * runs Postgres 18 — pg_dump refuses to run against a NEWER server than itself, with no override flag, and
 * pulling in a version-matched client would need the separate apt.postgresql.org repo, which isn't reachable
 * through Railpack's simple aptPackages config. Dumping DATA ONLY via Prisma's own connection sidesteps this
 * entirely (no version-sensitive catalog introspection, no external binary) — the SCHEMA itself is already
 * fully recoverable from the git-tracked Prisma migrations via `prisma migrate deploy`, so a restore is:
 * 1) `prisma migrate deploy` against a fresh database, 2) re-insert each table's rows from this dump's JSON.
 */
export async function processDatabaseBackup() {
  await mkdir(BACKUP_DIR, { recursive: true });

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  const dump: Record<string, unknown[]> = {};
  for (const { tablename } of tables) {
    dump[tablename] = await prisma.$queryRawUnsafe(`SELECT * FROM "${tablename}"`);
  }

  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
  const filepath = join(BACKUP_DIR, filename);
  const body = JSON.stringify({ dumpedAt: new Date().toISOString(), tables: dump }, jsonReplacer);
  await writeFile(filepath, gzipSync(body));
  const { size } = await stat(filepath);

  const pruned = await pruneOldBackups();
  return { file: filename, sizeBytes: size, tableCount: tables.length, pruned };
}

// Prisma returns Decimal as a Decimal.js instance, bigint as native bigint, and Buffer for bytea columns —
// none of which JSON.stringify handles natively
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Buffer) return value.toString("base64");
  if (value && typeof value === "object" && "toFixed" in value && typeof (value as { toFixed: unknown }).toFixed === "function") {
    return (value as { toString(): string }).toString(); // Decimal.js
  }
  return value;
}

export async function pruneOldBackups(): Promise<string[]> {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const files = await readdir(BACKUP_DIR);
  const removed: string[] = [];
  for (const file of files) {
    const filepath = join(BACKUP_DIR, file);
    const info = await stat(filepath);
    if (info.isFile() && info.mtimeMs < cutoff) {
      await unlink(filepath);
      removed.push(file);
    }
  }
  return removed;
}
