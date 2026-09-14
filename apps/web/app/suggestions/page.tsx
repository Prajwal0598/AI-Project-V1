"use client";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId, resolveImageUrl } from "../../lib/api";
import type { Business, BestSendHour, Opportunity, OpportunityPriority, OpportunityStatus, OpportunitySummary } from "../../lib/api";

function fmtHour(hour: number): string {
  const period = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${period}`;
}

const TYPE_LABEL: Record<Opportunity["type"], string> = {
  ABANDONED_CART: "Abandoned cart",
  PRODUCT_ENQUIRY: "Product enquiry",
  BACK_IN_STOCK: "Back in stock",
  HIGH_PURCHASE_INTENT: "High purchase intent",
  REPEAT_PURCHASE: "Repeat purchase",
  CROSS_SELL: "Cross-sell",
  UPSELL: "Upsell",
  NEW_PRODUCT_MATCH: "New product match",
  PROMOTION: "Promotion",
  UNANSWERED_CONVERSATION: "Unanswered conversation",
  LOW_ENGAGEMENT: "Low engagement",
  HIGH_VALUE_CUSTOMER: "High-value customer",
};

const PRIORITY_COLOR: Record<OpportunityPriority, string> = { HIGH: "#b94940", MEDIUM: "#8a6a1f", LOW: "#777484" };

const STATUS_TABS: { label: string; value: OpportunityStatus | "ACTIVE" }[] = [
  { label: "Active", value: "ACTIVE" },
  { label: "Sent", value: "SENT" },
  { label: "Converted", value: "CONVERTED" },
  { label: "Dismissed", value: "DISMISSED" },
];

function customerName(c: Opportunity["customer"]): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || c.email || "Customer";
}

function fmtCurrency(value: string | null): string {
  if (value == null) return "—";
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

export default function SuggestionsPage() {
  const [business, setBusiness] = useState<Business | null>(null);
  const [summary, setSummary] = useState<OpportunitySummary | null>(null);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [tab, setTab] = useState<OpportunityStatus | "ACTIVE">("ACTIVE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bestHours, setBestHours] = useState<Record<string, BestSendHour | null>>({});

  function load() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setLoading(true);
    api.businesses.get(bizId).then(setBusiness).catch(console.error);
    api.opportunities.summary(bizId).then(setSummary).catch(console.error);
    api.opportunities.list(bizId, tab === "ACTIVE" ? undefined : tab)
      .then(list => setOpportunities(tab === "ACTIVE" ? list.filter(o => o.status !== "SENT") : list))
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  useEffect(load, [tab]);

  useEffect(() => {
    const uncached = [...new Set(opportunities.map(o => o.customerId))].filter(id => !(id in bestHours));
    if (uncached.length === 0) return;
    uncached.forEach(customerId => {
      api.opportunities.bestSendHour(customerId)
        .then(result => setBestHours(prev => ({ ...prev, [customerId]: result })))
        .catch(() => setBestHours(prev => ({ ...prev, [customerId]: null })));
    });
  }, [opportunities]);

  const messageFor = (o: Opportunity) => drafts[o.id] ?? o.suggestion?.editedMessage ?? o.suggestion?.message ?? "";

  async function send(o: Opportunity) {
    setBusyId(o.id);
    try {
      const edited = drafts[o.id];
      await api.opportunities.send(o.id, edited && edited !== o.suggestion?.message ? edited : undefined);
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send this suggestion."); }
    finally { setBusyId(null); }
  }

  async function dismiss(o: Opportunity) {
    setBusyId(o.id);
    try { await api.opportunities.dismiss(o.id); load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not dismiss."); }
    finally { setBusyId(null); }
  }

  async function snooze(o: Opportunity, hours: 4 | 24 | 72) {
    setBusyId(o.id);
    try { await api.opportunities.snooze(o.id, hours); load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not snooze."); }
    finally { setBusyId(null); }
  }

  const visible = useMemo(() => opportunities, [opportunities]);

  return <AppShell title="Suggestions" subtitle="Relay's proactive sales opportunities — review, edit, and send." action={
    !business ? undefined : <span style={{ fontSize: 12, color: "var(--muted)" }}>
      Proactive AI Suggestions is {business.proactiveSuggestionsEnabled ? <strong style={{ color: "#237a52" }}>ON</strong> : <strong style={{ color: "#b94940" }}>OFF</strong>} — <a href="/settings">manage in Settings</a>
    </span>
  }>
    {error && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{error} <button onClick={() => setError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}

    {business && !business.proactiveSuggestionsEnabled && <div style={{ background: "#fff8ea", border: "1px solid #f3e0ad", color: "#8a6a1f", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>
      Proactive AI Suggestions is currently off — Relay won't detect new opportunities until you enable it in Settings.
    </div>}

    {summary && <div className="metric-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
      <article className="metric-card"><p>Awaiting your action</p><h2>{summary.awaitingAction}</h2></article>
      <article className="metric-card"><p>High priority</p><h2>{summary.highPriority}</h2></article>
      <article className="metric-card"><p>Potential revenue</p><h2>₹{summary.potentialRevenue.toLocaleString("en-IN")}</h2></article>
      <article className="metric-card"><p>Revenue influenced</p><h2>₹{summary.revenueInfluenced.toLocaleString("en-IN")}</h2></article>
    </div>}

    <div className="filter-row" style={{ marginBottom: 12 }}>
      {STATUS_TABS.map(t => (
        <button key={t.value} onClick={() => setTab(t.value)} className={tab === t.value ? "primary-button" : undefined}>{t.label}</button>
      ))}
    </div>

    {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
    {!loading && visible.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>Nothing here right now.</p>}

    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {visible.map(o => (
        <div className="data-card" key={o.id} style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <span className="stage-chip" style={{ color: PRIORITY_COLOR[o.priority], marginRight: 8 }}>{o.priority}</span>
              <span className="source-chip" style={{ fontSize: 10 }}>{TYPE_LABEL[o.type]}</span>
              <h3 style={{ margin: "8px 0 2px" }}>{customerName(o.customer)}</h3>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>{o.reason}</p>
              {bestHours[o.customerId] && <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 11 }}>💡 Best time to reach them: ~{fmtHour(bestHours[o.customerId]!.hour)} (from {bestHours[o.customerId]!.sampleSize} past replies)</p>}
            </div>
            <div style={{ textAlign: "right" }}>
              {o.relatedProduct && <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                {o.relatedProduct.imageUrl && <img src={resolveImageUrl(o.relatedProduct.imageUrl) ?? undefined} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover" }} />}
                <small style={{ color: "var(--muted)" }}>{o.relatedProduct.name}</small>
              </div>}
              <strong style={{ fontSize: 15 }}>{fmtCurrency(o.estimatedValue)}</strong>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>score {o.score} · {Math.round(o.confidence * 100)}% confidence</div>
            </div>
          </div>

          {(o.status === "NEW" || o.status === "SNOOZED") && <>
            <textarea value={messageFor(o)} onChange={e => setDrafts(prev => ({ ...prev, [o.id]: e.target.value }))} rows={2} style={{ width: "100%", marginTop: 10 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="primary-button" disabled={busyId === o.id} onClick={() => send(o)}>Send</button>
              <button disabled={busyId === o.id} onClick={() => dismiss(o)}>Dismiss</button>
              <button disabled={busyId === o.id} onClick={() => snooze(o, 4)}>Snooze 4h</button>
              <button disabled={busyId === o.id} onClick={() => snooze(o, 24)}>Snooze 1d</button>
              <button disabled={busyId === o.id} onClick={() => snooze(o, 72)}>Snooze 3d</button>
            </div>
          </>}

          {o.status === "SENT" && <p style={{ marginTop: 10, fontSize: 12, color: "#237a52" }}>✓ Sent — &ldquo;{o.suggestion?.editedMessage ?? o.suggestion?.message}&rdquo;</p>}
          {o.status === "CONVERTED" && <p style={{ marginTop: 10, fontSize: 12, color: "#237a52" }}>✓ Converted — {fmtCurrency(o.outcome?.attributedRevenue ?? null)} attributed</p>}
          {o.status === "DISMISSED" && <p style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>Dismissed</p>}
        </div>
      ))}
    </div>
  </AppShell>;
}
