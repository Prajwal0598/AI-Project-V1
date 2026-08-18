"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Product } from "../../lib/api";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.products.list(bizId)
      .then(setProducts)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function add() {
    const bizId = getBusinessId();
    if (!name || !price || !bizId) return;
    setSaving(true);
    try {
      const product = await api.products.create(bizId, { name: name.trim(), price: parseFloat(price) });
      setProducts(prev => [product, ...prev]);
      setName(""); setPrice(""); setShow(false);
    } catch (err) { console.error(err); }
    finally { setSaving(false); }
  }

  return <AppShell title="Products" subtitle="Give your AI agent accurate products, pricing, and availability." action={<button className="primary-button" onClick={() => setShow(true)}>+ Add product</button>}>
    {show && <div className="inline-form">
      <input placeholder="Product name" value={name} onChange={e => setName(e.target.value)} />
      <input placeholder="Price in INR" value={price} onChange={e => setPrice(e.target.value)} />
      <button className="primary-button" onClick={add} disabled={saving}>{saving ? "Saving…" : "Save product"}</button>
      <button onClick={() => setShow(false)}>Cancel</button>
    </div>}
    <div className="product-grid">
      {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && products.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>No products yet. Add your first one.</p>}
      {products.map(p => (
        <article className="product-card" key={p.id}>
          <div className="product-icon">P</div>
          <span className="stage-chip">{p.active ? "Active" : "Inactive"}</span>
          <h2>{p.name}</h2>
          <strong>{p.currency} {p.price}</strong>
          <p>{p.inventory === null ? "Unlimited" : `${p.inventory} in stock`}</p>
          <button>Edit product</button>
        </article>
      ))}
    </div>
  </AppShell>;
}
