"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { BusinessStats, MessagePerformance, OpportunityTrendPoint, OpportunityTypeAnalytics } from "../../lib/api";

const TYPE_LABEL: Record<string, string> = {
  ABANDONED_CART: "Abandoned cart",
  PRODUCT_ENQUIRY: "Product enquiry",
  BACK_IN_STOCK: "Back in stock",
  HIGH_PURCHASE_INTENT: "High purchase intent",
  REPEAT_PURCHASE: "Repeat purchase",
  CROSS_SELL: "Cross-sell",
  UPSELL: "Upsell",
};

function fmtRevenue(v: string | number) {
  const n = Number(v ?? 0);
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<BusinessStats | null>(null);
  const [funnel, setFunnel] = useState<{ conversations: number; conversationsWithOrder: number; ordersPaid: number; ordersDelivered: number } | null>(null);
  const [channelRevenue, setChannelRevenue] = useState<Record<string, number>>({});
  const [customerMetrics, setCustomerMetrics] = useState<{ payingCustomers: number; repeatPurchaseRate: number; averageOrderValue: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, number>>({});
  const [opportunityAnalytics, setOpportunityAnalytics] = useState<OpportunityTypeAnalytics[]>([]);
  const [messagePerformance, setMessagePerformance] = useState<MessagePerformance[]>([]);
  const [trends, setTrends] = useState<OpportunityTrendPoint[]>([]);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.businesses.stats(bizId).then(setStats).catch(console.error);
    api.businesses.funnel(bizId).then(setFunnel).catch(console.error);
    api.businesses.revenueByChannel(bizId).then(setChannelRevenue).catch(console.error);
    api.businesses.customerMetrics(bizId).then(setCustomerMetrics).catch(console.error);
    api.businesses.conversationOutcomes(bizId).then(setOutcomes).catch(console.error);
    api.opportunities.analytics(bizId).then(setOpportunityAnalytics).catch(console.error);
    api.opportunities.messagePerformance(bizId).then(setMessagePerformance).catch(console.error);
    api.opportunities.trends(bizId, 30).then(setTrends).catch(console.error);
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
      <article className="data-card funnel-card">
        <h2>Commerce funnel</h2>
        {funnel && <>
          <div><span>Conversations</span><b>{funnel.conversations}</b></div>
          <div><span>→ Started an order</span><b>{funnel.conversationsWithOrder}</b></div>
          <div><span>→ Paid</span><b>{funnel.ordersPaid}</b></div>
          <div><span>→ Delivered</span><b>{funnel.ordersDelivered}</b></div>
        </>}
      </article>
      <article className="data-card channel-card">
        <h2>Revenue by channel</h2>
        {Object.keys(channelRevenue).length === 0
          ? <p style={{ fontSize: 12, color: "var(--muted)" }}>No paid orders yet.</p>
          : Object.entries(channelRevenue).map(([channel, revenue]) => (
            <div key={channel}><span>{channel}</span><b>{fmtRevenue(revenue)}</b></div>
          ))}
      </article>
      <article className="data-card channel-card">
        <h2>Customer cohort</h2>
        {customerMetrics && <>
          <div><span>Paying customers</span><b>{customerMetrics.payingCustomers}</b></div>
          <div><span>Repeat purchase rate</span><b>{customerMetrics.repeatPurchaseRate}%</b></div>
          <div><span>Average order value</span><b>{fmtRevenue(customerMetrics.averageOrderValue)}</b></div>
        </>}
      </article>
      <article className="data-card channel-card">
        <h2>Conversation outcomes</h2>
        {Object.keys(outcomes).length === 0
          ? <p style={{ fontSize: 12, color: "var(--muted)" }}>No conversations yet.</p>
          : Object.entries(outcomes).map(([outcome, count]) => (
            <div key={outcome}><span>{outcome}</span><b>{count}</b></div>
          ))}
      </article>
    </div>

    <h3 style={{ marginTop: 28, marginBottom: 12 }}>Proactive AI performance</h3>
    <div className="analytics-grid">
      <article className="data-card funnel-card" style={{ gridColumn: "1 / -1" }}>
        <h2>Opportunity trends (last 30 days)</h2>
        {trends.length === 0
          ? <p style={{ fontSize: 12, color: "var(--muted)" }}>No opportunity activity yet.</p>
          : <TrendChart points={trends} />}
      </article>
      <article className="data-card channel-card">
        <h2>Conversion by opportunity type</h2>
        {opportunityAnalytics.length === 0
          ? <p style={{ fontSize: 12, color: "var(--muted)" }}>No opportunities detected yet.</p>
          : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead><tr style={{ textAlign: "left" }}><th style={{ padding: 4 }}>Type</th><th style={{ padding: 4 }}>Created</th><th style={{ padding: 4 }}>Sent</th><th style={{ padding: 4 }}>Converted</th><th style={{ padding: 4 }}>Rate</th><th style={{ padding: 4 }}>Revenue</th></tr></thead>
            <tbody>
              {opportunityAnalytics.map(a => (
                <tr key={a.type}>
                  <td style={{ padding: 4 }}>{TYPE_LABEL[a.type] ?? a.type}</td>
                  <td style={{ padding: 4 }}>{a.created}</td>
                  <td style={{ padding: 4 }}>{a.sent}</td>
                  <td style={{ padding: 4 }}>{a.converted}</td>
                  <td style={{ padding: 4 }}>{a.conversionRate}%</td>
                  <td style={{ padding: 4 }}>{fmtRevenue(a.revenueAttributed)}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </article>
      <article className="data-card channel-card">
        <h2>AI-drafted vs. edited messages</h2>
        {messagePerformance.length === 0
          ? <p style={{ fontSize: 12, color: "var(--muted)" }}>No suggestions sent yet.</p>
          : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead><tr style={{ textAlign: "left" }}><th style={{ padding: 4 }}>Type</th><th style={{ padding: 4 }}>Variant</th><th style={{ padding: 4 }}>Sent</th><th style={{ padding: 4 }}>Converted</th><th style={{ padding: 4 }}>Rate</th></tr></thead>
            <tbody>
              {messagePerformance.map(m => (
                <tr key={`${m.type}-${m.variant}`}>
                  <td style={{ padding: 4 }}>{TYPE_LABEL[m.type] ?? m.type}</td>
                  <td style={{ padding: 4 }}>{m.variant === "edited" ? "Merchant-edited" : "AI-original"}</td>
                  <td style={{ padding: 4 }}>{m.sent}</td>
                  <td style={{ padding: 4 }}>{m.converted}</td>
                  <td style={{ padding: 4 }}>{m.conversionRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </article>
    </div>
  </AppShell>;
}

function TrendChart({ points }: { points: OpportunityTrendPoint[] }) {
  const maxCount = Math.max(1, ...points.map(p => Math.max(p.created, p.sent)));
  return <div>
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, marginTop: 12 }}>
      {points.map(p => (
        <div key={p.date} title={`${p.date}\nCreated: ${p.created}\nSent: ${p.sent}\nRevenue: ${fmtRevenue(p.revenue)}`} style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 1, height: "100%" }}>
          <div style={{ flex: 1, height: `${(p.created / maxCount) * 100}%`, background: "#c9bdf0", borderRadius: "2px 2px 0 0", minHeight: p.created ? 2 : 0 }} />
          <div style={{ flex: 1, height: `${(p.sent / maxCount) * 100}%`, background: "#7961d6", borderRadius: "2px 2px 0 0", minHeight: p.sent ? 2 : 0 }} />
        </div>
      ))}
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
      <span>{points[0]?.date}</span>
      <span>{points[points.length - 1]?.date}</span>
    </div>
    <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
      <span><i style={{ display: "inline-block", width: 8, height: 8, background: "#c9bdf0", borderRadius: 2, marginRight: 4 }} />Created</span>
      <span><i style={{ display: "inline-block", width: 8, height: 8, background: "#7961d6", borderRadius: 2, marginRight: 4 }} />Sent</span>
      <span>Total revenue influenced: {fmtRevenue(points.reduce((sum, p) => sum + p.revenue, 0))}</span>
    </div>
  </div>;
}
