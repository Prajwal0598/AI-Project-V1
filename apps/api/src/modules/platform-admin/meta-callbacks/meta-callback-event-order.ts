// The only order the workflows can write events in: the request is RECEIVED, the callback PROCESSES it, a platform admin may then RESOLVE it.
const LIFECYCLE_RANK: Record<string, number> = { RECEIVED: 0, PROCESSED: 1, RESOLVED: 2 };
const UNKNOWN_ACTION_RANK = 1000;

/**
 * Audit events in the order they happened. createdAt is stamped per statement by the Prisma engine at millisecond precision, so every row
 * of one multi-row write (and often back-to-back writes) shares it, and the table has no sequence column. Equal timestamps are therefore
 * ordered by lifecycle stage; the id is only a last tie-break to make the result repeatable (ids come from each API process and are not
 * evidence of order). Events with different timestamps keep the order recorded: clock skew between API instances cannot be detected here.
 */
export function orderCallbackEvents<T extends { id: string; action: string; createdAt: Date }>(events: readonly T[]): T[] {
  const rank = (action: string) => LIFECYCLE_RANK[action] ?? UNKNOWN_ACTION_RANK;
  return [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || rank(a.action) - rank(b.action) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
