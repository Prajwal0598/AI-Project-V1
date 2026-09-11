"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId, resolveImageUrl } from "../../lib/api";
import type { ImportJob, ImportRow, Product, Variant } from "../../lib/api";

const STATUS_COLOR: Record<ImportRow["status"], string> = { READY: "#237a52", WARNING: "#8a6a1f", ERROR: "#b94940" };

interface VariantEdit { sku: string; price: string; inventory: string; active: boolean }

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [sku, setSku] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitSummary, setCommitSummary] = useState<{ created: number; updated: number; skipped: number } | null>(null);

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editBrand, setEditBrand] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editVariants, setEditVariants] = useState<Record<string, VariantEdit>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  function loadProducts() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.products.list(bizId).then(setProducts).catch(console.error).finally(() => setLoading(false));
  }

  useEffect(loadProducts, []);

  async function add() {
    const bizId = getBusinessId();
    if (!name || !price || !bizId) return;
    setSaving(true);
    try {
      const product = await api.products.create(bizId, { name: name.trim(), price: parseFloat(price), sku: sku.trim() || undefined });
      setProducts(prev => [product, ...prev]);
      setName(""); setPrice(""); setSku(""); setShow(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save product."); }
    finally { setSaving(false); }
  }

  async function startImport() {
    const bizId = getBusinessId();
    if (!importFile || !bizId) return;
    setImporting(true);
    setError("");
    try {
      const created = await api.imports.create(bizId, importFile);
      const jobRows = await api.imports.rows(created.id);
      setJob(created);
      setRows(jobRows);
      setShowImport(false);
      setImportFile(null);
      setCommitSummary(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Import failed — check the file format and try again."); }
    finally { setImporting(false); }
  }

  async function editRow(rowId: string, field: string, value: string) {
    if (!job) return;
    const numericFields = new Set(["price", "inventory", "compareAtPrice", "costPrice", "weight"]);
    const parsed = numericFields.has(field) ? (value === "" ? undefined : Number(value)) : value;
    try {
      const updated = await api.imports.updateRow(job.id, rowId, { normalizedData: { [field]: parsed } });
      setRows(prev => prev.map(r => (r.id === rowId ? updated : r)));
      const refreshedJob = await api.imports.get(job.id);
      setJob(refreshedJob);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update row."); }
  }

  async function commitImport() {
    if (!job) return;
    setCommitting(true);
    try {
      const summary = await api.imports.commit(job.id);
      setCommitSummary(summary);
      setJob(null);
      setRows([]);
      loadProducts();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not commit the import."); }
    finally { setCommitting(false); }
  }

  async function cancelImport() {
    if (!job) return;
    try { await api.imports.cancel(job.id); } catch { /* best-effort */ }
    setJob(null);
    setRows([]);
  }

  function openEdit(p: Product) {
    setEditingProduct(p);
    setEditName(p.name);
    setEditDescription(p.description ?? "");
    setEditCategory(p.category ?? "");
    setEditBrand(p.brand ?? "");
    setEditActive(p.active);
    setEditImageUrl(p.imageUrl);
    const variantState: Record<string, VariantEdit> = {};
    for (const v of p.variants) {
      variantState[v.id] = { sku: v.sku ?? "", price: v.price, inventory: v.inventory == null ? "" : String(v.inventory), active: v.active };
    }
    setEditVariants(variantState);
    setError("");
  }

  function updateEditVariant(variantId: string, patch: Partial<VariantEdit>) {
    setEditVariants(prev => ({ ...prev, [variantId]: { ...prev[variantId], ...patch } }));
  }

  async function uploadImage(file: File) {
    if (!editingProduct) return;
    setUploadingImage(true);
    try {
      const updated = await api.products.uploadImage(editingProduct.id, file);
      setEditImageUrl(updated.imageUrl);
      setProducts(prev => prev.map(p => (p.id === updated.id ? { ...p, imageUrl: updated.imageUrl } : p)));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not upload image."); }
    finally { setUploadingImage(false); }
  }

  async function saveEdit() {
    if (!editingProduct) return;
    setSavingEdit(true);
    try {
      const updatedProduct = await api.products.update(editingProduct.id, {
        name: editName.trim(),
        description: editDescription.trim(),
        category: editCategory.trim(),
        brand: editBrand.trim(),
        active: editActive,
      });
      const updatedVariants: Variant[] = [];
      for (const v of editingProduct.variants) {
        const edit = editVariants[v.id];
        if (!edit) continue;
        const updated = await api.products.updateVariant(v.id, {
          sku: edit.sku.trim(),
          price: parseFloat(edit.price),
          inventory: edit.inventory === "" ? undefined : parseInt(edit.inventory, 10),
          active: edit.active,
        });
        updatedVariants.push(updated);
      }
      const merged: Product = { ...updatedProduct, variants: updatedVariants.length ? updatedVariants : updatedProduct.variants };
      setProducts(prev => prev.map(p => (p.id === merged.id ? merged : p)));
      setEditingProduct(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save product changes."); }
    finally { setSavingEdit(false); }
  }

  return <AppShell title="Products" subtitle="Give your AI agent accurate products, pricing, and availability." action={
    <div style={{ display: "flex", gap: 8 }}>
      <button onClick={() => setShowImport(true)}>Import Product Catalogue</button>
      <button className="primary-button" onClick={() => setShow(true)}>+ Add product</button>
    </div>
  }>
    {error && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{error} <button onClick={() => setError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}
    {commitSummary && <div style={{ background: "#eefaf3", border: "1px solid #bfe8d3", color: "#237a52", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>
      ✓ Import complete — {commitSummary.created} created, {commitSummary.updated} updated, {commitSummary.skipped} skipped.
      <button onClick={() => setCommitSummary(null)} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button>
    </div>}

    {show && <div className="inline-form">
      <input placeholder="Product name" value={name} onChange={e => setName(e.target.value)} />
      <input placeholder="SKU (optional)" value={sku} onChange={e => setSku(e.target.value)} />
      <input placeholder="Price in INR" value={price} onChange={e => setPrice(e.target.value)} />
      <button className="primary-button" onClick={add} disabled={saving}>{saving ? "Saving…" : "Save product"}</button>
      <button onClick={() => setShow(false)}>Cancel</button>
    </div>}

    {editingProduct && <div className="data-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Edit product</h3>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
        {editImageUrl
          ? <img src={resolveImageUrl(editImageUrl) ?? undefined} alt={editName} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
          : <div style={{ width: 96, height: 96, borderRadius: 8, border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 11 }}>No image</div>}
        <label style={{ fontSize: 12, color: "var(--muted)" }}>
          Product image (JPEG/PNG/WEBP/GIF, max 3MB)
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploadingImage}
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadImage(f); }} style={{ display: "block", marginTop: 6 }} />
          {uploadingImage && <span>Uploading…</span>}
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 640 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Name
          <input value={editName} onChange={e => setEditName(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Category
          <input value={editCategory} onChange={e => setEditCategory(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Brand
          <input value={editBrand} onChange={e => setEditBrand(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, marginTop: 16 }}>
          <input type="checkbox" checked={editActive} onChange={e => setEditActive(e.target.checked)} /> Active (visible to the AI agent)
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)", gridColumn: "1 / -1" }}>Description
          <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={2} style={{ width: "100%" }} />
        </label>
      </div>

      <h4 style={{ marginBottom: 6 }}>Variants</h4>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: 6 }}>SKU</th>
              <th style={{ padding: 6 }}>Price</th>
              <th style={{ padding: 6 }}>Stock</th>
              <th style={{ padding: 6 }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {editingProduct.variants.map(v => {
              const edit = editVariants[v.id] ?? { sku: "", price: "", inventory: "", active: true };
              return <tr key={v.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: 6 }}><input value={edit.sku} onChange={e => updateEditVariant(v.id, { sku: e.target.value })} style={{ width: 110 }} /></td>
                <td style={{ padding: 6 }}><input value={edit.price} onChange={e => updateEditVariant(v.id, { price: e.target.value })} style={{ width: 80 }} /></td>
                <td style={{ padding: 6 }}><input value={edit.inventory} onChange={e => updateEditVariant(v.id, { inventory: e.target.value })} placeholder="Unlimited" style={{ width: 80 }} /></td>
                <td style={{ padding: 6 }}><input type="checkbox" checked={edit.active} onChange={e => updateEditVariant(v.id, { active: e.target.checked })} /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="primary-button" onClick={saveEdit} disabled={savingEdit || !editName.trim()}>{savingEdit ? "Saving…" : "Save changes"}</button>
        <button onClick={() => setEditingProduct(null)}>Cancel</button>
      </div>
    </div>}

    {showImport && <div className="inline-form" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>Upload a CSV or Excel (.xlsx) file. Common headers like Name/SKU/Price/Stock are detected automatically.</p>
      <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setImportFile(e.target.files?.[0] ?? null)} />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary-button" onClick={startImport} disabled={!importFile || importing}>{importing ? "Uploading…" : "Upload & review"}</button>
        <button onClick={() => { setShowImport(false); setImportFile(null); }}>Cancel</button>
      </div>
    </div>}

    {job && <div className="data-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Import review — {job.filename}</h3>
      <p style={{ fontSize: 12, color: "var(--muted)" }}>
        {job.rowsDetected} detected · {job.rowsReady} ready · {job.rowsWarning} need review · {job.rowsError} blocked
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: 6 }}>#</th>
              <th style={{ padding: 6 }}>Name</th>
              <th style={{ padding: 6 }}>SKU</th>
              <th style={{ padding: 6 }}>Price</th>
              <th style={{ padding: 6 }}>Stock</th>
              <th style={{ padding: 6 }}>Status</th>
              <th style={{ padding: 6 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const d = (r.normalizedData ?? {}) as Record<string, unknown>;
              return <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: 6 }}>{r.rowNumber}</td>
                <td style={{ padding: 6 }}><input defaultValue={String(d.name ?? "")} onBlur={e => e.target.value !== String(d.name ?? "") && editRow(r.id, "name", e.target.value)} style={{ width: 140 }} /></td>
                <td style={{ padding: 6 }}><input defaultValue={String(d.sku ?? "")} onBlur={e => e.target.value !== String(d.sku ?? "") && editRow(r.id, "sku", e.target.value)} style={{ width: 90 }} /></td>
                <td style={{ padding: 6 }}><input defaultValue={String(d.price ?? "")} onBlur={e => e.target.value !== String(d.price ?? "") && editRow(r.id, "price", e.target.value)} style={{ width: 80 }} /></td>
                <td style={{ padding: 6 }}><input defaultValue={String(d.inventory ?? "")} onBlur={e => e.target.value !== String(d.inventory ?? "") && editRow(r.id, "inventory", e.target.value)} style={{ width: 70 }} /></td>
                <td style={{ padding: 6, color: STATUS_COLOR[r.status], fontWeight: 600 }}>{r.status}</td>
                <td style={{ padding: 6, color: "var(--muted)" }}>{r.validationErrors?.join("; ") ?? ""}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="primary-button" onClick={commitImport} disabled={committing}>{committing ? "Importing…" : `Import Products (${job.rowsReady + job.rowsWarning})`}</button>
        <button onClick={cancelImport}>Cancel import</button>
      </div>
    </div>}

    <div className="product-grid">
      {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && products.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>No products yet. Add your first one.</p>}
      {products.map(p => {
        const v = p.variants[0];
        return <article className="product-card" key={p.id}>
          {p.imageUrl ? <img src={resolveImageUrl(p.imageUrl) ?? undefined} alt={p.name} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8 }} /> : <div className="product-icon">P</div>}
          <span className="stage-chip">{p.active ? "Active" : "Inactive"}</span>
          <h2>{p.name}</h2>
          {v && <strong>{v.currency} {v.price}</strong>}
          {v?.sku && <p style={{ margin: 0, color: "var(--muted)", fontSize: 11 }}>SKU: {v.sku}</p>}
          <p>{v?.inventory == null ? "Unlimited" : `${v.inventory} in stock`}</p>
          {p.source === "IMPORT" && <span className="source-chip" style={{ fontSize: 10 }}>Imported</span>}
          <button onClick={() => openEdit(p)}>Edit product</button>
        </article>;
      })}
    </div>
  </AppShell>;
}
