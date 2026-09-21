"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, getBusinessId, getToken, getRefreshToken, clearToken } from "../lib/api";

const items = [
  ["Overview", "/", "O"],
  ["Leads", "/leads", "L"],
  ["Inbox", "/inbox", "I"],
  ["Suggestions", "/suggestions", "✦"],
  ["Products", "/products", "P"],
  ["Orders", "/orders", "R"],
  ["Promotions", "/promotions", "%"],
  ["Analytics", "/analytics", "G"],
  ["Settings", "/settings", "S"]
];

export function AppShell({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [openConversations, setOpenConversations] = useState<number | null>(null);
  const [ordersNeedingAction, setOrdersNeedingAction] = useState<number | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => { if (!getToken()) router.replace("/login"); }, [router]);

  useEffect(() => {
    api.auth.me().then((me) => setIsPlatformAdmin(me.isPlatformAdmin)).catch(() => {});
  }, []);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    const load = () => api.businesses.stats(bizId).then((s) => {
      setOpenConversations(s.openConversations);
      setOrdersNeedingAction(s.ordersNeedingAction);
    }).catch(() => {});
    load();
    // poll so the sidebar badges stay in sync with new inbound conversations/orders without a manual refresh
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  async function logout() {
    const refreshToken = getRefreshToken();
    try { if (refreshToken) await api.auth.logout(refreshToken); } catch { /* best-effort — clear the local session regardless */ }
    clearToken();
    router.replace("/login");
  }

  return <main className="app-shell">
    <aside className="app-sidebar">
      <Link className="app-brand" href="/"><span>r</span>relay</Link>
      <p className="app-section-label">Workspace</p>
      <nav>{items.map(([label, href, mark]) => <Link key={href} href={href} className={`app-nav-link ${pathname === href ? "selected" : ""}`}><b>{mark}</b>{label}{label === "Inbox" && !!openConversations && <i>{openConversations}</i>}{label === "Orders" && !!ordersNeedingAction && <i>{ordersNeedingAction}</i>}</Link>)}
      {isPlatformAdmin && <Link href="/platform" className={`app-nav-link ${pathname === "/platform" ? "selected" : ""}`}><b>⚙</b>Platform</Link>}
      </nav>
      <div className="app-sidebar-footer"><div className="app-upgrade"><strong>AI sales agent</strong><small>Auto-reply is active</small></div><Link href="/settings" className="app-account"><span>PS</span><div><strong>Prajwal Studio</strong><small>Growth plan</small></div></Link><button className="app-logout" onClick={logout}>Log out</button></div>
    </aside>
    <section className="app-main"><header className="app-topbar"><span>Workspace / Prajwal Studio</span><div><button aria-label="Help">?</button></div></header><div className="screen-page"><div className="screen-heading"><div><p>Relay command center</p><h1>{title}</h1><span>{subtitle}</span></div>{action}</div>{children}</div></section>
  </main>;
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">+</div><h2>{title}</h2><p>{copy}</p>{action}</div>;
}
