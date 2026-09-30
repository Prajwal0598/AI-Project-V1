"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppShell, EmptyState } from "../../../components/app-shell";
import { api } from "../../../lib/api";
import type { CustomerProfile, Order, ConversationSummary, ActivityTimelineItem, Paginated } from "../../../lib/api";

const CHANNEL_BADGE: Record<string, string> = { WHATSAPP: "WA", INSTAGRAM: "IG", EMAIL: "✉", WEB: "W", MANUAL: "M", FACEBOOK: "FB" };
const TABS = ["Overview", "Conversations", "Orders", "Activity"] as const;
type Tab = typeof TABS[number];
const PAGE_SIZE = 10;

function custName(c: { firstName: string | null; lastName: string | null; email?: string | null; phone: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.phone || "Unknown";
}
function initials(name: string) { return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
function fmtMoney(n: number) { return n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${n.toLocaleString("en-IN")}`; }
function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDateTime(d: string) {
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return <div className="pager">
    <button className="filter-button" disabled={page <= 1} onClick={() => onChange(page - 1)}>← Prev</button>
    <span>Page {page} of {pages}</span>
    <button className="filter-button" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next →</button>
  </div>;
}

export default function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("Overview");

  const [overviewOrders, setOverviewOrders] = useState<Order[] | null>(null);
  const [overviewConversation, setOverviewConversation] = useState<ConversationSummary | null>(null);
  const [overviewActivity, setOverviewActivity] = useState<ActivityTimelineItem[] | null>(null);

  const [ordersPage, setOrdersPage] = useState(1);
  const [orders, setOrders] = useState<Paginated<Order> | null>(null);
  const [ordersError, setOrdersError] = useState("");

  const [conversationsPage, setConversationsPage] = useState(1);
  const [conversations, setConversations] = useState<Paginated<ConversationSummary> | null>(null);
  const [conversationsError, setConversationsError] = useState("");

  const [activityPage, setActivityPage] = useState(1);
  const [activity, setActivity] = useState<Paginated<ActivityTimelineItem> | null>(null);
  const [activityError, setActivityError] = useState("");

  const loadProfile = useCallback(() => {
    if (!id) return;
    setLoading(true); setProfileError("");
    api.customers.get(id).then(setProfile).catch(() => setProfileError("Couldn't load this customer.")).finally(() => setLoading(false));
  }, [id]);

  useEffect(loadProfile, [loadProfile]);

  // light previews for the Overview tab — independent failures never blank the rest of the profile
  useEffect(() => {
    if (!id) return;
    api.customers.getOrders(id, 1, 3).then(r => setOverviewOrders(r.items)).catch(() => setOverviewOrders([]));
    api.customers.getConversations(id, 1, 1).then(r => setOverviewConversation(r.items[0] ?? null)).catch(() => setOverviewConversation(null));
    api.customers.getActivity(id, 1, 5).then(r => setOverviewActivity(r.items)).catch(() => setOverviewActivity([]));
  }, [id]);

  useEffect(() => {
    if (!id || tab !== "Orders") return;
    setOrdersError("");
    api.customers.getOrders(id, ordersPage, PAGE_SIZE).then(setOrders).catch(() => setOrdersError("Couldn't load orders."));
  }, [id, tab, ordersPage]);

  useEffect(() => {
    if (!id || tab !== "Conversations") return;
    setConversationsError("");
    api.customers.getConversations(id, conversationsPage, PAGE_SIZE).then(setConversations).catch(() => setConversationsError("Couldn't load conversations."));
  }, [id, tab, conversationsPage]);

  useEffect(() => {
    if (!id || tab !== "Activity") return;
    setActivityError("");
    api.customers.getActivity(id, activityPage, PAGE_SIZE).then(setActivity).catch(() => setActivityError("Couldn't load activity."));
  }, [id, tab, activityPage]);

  if (loading) return <AppShell title="Customers" subtitle="Manage and understand your customers."><p style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>Loading…</p></AppShell>;
  if (profileError || !profile) return <AppShell title="Customers" subtitle="Manage and understand your customers.">
    <EmptyState title="Couldn't load this customer" copy={profileError || "This customer may not exist, or you don't have access."} action={<button className="primary-button" onClick={loadProfile}>Retry</button>} />
  </AppShell>;

  const name = custName(profile);
  const latestConversationId = overviewConversation?.id;

  return <AppShell title={name} subtitle="Customer profile">
    <div className="profile-header card">
      <div className="profile-identity">
        <div className="profile-avatar">{initials(name)}</div>
        <div>
          <h2>{name} <span className={`stage-chip ${profile.status === "ACTIVE" ? "intent" : ""}`}>{profile.status === "ACTIVE" ? "Active" : "Inactive"}</span></h2>
          <p className="profile-meta">
            {profile.phone && <span>{profile.phone}</span>}
            {profile.email && <span>{profile.email}</span>}
            {profile.primaryChannel && <span className="source-chip">{CHANNEL_BADGE[profile.primaryChannel] ?? profile.primaryChannel} {profile.primaryChannel}</span>}
          </p>
        </div>
      </div>
      <div className="profile-actions">
        {latestConversationId
          ? <Link href={`/inbox?conversationId=${latestConversationId}`} className="primary-button">💬 Message</Link>
          : <span className="profile-action-disabled" title="No conversation with this customer yet">💬 Message</span>}
      </div>
    </div>

    <div className="metric-grid" style={{ marginTop: 18 }}>
      <div className="metric-card"><p>Lifetime value</p><h2>{fmtMoney(profile.summary.totalSpent)}</h2></div>
      <div className="metric-card"><p>Total orders</p><h2>{profile.summary.totalOrders}</h2></div>
      <div className="metric-card"><p>Average order value</p><h2>{fmtMoney(profile.summary.averageOrderValue)}</h2></div>
      <div className="metric-card"><p>Last purchase</p><h2 style={{ fontSize: 18 }}>{fmtDate(profile.summary.lastOrderAt)}</h2></div>
    </div>

    <div className="card insight-card">
      <div className="card-heading"><h3>✦ AI Customer Insight</h3></div>
      {profile.insight ? <>
        <p className="insight-reason">{profile.insight.reason}</p>
        {profile.insight.suggestedAction && <p className="insight-action"><strong>Suggested action:</strong> {profile.insight.suggestedAction}</p>}
      </> : <p className="insight-empty">No AI insight yet — insights appear once we detect real signals from this customer's activity.</p>}
    </div>

    <div className="profile-tabs">
      {TABS.map(t => <button key={t} className={`profile-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>)}
    </div>

    {tab === "Overview" && <div className="profile-overview-grid">
      <div className="card">
        <div className="card-heading"><h3>Customer information</h3></div>
        <dl className="info-list">
          <div><dt>Name</dt><dd>{name}</dd></div>
          <div><dt>Phone</dt><dd>{profile.phone ?? "—"}</dd></div>
          <div><dt>Email</dt><dd>{profile.email ?? "—"}</dd></div>
          <div><dt>Primary channel</dt><dd>{profile.primaryChannel ?? "—"}</dd></div>
          <div><dt>First interaction</dt><dd>{fmtDate(profile.firstInteractionAt)}</dd></div>
          <div><dt>Last interaction</dt><dd>{fmtDate(profile.lastInteractionAt)}</dd></div>
        </dl>
      </div>

      {(profile.preferences.statedBudget !== null || profile.preferences.frequentlyPurchased.length > 0 || profile.preferences.recentlyViewed.length > 0) && (
        <div className="card">
          <div className="card-heading"><h3>Preferences</h3></div>
          {profile.preferences.statedBudget !== null && (
            <p className="preference-row"><span className="preference-tag stated">Customer stated</span> Typical budget around {fmtMoney(profile.preferences.statedBudget)}</p>
          )}
          {profile.preferences.frequentlyPurchased.length > 0 && (
            <p className="preference-row"><span className="preference-tag inferred">AI inferred</span> Frequently buys {profile.preferences.frequentlyPurchased.map(p => p.name).join(", ")}</p>
          )}
          {profile.preferences.recentlyViewed.length > 0 && (
            <p className="preference-row"><span className="preference-tag inferred">AI inferred</span> Recently viewed {profile.preferences.recentlyViewed.map(p => p.name).join(", ")}</p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-heading"><h3>Recent orders</h3></div>
        {overviewOrders === null && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
        {overviewOrders?.length === 0 && <EmptyState title="No orders yet" copy="Orders placed by this customer will appear here." />}
        {overviewOrders && overviewOrders.length > 0 && <div className="lead-table" style={{ border: "none" }}>
          {overviewOrders.map(o => (
            <Link href={`/orders?highlight=${o.id}`} key={o.id} className="table-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr", textDecoration: "none", color: "inherit" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11 }}>#{o.id.slice(-8).toUpperCase()}</span>
              <span className="activity-copy">{fmtDate(o.createdAt)}</span>
              <span><strong>{o.currency} {o.total}</strong></span>
              <span className="stage-chip">{o.status.replace(/_/g, " ")}</span>
            </Link>
          ))}
        </div>}
      </div>

      <div className="card">
        <div className="card-heading"><h3>Recent conversation</h3></div>
        {overviewConversation === null && <EmptyState title="No conversations yet" copy="Messages from this customer will appear here." />}
        {overviewConversation && (
          <Link href={`/inbox?conversationId=${overviewConversation.id}`} className="conversation-preview">
            <p><strong>{custName(overviewConversation.customer)}:</strong> {overviewConversation.messages[0]?.content ?? "—"}</p>
            <p className="conversation-preview-meta">{overviewConversation.channel} · {overviewConversation.status} · {fmtDateTime(overviewConversation.lastMessageAt ?? overviewConversation.messages[0]?.sentAt ?? "")}</p>
          </Link>
        )}
      </div>

      <div className="card">
        <div className="card-heading"><h3>Recent activity</h3></div>
        {overviewActivity === null && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
        {overviewActivity?.length === 0 && <EmptyState title="No activity yet" copy="Meaningful events for this customer will appear here." />}
        {overviewActivity && overviewActivity.length > 0 && <ul className="timeline">
          {overviewActivity.map(a => <li key={a.id}><time>{fmtDateTime(a.createdAt)}</time><span>{a.summary}</span></li>)}
        </ul>}
      </div>
    </div>}

    {tab === "Conversations" && <div className="card">
      {conversationsError && <div className="login-error">{conversationsError} <button className="text-button" onClick={() => setConversationsPage(p => p)}>Retry</button></div>}
      {!conversations && !conversationsError && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {conversations?.items.length === 0 && <EmptyState title="No conversations yet" copy="Every conversation with this customer will show up here." />}
      {conversations && conversations.items.length > 0 && <>
        <div className="lead-table" style={{ border: "none" }}>
          <div className="table-head" style={{ gridTemplateColumns: "1fr 1fr 1fr 2fr" }}><span>Channel</span><span>Started</span><span>Status</span><span>Last message</span></div>
          {conversations.items.map(c => (
            <Link href={`/inbox?conversationId=${c.id}`} key={c.id} className="table-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 2fr", textDecoration: "none", color: "inherit" }}>
              <span className="source-chip">{CHANNEL_BADGE[c.channel] ?? c.channel}</span>
              <span className="activity-copy">{fmtDate(c.lastMessageAt)}</span>
              <span className="stage-chip">{c.status}</span>
              <span className="activity-copy">{c.messages[0]?.content.slice(0, 60) ?? "—"}</span>
            </Link>
          ))}
        </div>
        <Pager page={conversationsPage} pageSize={PAGE_SIZE} total={conversations.total} onChange={setConversationsPage} />
      </>}
    </div>}

    {tab === "Orders" && <div className="card">
      {ordersError && <div className="login-error">{ordersError} <button className="text-button" onClick={() => setOrdersPage(p => p)}>Retry</button></div>}
      {!orders && !ordersError && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {orders?.items.length === 0 && <EmptyState title="No orders yet" copy="This customer's full order history will appear here." />}
      {orders && orders.items.length > 0 && <>
        <div className="lead-table" style={{ border: "none" }}>
          <div className="table-head" style={{ gridTemplateColumns: "1fr 1fr 2fr 1fr 1fr 1fr" }}><span>Order</span><span>Date</span><span>Items</span><span>Total</span><span>Payment</span><span>Status</span></div>
          {orders.items.map(o => (
            <Link href={`/orders?highlight=${o.id}`} key={o.id} className="table-row" style={{ gridTemplateColumns: "1fr 1fr 2fr 1fr 1fr 1fr", textDecoration: "none", color: "inherit" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11 }}>#{o.id.slice(-8).toUpperCase()}</span>
              <span className="activity-copy">{fmtDate(o.createdAt)}</span>
              <span className="activity-copy">{o.items?.map(i => i.name).join(", ") ?? "—"}</span>
              <span><strong>{o.currency} {o.total}</strong></span>
              <span className="source-chip">{o.paymentMethod ?? "—"}</span>
              <span className="stage-chip">{o.status.replace(/_/g, " ")}</span>
            </Link>
          ))}
        </div>
        <Pager page={ordersPage} pageSize={PAGE_SIZE} total={orders.total} onChange={setOrdersPage} />
      </>}
    </div>}

    {tab === "Activity" && <div className="card">
      {activityError && <div className="login-error">{activityError} <button className="text-button" onClick={() => setActivityPage(p => p)}>Retry</button></div>}
      {!activity && !activityError && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {activity?.items.length === 0 && <EmptyState title="No activity yet" copy="A chronological timeline of this customer's activity will appear here." />}
      {activity && activity.items.length > 0 && <>
        <ul className="timeline">
          {activity.items.map(a => <li key={a.id}><time>{fmtDateTime(a.createdAt)}</time><span>{a.summary}</span></li>)}
        </ul>
        <Pager page={activityPage} pageSize={PAGE_SIZE} total={activity.total} onChange={setActivityPage} />
      </>}
    </div>}
  </AppShell>;
}
