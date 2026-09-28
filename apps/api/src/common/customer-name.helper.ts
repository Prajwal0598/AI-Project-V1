/** One canonical customer display name for every customer-facing message — avoids alternating between
 * first-name-only/full-name/raw-identifier across call sites. Omits personalization (returns the fallback)
 * when no reliable name is on file, rather than ever falling back to an internal identifier. */
export function formatCustomerDisplayName(customer: { firstName?: string | null; lastName?: string | null } | null | undefined, fallback = "there"): string {
  const name = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}
