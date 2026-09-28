// mirrors apps/api's customer-name.helper.ts — duplicated because the worker is a separate process/package
export function formatCustomerDisplayName(customer: { firstName?: string | null; lastName?: string | null } | null | undefined, fallback = "there"): string {
  const name = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}
