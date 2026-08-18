"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Order } from "../../lib/api";

const STATUS_NEXT: Record<Order["status"], Order["status"] | null> = {
  DRAFT: "PENDING_PAYMENT",
  PENDING_PAYMENT: "PAID",
  PAID: "FULFILLED",
  FULFILLED: null,
  CANCELLED: null,
  REFUNDED: null,
};

const STATUS_COLOR: Record<Order["status"], string> = {
  DRAFT: "",
  PENDING_PAYMENT: "source-chip",
  PAID: "intent",
  FULFILLED: "intent hot",
  CANCELLED: "",
  REFUNDED: "",
};

function custName(c: Order["customer"]) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unknown";
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.orders.list(bizId).then(setOrders).catch(console.error).finally(() => setLoading(false));
  }, []);

  async function advance(order: Order) {
    const next = STATUS_NEXT[order.status];
    if (!next) return;
    try {
      const updated = await api.orders.updateStatus(order.id, next);
      setOrders(prev => prev.map(o => o.id === updated.id ? { ...o, status: updated.status } : o));
    } catch (err) { console.error(err); }
  }

  return <AppShell title="Orders" subtitle="Track and manage every customer order.">
    <div className="data-card lead-table">
      <div className="table-head">
        <span>Order</span><span>Customer</span><span>Total</span><span>Status</span><span>Date</span><span></span>
      </div>
      {loading && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && orders.length === 0 && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>No orders yet.</p>}
      {orders.map(o => (
        <div className="table-row" key={o.id}>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--muted)" }}>#{o.id.slice(-8).toUpperCase()}</span>
          <div className="person"><b>{custName(o.customer).slice(0, 2).toUpperCase()}</b><strong>{custName(o.customer)}</strong></div>
          <span><strong>{o.currency} {o.total}</strong></span>
          <span className={`stage-chip ${STATUS_COLOR[o.status]}`}>{o.status.replace("_", " ")}</span>
          <span className="activity-copy">{fmtDate(o.createdAt)}</span>
          {STATUS_NEXT[o.status] && (
            <button className="filter-button" style={{ fontSize: 10 }} onClick={() => advance(o)}>
              → {STATUS_NEXT[o.status]!.replace("_", " ")}
            </button>
          )}
        </div>
      ))}
    </div>
  </AppShell>;
}
