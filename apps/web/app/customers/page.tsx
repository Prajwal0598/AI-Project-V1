"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell, EmptyState } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Customer } from "../../lib/api";

type FilterKey = "all" | "new" | "repeat" | "high_intent" | "recent";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New customers" },
  { key: "repeat", label: "Repeat customers" },
  { key: "high_intent", label: "High intent" },
  { key: "recent", label: "Recently active" },
];
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function custName(c: Customer) { return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.phone || "Unknown"; }
function initials(c: Customer) { return custName(c).split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
function fmtMoney(n: number) { return n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${n.toLocaleString("en-IN")}`; }
function timeAgo(d: string | null | undefined) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  return `${Math.floor(diff / 86400000)} days ago`;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function load() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setLoading(true);
    api.customers.list(bizId, query || undefined)
      .then(setCustomers)
      .catch(() => setError("Couldn't load customers. Please try again."))
      .finally(() => setLoading(false));
  }

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [query]);

  const filtered = useMemo(() => customers.filter(c => {
    switch (filter) {
      case "new": return (c.totalOrders ?? 0) === 0;
      case "repeat": return (c.totalOrders ?? 0) > 1;
      case "high_intent": return (c.leadScore?.score ?? 0) > 80;
      case "recent": return !!c.lastActivityAt && Date.now() - new Date(c.lastActivityAt).getTime() <= RECENT_WINDOW_MS;
      default: return true;
    }
  }), [customers, filter]);

  return <AppShell title="Customers" subtitle="Manage and understand your customers.">
    <div className="filter-row">
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name, phone, email, or customer ID" />
      {FILTERS.map(f => (
        <button key={f.key} className={`filter-button ${filter === f.key ? "active" : ""}`} onClick={() => setFilter(f.key)}>{f.label}</button>
      ))}
      <span>{filtered.length} {loading ? "…" : "customers"}</span>
    </div>
    {error && <div className="login-error" style={{ marginBottom: 14 }}>{error} <button className="text-button" onClick={load}>Retry</button></div>}
    <div className="data-card lead-table">
      <div className="table-head"><span>Customer</span><span>Contact</span><span>Orders</span><span>Total spent</span><span>Last order</span><span>Last active</span><span>Status</span></div>
      {loading && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState title={customers.length === 0 ? "No customers yet" : "No customers match this filter"} copy={customers.length === 0 ? "Customers appear here automatically once someone messages or orders from you." : "Try a different search or filter."} />
      )}
      {filtered.map(c => (
        <Link href={`/customers/${c.id}`} className="table-row" key={c.id} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="person"><b>{initials(c)}</b><strong>{custName(c)}</strong></div>
          <span className="source-chip">{c.primaryChannel ?? c.identities[0]?.channel ?? "Manual"}</span>
          <span className="activity-copy">{c.totalOrders ?? 0}</span>
          <span><strong>{fmtMoney(c.totalSpent ?? 0)}</strong></span>
          <span className="activity-copy">{timeAgo(c.lastOrderAt)}</span>
          <span className="activity-copy">{timeAgo(c.lastActivityAt)}</span>
          <span className={`stage-chip ${c.status === "ACTIVE" ? "intent" : ""}`}>{c.status === "ACTIVE" ? "Active" : "Inactive"}</span>
        </Link>
      ))}
    </div>
  </AppShell>;
}
