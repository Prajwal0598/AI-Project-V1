"use client";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId, resolveImageUrl } from "../../lib/api";
import type { Category, ImportJob, ImportRow, Product, ProductStatus, Variant } from "../../lib/api";

const STATUS_COLOR: Record<ImportRow["status"], string> = { READY: "#237a52", WARNING: "#8a6a1f", ERROR: "#b94940" };

const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = { DRAFT: "Draft", PUBLISHED: "Published", HIDDEN: "Hidden" };
const PRODUCT_STATUS_COLOR: Record<ProductStatus, string> = { DRAFT: "#8a6a1f", PUBLISHED: "#237a52", HIDDEN: "#777484" };

const LOW_STOCK_THRESHOLD = 5;

interface VariantEdit { sku: string; price: string; inventory: string; active: boolean }

function defaultVariant(p: Product): Variant | undefined {
  return p.variants[0];
}

function isOutOfStock(p: Product): boolean {
  const v = defaultVariant(p);
  return v ? v.inventory === 0 : false;
}

function isLowStock(p: Product): boolean {
  const v = defaultVariant(p);
  return v ? v.inventory !== null && v.inventory > 0 && v.inventory <= LOW_STOCK_THRESHOLD : false;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [sku, setSku] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
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
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editBrand, setEditBrand] = useState("");
  const [editStatus, setEditStatus] = useState<ProductStatus>("PUBLISHED");
  const [editVariants, setEditVariants] = useState<Record<string, VariantEdit>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProductStatus | "ALL">("ALL");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");

  // bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // category management
  const [showCategories, setShowCategories] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function loadProducts() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.products.list(bizId).then(setProducts).catch(console.error).finally(() => setLoading(false));
  }

  function loadCategories() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.categories.list(bizId).then(setCategories).catch(console.error);
  }

  useEffect(() => { loadProducts(); loadCategories(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (statusFilter !== "ALL" && p.status !== statusFilter) return false;
      if (categoryFilter !== "ALL" && (p.category?.id ?? "") !== categoryFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !defaultVariant(p)?.sku?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, statusFilter, categoryFilter]);

  const summary = useMemo(() => ({
    total: products.length,
    published: products.filter(p => p.status === "PUBLISHED").length,
    draft: products.filter(p => p.status === "DRAFT").length,
    lowStock: products.filter(isLowStock).length,
    outOfStock: products.filter(isOutOfStock).length,
  }), [products]);

  const allVisibleSelected = filtered.length > 0 && filtered.every(p => selected.has(p.id));

  function toggleSelectAll() {
    setSelected(prev => {
      if (allVisibleSelected) return new Set();
      return new Set(filtered.map(p => p.id));
    });
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function applyBulk(action: "publish" | "hide" | "draft" | "delete" | "setCategory") {
    const bizId = getBusinessId();
    if (!bizId || !selected.size) return;
    if (action === "delete" && !confirm(`Delete ${selected.size} product(s)? This cannot be undone.`)) return;
    if (action === "setCategory" && !bulkCategoryId) { setError("Choose a category first."); return; }
    setBulkBusy(true);
    try {
      const category = action === "setCategory" ? categories.find(c => c.id === bulkCategoryId)?.name : undefined;
      await api.products.bulk(bizId, { productIds: [...selected], action, category });
      setSelected(new Set());
      loadProducts();
      loadCategories();
    } catch (err) { setError(err instanceof Error ? err.message : "Bulk action failed."); }
    finally { setBulkBusy(false); }
  }

  async function add() {
    const bizId = getBusinessId();
    if (!name || !price || !bizId) return;
    setSaving(true);
    try {
      const categoryName = categories.find(c => c.id === newCategoryId)?.name;
      const product = await api.products.create(bizId, { name: name.trim(), price: parseFloat(price), sku: sku.trim() || undefined, category: categoryName });
      setProducts(prev => [product, ...prev]);
      setName(""); setPrice(""); setSku(""); setNewCategoryId(""); setShow(false);
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
    setEditCategoryId(p.category?.id ?? "");
    setEditBrand(p.brand ?? "");
    setEditStatus(p.status);
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
      const categoryName = categories.find(c => c.id === editCategoryId)?.name ?? "";
      const updatedProduct = await api.products.update(editingProduct.id, {
        name: editName.trim(),
        description: editDescription.trim(),
        category: categoryName,
        brand: editBrand.trim(),
        status: editStatus,
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
      loadCategories();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save product changes."); }
    finally { setSavingEdit(false); }
  }

  async function deleteProduct() {
    if (!editingProduct) return;
    if (!confirm(`Delete "${editingProduct.name}"? This cannot be undone.`)) return;
    setDeletingProduct(true);
    try {
      await api.products.remove(editingProduct.id);
      setProducts(prev => prev.filter(p => p.id !== editingProduct.id));
      setEditingProduct(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not delete product."); }
    finally { setDeletingProduct(false); }
  }

  async function addCategory() {
    const bizId = getBusinessId();
    if (!bizId || !newCategoryName.trim()) return;
    try {
      const created = await api.categories.create(bizId, { name: newCategoryName.trim() });
      setCategories(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewCategoryName("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create category."); }
  }

  function startRename(c: Category) {
    setRenamingCategoryId(c.id);
    setRenameValue(c.name);
  }

  async function saveRename() {
    if (!renamingCategoryId || !renameValue.trim()) return;
    try {
      const updated = await api.categories.update(renamingCategoryId, { name: renameValue.trim() });
      setCategories(prev => prev.map(c => (c.id === updated.id ? { ...c, name: updated.name } : c)));
      setRenamingCategoryId(null);
      loadProducts();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not rename category."); }
  }

  async function removeCategory(c: Category) {
    if (!confirm(`Delete category "${c.name}"?`)) return;
    try {
      await api.categories.remove(c.id);
      setCategories(prev => prev.filter(x => x.id !== c.id));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not delete category."); }
  }

  return <AppShell title="Products" subtitle="Give your AI agent accurate products, pricing, and availability." action={
    <div style={{ display: "flex", gap: 8 }}>
      <button onClick={() => setShowCategories(true)}>Manage categories</button>
      <button onClick={() => setShowImport(true)}>Import Product Catalogue</button>
      <button className="primary-button" onClick={() => setShow(true)}>+ Add product</button>
    </div>
  }>
    {error && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{error} <button onClick={() => setError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}
    {commitSummary && <div style={{ background: "#eefaf3", border: "1px solid #bfe8d3", color: "#237a52", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>
      ✓ Import complete — {commitSummary.created} created, {commitSummary.updated} updated, {commitSummary.skipped} skipped. New products were imported as <strong>Draft</strong> — publish them below once you've reviewed them.
      <button onClick={() => setCommitSummary(null)} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button>
    </div>}

    <div className="metric-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
      <article className="metric-card"><p>Total products</p><h2>{summary.total}</h2></article>
      <article className="metric-card"><p>Published</p><h2>{summary.published}</h2></article>
      <article className="metric-card"><p>Draft</p><h2>{summary.draft}</h2></article>
      <article className="metric-card"><p>Low stock</p><h2>{summary.lowStock}</h2></article>
      <article className="metric-card"><p>Out of stock</p><h2>{summary.outOfStock}</h2></article>
    </div>

    {showCategories && <div className="data-card" style={{ marginBottom: 16, padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>Manage categories</h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input placeholder="New category name" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} style={{ flex: 1 }} />
        <button className="primary-button" onClick={addCategory} disabled={!newCategoryName.trim()}>Add category</button>
      </div>
      {categories.length === 0 && <p style={{ color: "var(--muted)", fontSize: 12 }}>No categories yet.</p>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <tbody>
          {categories.map(c => (
            <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 6 }}>
                {renamingCategoryId === c.id
                  ? <input value={renameValue} onChange={e => setRenameValue(e.target.value)} style={{ width: 180 }} autoFocus />
                  : c.name}
              </td>
              <td style={{ padding: 6, color: "var(--muted)" }}>{c.productCount} product{c.productCount === 1 ? "" : "s"}</td>
              <td style={{ padding: 6, textAlign: "right" }}>
                {renamingCategoryId === c.id
                  ? <><button onClick={saveRename} style={{ marginRight: 6 }}>Save</button><button onClick={() => setRenamingCategoryId(null)}>Cancel</button></>
                  : <><button onClick={() => startRename(c)} style={{ marginRight: 6 }}>Rename</button><button onClick={() => removeCategory(c)}>Delete</button></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12 }}><button onClick={() => setShowCategories(false)}>Close</button></div>
    </div>}

    {show && <div className="inline-form">
      <input placeholder="Product name" value={name} onChange={e => setName(e.target.value)} />
      <input placeholder="SKU (optional)" value={sku} onChange={e => setSku(e.target.value)} />
      <input placeholder="Price in INR" value={price} onChange={e => setPrice(e.target.value)} />
      <select value={newCategoryId} onChange={e => setNewCategoryId(e.target.value)}>
        <option value="">No category</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
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
          <select value={editCategoryId} onChange={e => setEditCategoryId(e.target.value)} style={{ width: "100%" }}>
            <option value="">No category</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Brand
          <input value={editBrand} onChange={e => setEditBrand(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>Status
          <select value={editStatus} onChange={e => setEditStatus(e.target.value as ProductStatus)} style={{ width: "100%" }}>
            <option value="DRAFT">Draft — hidden while you finish setup</option>
            <option value="PUBLISHED">Published — visible to customers</option>
            <option value="HIDDEN">Hidden — temporarily unavailable</option>
          </select>
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

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary-button" onClick={saveEdit} disabled={savingEdit || !editName.trim()}>{savingEdit ? "Saving…" : "Save changes"}</button>
          <button onClick={() => setEditingProduct(null)}>Cancel</button>
        </div>
        <button onClick={deleteProduct} disabled={deletingProduct} style={{ color: "#b94940" }}>{deletingProduct ? "Deleting…" : "Delete product"}</button>
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

    <div className="filter-row" style={{ marginBottom: 12 }}>
      <input placeholder="Search by name or SKU…" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 220 }} />
      <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as ProductStatus | "ALL")}>
        <option value="ALL">All statuses</option>
        <option value="PUBLISHED">Published</option>
        <option value="DRAFT">Draft</option>
        <option value="HIDDEN">Hidden</option>
      </select>
      <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
        <option value="ALL">All categories</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <span>{filtered.length} of {products.length} products</span>
    </div>

    {selected.size > 0 && <div className="data-card" style={{ marginBottom: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <strong style={{ fontSize: 12 }}>{selected.size} selected</strong>
      <button disabled={bulkBusy} onClick={() => applyBulk("publish")}>Publish</button>
      <button disabled={bulkBusy} onClick={() => applyBulk("draft")}>Move to Draft</button>
      <button disabled={bulkBusy} onClick={() => applyBulk("hide")}>Hide</button>
      <select value={bulkCategoryId} onChange={e => setBulkCategoryId(e.target.value)}>
        <option value="">Set category…</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button disabled={bulkBusy || !bulkCategoryId} onClick={() => applyBulk("setCategory")}>Apply category</button>
      <button disabled={bulkBusy} onClick={() => applyBulk("delete")} style={{ color: "#b94940" }}>Delete</button>
      <button disabled={bulkBusy} onClick={() => setSelected(new Set())} style={{ marginLeft: "auto" }}>Clear selection</button>
    </div>}

    <div className="data-card">
      <div className="table-head" style={{ gridTemplateColumns: "28px 46px 1.6fr 1fr .9fr .9fr .9fr .9fr 70px" }}>
        <span><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} /></span>
        <span></span>
        <span>Product</span>
        <span>Category</span>
        <span>Price</span>
        <span>Stock</span>
        <span>Status</span>
        <span>Updated</span>
        <span></span>
      </div>
      {loading && <p style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
      {!loading && filtered.length === 0 && <p style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>No products match these filters.</p>}
      {filtered.map(p => {
        const v = defaultVariant(p);
        const outOfStock = isOutOfStock(p);
        const lowStock = isLowStock(p);
        return <div className="table-row" key={p.id} style={{ gridTemplateColumns: "28px 46px 1.6fr 1fr .9fr .9fr .9fr .9fr 70px" }}>
          <span><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} /></span>
          <span>{p.imageUrl
            ? <img src={resolveImageUrl(p.imageUrl) ?? undefined} alt={p.name} style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} />
            : <div style={{ width: 36, height: 36, borderRadius: 6, background: "#f4f2f8", display: "grid", placeItems: "center", fontSize: 10, color: "var(--muted)" }}>—</div>}
          </span>
          <span>
            <strong>{p.name}</strong>
            {v?.sku && <><br /><small style={{ color: "var(--muted)" }}>SKU: {v.sku}</small></>}
            {p.source === "IMPORT" && <span className="source-chip" style={{ fontSize: 10, marginLeft: 6 }}>Imported</span>}
          </span>
          <span>{p.category?.name ?? "—"}</span>
          <span>{v ? `${v.currency} ${v.price}` : "—"}</span>
          <span>
            {v?.inventory == null ? "Unlimited" : `${v.inventory} in stock`}
            {outOfStock && <><br /><small style={{ color: "#b94940" }}>Out of stock</small></>}
            {!outOfStock && lowStock && <><br /><small style={{ color: "#8a6a1f" }}>Low stock</small></>}
          </span>
          <span><span className="stage-chip" style={{ color: PRODUCT_STATUS_COLOR[p.status] }}>{PRODUCT_STATUS_LABEL[p.status]}</span></span>
          <span><small style={{ color: "var(--muted)" }}>{fmtDate(p.updatedAt)}</small></span>
          <span><button onClick={() => openEdit(p)}>Edit</button></span>
        </div>;
      })}
    </div>
  </AppShell>;
}
