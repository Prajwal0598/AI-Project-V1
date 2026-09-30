"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Order } from "../../lib/api";

const STATUS_NEXT: Record<Order["status"], Order["status"] | null> = {
  DRAFT: "PENDING_PAYMENT",
  AWAITING_APPROVAL: null, // requires the dedicated Approve action, not a normal status advance
  PENDING_PAYMENT: "PAID",
  PAID: "FULFILLED",
  FULFILLED: null,
  CANCELLED: null,
  REFUNDED: null,
};

const STATUS_COLOR: Record<Order["status"], string> = {
  DRAFT: "",
  AWAITING_APPROVAL: "intent hot",
  PENDING_PAYMENT: "source-chip",
  PAID: "intent",
  FULFILLED: "intent hot",
  CANCELLED: "",
  REFUNDED: "",
};

const FULFILLMENT_NEXT: Record<Order["fulfillmentStatus"], Order["fulfillmentStatus"] | null> = {
  NOT_STARTED: "PACKED",
  PACKED: "SHIPPED",
  SHIPPED: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "DELIVERED",
  DELIVERED: null,
  FAILED: null,
  RETURNED: null,
};

function custName(c: Order["customer"]) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unknown";
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function OrdersPage() {
  return <Suspense fallback={null}><OrdersPageInner /></Suspense>;
}

function OrdersPageInner() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const highlightId = useSearchParams().get("highlight");
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.orders.list(bizId).then(setOrders).catch(console.error).finally(() => setLoading(false));
  }, []);

  // scrolls to the linked order when arriving from a customer profile — there's no separate order-detail
  // page/route to navigate to instead, so this table is the destination, just brought into view
  useEffect(() => {
    if (highlightId && highlightRef.current) highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, orders]);

  async function advance(order: Order) {
    const next = STATUS_NEXT[order.status];
    if (!next) return;
    try {
      const updated = await api.orders.updateStatus(order.id, next);
      setOrders(prev => prev.map(o => o.id === updated.id ? { ...o, status: updated.status } : o));
    } catch (err) { console.error(err); }
  }

  async function approve(order: Order) {
    try {
      const updated = await api.orders.approve(order.id);
      setOrders(prev => prev.map(o => o.id === updated.id ? { ...o, status: updated.status } : o));
    } catch (err) { console.error(err); }
  }

  async function advanceFulfillment(order: Order) {
    const next = FULFILLMENT_NEXT[order.fulfillmentStatus];
    if (!next) return;
    try {
      const updated = await api.orders.updateFulfillment(order.id, next);
      setOrders(prev => prev.map(o => o.id === updated.id ? { ...o, status: updated.status, fulfillmentStatus: updated.fulfillmentStatus } : o));
    } catch (err) { console.error(err); }
  }

  return <AppShell title="Orders" subtitle="Track and manage every customer order.">
    <div className="data-card lead-table">
      <div className="table-head">
        <span>Order</span><span>Customer</span><span>Total</span><span>Payment</span><span>Status</span><span>Shipment</span><span>Date</span><span></span>
      </div>
      {loading && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && orders.length === 0 && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>No orders yet.</p>}
      {orders.map(o => (
        <div className={`table-row ${o.id === highlightId ? "highlighted" : ""}`} key={o.id} ref={o.id === highlightId ? highlightRef : undefined}>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--muted)" }}>#{o.id.slice(-8).toUpperCase()}</span>
          <Link href={`/customers/${o.customer.id}`} className="person" style={{ textDecoration: "none", color: "inherit" }}><b>{custName(o.customer).slice(0, 2).toUpperCase()}</b><strong>{custName(o.customer)}</strong></Link>
          <span><strong>{o.currency} {o.total}</strong></span>
          <span className="source-chip">{o.paymentMethod ?? "—"}</span>
          <span className={`stage-chip ${STATUS_COLOR[o.status]}`}>{o.status.replace("_", " ")}</span>
          <span className="activity-copy">{(o.status === "PAID" || o.status === "FULFILLED") ? o.fulfillmentStatus.replace(/_/g, " ") : "—"}</span>
          <span className="activity-copy">{fmtDate(o.createdAt)}</span>
          {o.status === "AWAITING_APPROVAL" && (
            <button className="filter-button" style={{ fontSize: 10 }} onClick={() => approve(o)}>
              ✓ Approve
            </button>
          )}
          {STATUS_NEXT[o.status] && (
            <button className="filter-button" style={{ fontSize: 10 }} onClick={() => advance(o)}>
              → {STATUS_NEXT[o.status]!.replace("_", " ")}
            </button>
          )}
          {(o.status === "PAID" || o.status === "FULFILLED") && FULFILLMENT_NEXT[o.fulfillmentStatus] && (
            <button className="filter-button" style={{ fontSize: 10 }} onClick={() => advanceFulfillment(o)}>
              📦 {FULFILLMENT_NEXT[o.fulfillmentStatus]!.replace(/_/g, " ")}
            </button>
          )}
        </div>
      ))}
    </div>
  </AppShell>;
}
