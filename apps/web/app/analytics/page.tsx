"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { BusinessStats } from "../../lib/api";

function fmtRevenue(v: string | number) {
  const n = Number(v ?? 0);
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<BusinessStats | null>(null);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.businesses.stats(bizId).then(setStats).catch(console.error);
  }, []);

  const metrics: [string, string, string][] = [
    ["Total leads", stats ? String(stats.leads) : "—", ""],
    ["Conversations", stats ? String(stats.conversations) : "—", ""],
    ["Open conversations", stats ? String(stats.openConversations) : "—", ""],
    ["Orders placed", stats ? String(stats.orders) : "—", ""],
  ];

  return <AppShell title="Analytics" subtitle="See where customer intent becomes revenue." action={<button className="filter-button">Last 30 days</button>}>
    <div className="analytics-metrics">
      {metrics.map(([label, value]) => (
        <article key={label}><p>{label}</p><h2>{value}</h2></article>
      ))}
    </div>
    <div className="analytics-grid">
      <article className="data-card funnel-card">
        <h2>Revenue from paid orders</h2>
        <p style={{ fontSize: 28, fontWeight: 700, margin: "12px 0 0", letterSpacing: "-1px" }}>{stats ? fmtRevenue(stats.revenue) : "—"}</p>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Sum of PAID and FULFILLED orders</p>
      </article>
      <article className="data-card channel-card">
        <h2>Customers vs leads</h2>
        {stats && <>
          <div><span>Leads</span><b>{stats.leads}</b></div>
          <div><span>Customers</span><b>{stats.customers}</b></div>
          <div><span>Total</span><b>{stats.leads + stats.customers}</b></div>
        </>}
      </article>
    </div>
  </AppShell>;
}
