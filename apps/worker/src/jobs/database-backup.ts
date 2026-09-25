import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/app/backups";
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;

/**
 * Stopgap manual backup, since Railway's automatic Postgres backups/point-in-time-recovery require the Pro
 * plan (not currently on it — see docs/app-overview.md). Runs `pg_dump` (plain SQL, not the custom binary
 * format, so a restore never depends on matching pg_dump/pg_restore versions) against DATABASE_URL onto a
 * dedicated Railway volume — separate from the Postgres service's own volume, so a problem with the live
 * database doesn't also destroy its own backups. Superseded once the account moves to Railway Pro.
 */
export async function processDatabaseBackup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return { skipped: "DATABASE_URL not configured" };

  await mkdir(BACKUP_DIR, { recursive: true });
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
  const filepath = join(BACKUP_DIR, filename);

  // connection string passed as an argv element (not shell-interpolated) — execFile never spawns a shell
  await execFileAsync("pg_dump", [databaseUrl, "-f", filepath], { maxBuffer: 1024 * 1024 * 64 });
  const { size } = await stat(filepath);

  const pruned = await pruneOldBackups();
  return { file: filename, sizeBytes: size, pruned };
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
