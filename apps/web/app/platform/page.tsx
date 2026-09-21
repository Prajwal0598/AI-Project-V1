"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { api } from "../../lib/api";
import type { Me, PlatformOverview, PlatformBusiness } from "../../lib/api";

function fmtRevenue(v: string | number) {
  const n = Number(v ?? 0);
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

export default function PlatformAdminPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [businesses, setBusinesses] = useState<PlatformBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.auth.me().then(setMe).catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    if (!me?.isPlatformAdmin) return;
    Promise.all([api.platformAdmin.overview(), api.platformAdmin.businesses()])
      .then(([o, b]) => { setOverview(o); setBusinesses(b); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load platform data."))
      .finally(() => setLoading(false));
  }, [me]);

  if (me && !me.isPlatformAdmin) {
    return <AppShell title="Platform" subtitle="Cross-business overview, for internal use only.">
      <p style={{ color: "var(--muted)", fontSize: 13 }}>You don&apos;t have access to this page.</p>
    </AppShell>;
  }

  return <AppShell title="Platform" subtitle="Order values, revenue, and merchants across every business on Relay.">
    {error && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{error}</div>}
    {loading && <p style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</p>}

    {overview && <div className="metric-grid">
      <article className="metric-card"><p>Merchants</p><h2>{overview.merchants}</h2></article>
      <article className="metric-card"><p>Total orders</p><h2>{overview.orders}</h2></article>
      <article className="metric-card revenue"><p>Total revenue (paid orders)</p><h2>{fmtRevenue(overview.revenue)}</h2></article>
      <article className="metric-card"><p>Customers</p><h2>{overview.customers}</h2></article>
    </div>}

    {!loading && <div style={{ marginTop: 20, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: 6 }}>Merchant</th>
            <th style={{ padding: 6 }}>Industry</th>
            <th style={{ padding: 6 }}>Onboarded</th>
            <th style={{ padding: 6 }}>WhatsApp</th>
            <th style={{ padding: 6 }}>Instagram</th>
            <th style={{ padding: 6 }}>Orders</th>
            <th style={{ padding: 6 }}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {businesses.map((b) => (
            <tr key={b.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 6 }}>{b.name}</td>
              <td style={{ padding: 6 }}>{b.industry ?? "—"}</td>
              <td style={{ padding: 6 }}>{new Date(b.createdAt).toLocaleDateString()}</td>
              <td style={{ padding: 6 }}>{b.whatsappConnected ? "✓" : "—"}</td>
              <td style={{ padding: 6 }}>{b.instagramConnected ? "✓" : "—"}</td>
              <td style={{ padding: 6 }}>{b.orders}</td>
              <td style={{ padding: 6 }}>{fmtRevenue(b.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!businesses.length && <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 12 }}>No merchants onboarded yet.</p>}
    </div>}
  </AppShell>;
}
