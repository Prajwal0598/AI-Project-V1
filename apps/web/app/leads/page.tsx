"use client";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Customer } from "../../lib/api";

function custName(c: Customer) { return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.phone || "Unknown"; }
function initials(c: Customer) { return custName(c).split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(); }

export default function LeadsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.customers.list(bizId)
      .then(setCustomers)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => customers.filter(c => {
    const q = query.toLowerCase();
    return custName(c).toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.phone?.includes(q);
  }), [customers, query]);

  return <AppShell title="Leads" subtitle="Prioritise people most likely to become customers.">
    <div className="filter-row">
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search leads" />
      <button className="filter-button">All channels</button>
      <button className="filter-button">All types</button>
      <span>{filtered.length} {loading ? "…" : "leads"}</span>
    </div>
    <div className="data-card lead-table">
      <div className="table-head"><span>Customer</span><span>Channel</span><span>Score</span><span>Type</span><span>Activity</span></div>
      {loading && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && filtered.length === 0 && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>No leads found.</p>}
      {filtered.map(c => (
        <div className="table-row" key={c.id}>
          <div className="person"><b>{initials(c)}</b><strong>{custName(c)}</strong></div>
          <span className="source-chip">{c.identities[0]?.channel ?? "Manual"}</span>
          <span className={`intent ${(c.leadScore?.score ?? 0) > 80 ? "hot" : ""}`}>{c.leadScore?.score ?? "—"}{c.leadScore ? "/100" : ""}</span>
          <span className="stage-chip">{c.type === "CUSTOMER" ? "Customer" : "Lead"}</span>
          <span className="activity-copy">{c._count.conversations} conv · {c._count.orders} orders</span>
        </div>
      ))}
    </div>
  </AppShell>;
}
