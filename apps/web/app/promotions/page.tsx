"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Category, Promotion, PromotionTargetSegment } from "../../lib/api";

const SEGMENT_LABEL: Record<PromotionTargetSegment, string> = {
  ALL_CUSTOMERS: "All customers",
  CATEGORY_BUYERS: "Past buyers in a category",
  HIGH_VALUE_CUSTOMERS: "High-value customers",
};

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [discountDescription, setDiscountDescription] = useState("");
  const [targetSegment, setTargetSegment] = useState<PromotionTargetSegment>("ALL_CUSTOMERS");
  const [categoryId, setCategoryId] = useState("");
  const [creating, setCreating] = useState(false);

  function load() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setLoading(true);
    api.promotions.list(bizId).then(setPromotions).catch(console.error).finally(() => setLoading(false));
    api.categories.list(bizId).then(setCategories).catch(console.error);
  }

  useEffect(load, []);

  async function createPromotion() {
    const bizId = getBusinessId();
    if (!bizId || !title.trim() || !message.trim()) return;
    if (targetSegment === "CATEGORY_BUYERS" && !categoryId) { setError("Choose a category to target its past buyers."); return; }
    setCreating(true);
    setError("");
    try {
      await api.promotions.create(bizId, {
        title: title.trim(), message: message.trim(),
        discountDescription: discountDescription.trim() || undefined,
        targetSegment, categoryId: targetSegment === "CATEGORY_BUYERS" ? categoryId : undefined,
      });
      setTitle(""); setMessage(""); setDiscountDescription(""); setTargetSegment("ALL_CUSTOMERS"); setCategoryId("");
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create this promotion."); }
    finally { setCreating(false); }
  }

  async function broadcast(promotion: Promotion) {
    if (!confirm(`Broadcast "${promotion.title}" to ${SEGMENT_LABEL[promotion.targetSegment].toLowerCase()}? This sends a real suggestion to each matching customer (subject to their automation rules).`)) return;
    setBusyId(promotion.id);
    try {
      const result = await api.promotions.broadcast(promotion.id);
      alert(`Targeted ${result.targeted} customer(s), created ${result.created} suggestion(s) (some may have been skipped by opt-out/frequency-cap rules).`);
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not broadcast this promotion."); }
    finally { setBusyId(null); }
  }

  async function remove(promotion: Promotion) {
    if (!confirm(`Delete draft promotion "${promotion.title}"?`)) return;
    setBusyId(promotion.id);
    try { await api.promotions.remove(promotion.id); load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not delete this promotion."); }
    finally { setBusyId(null); }
  }

  return <AppShell title="Promotions" subtitle="Create a discount or announcement and broadcast it to a customer segment.">
    {error && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{error} <button onClick={() => setError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}

    <div className="data-card" style={{ padding: 16, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>New promotion</h3>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", maxWidth: 720 }}>
        <label style={{ fontSize: 12 }}>Title<input value={title} onChange={e => setTitle(e.target.value)} style={{ width: "100%", marginTop: 4 }} placeholder="Diwali sale" /></label>
        <label style={{ fontSize: 12 }}>Discount label (optional)<input value={discountDescription} onChange={e => setDiscountDescription(e.target.value)} style={{ width: "100%", marginTop: 4 }} placeholder="20% off" /></label>
        <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>Message (sent to customers exactly as written)
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} style={{ width: "100%", marginTop: 4 }} placeholder="Our Diwali sale is live — 20% off everything this week only!" />
        </label>
        <label style={{ fontSize: 12 }}>Target segment
          <select value={targetSegment} onChange={e => setTargetSegment(e.target.value as PromotionTargetSegment)} style={{ width: "100%", marginTop: 4 }}>
            {(Object.keys(SEGMENT_LABEL) as PromotionTargetSegment[]).map(s => <option key={s} value={s}>{SEGMENT_LABEL[s]}</option>)}
          </select>
        </label>
        {targetSegment === "CATEGORY_BUYERS" && <label style={{ fontSize: 12 }}>Category
          <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={{ width: "100%", marginTop: 4 }}>
            <option value="">Choose a category…</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>}
      </div>
      <button className="primary-button" style={{ marginTop: 12 }} disabled={creating || !title.trim() || !message.trim()} onClick={createPromotion}>{creating ? "Creating…" : "Save as draft"}</button>
    </div>

    {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
    {!loading && promotions.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>No promotions yet — create one above.</p>}

    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {promotions.map(p => (
        <div className="data-card" key={p.id} style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <span className="source-chip" style={{ fontSize: 10 }}>{SEGMENT_LABEL[p.targetSegment]}</span>
              <h3 style={{ margin: "8px 0 2px" }}>{p.title}{p.discountDescription && <small style={{ color: "var(--muted)", fontWeight: 400 }}> · {p.discountDescription}</small>}</h3>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>{p.message}</p>
            </div>
            <div style={{ textAlign: "right", fontSize: 12 }}>
              {p.broadcastedAt
                ? <span style={{ color: "#237a52" }}>✓ Broadcast to {p.broadcastCount} customer(s)</span>
                : <div style={{ display: "flex", gap: 8 }}>
                  <button className="primary-button" disabled={busyId === p.id} onClick={() => broadcast(p)}>Broadcast</button>
                  <button disabled={busyId === p.id} onClick={() => remove(p)}>Delete</button>
                </div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  </AppShell>;
}
