"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { getToken } from "../lib/api";

const items = [
  ["Overview", "/", "O"],
  ["Leads", "/leads", "L"],
  ["Inbox", "/inbox", "I"],
  ["Products", "/products", "P"],
  ["Orders", "/orders", "R"],
  ["Automations", "/automations", "A"],
  ["Analytics", "/analytics", "G"],
  ["Settings", "/settings", "S"]
];

export function AppShell({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => { if (!getToken()) router.replace("/login"); }, [router]);
  return <main className="app-shell">
    <aside className="app-sidebar">
      <Link className="app-brand" href="/"><span>r</span>relay</Link>
      <p className="app-section-label">Workspace</p>
      <nav>{items.map(([label, href, mark]) => <Link key={href} href={href} className={`app-nav-link ${pathname === href ? "selected" : ""}`}><b>{mark}</b>{label}{label === "Inbox" && <i>8</i>}</Link>)}</nav>
      <div className="app-sidebar-footer"><div className="app-upgrade"><strong>AI sales agent</strong><small>Draft mode is active</small></div><Link href="/settings" className="app-account"><span>PS</span><div><strong>Prajwal Studio</strong><small>Growth plan</small></div></Link></div>
    </aside>
    <section className="app-main"><header className="app-topbar"><span>Workspace / Prajwal Studio</span><div><span className="app-live-dot" /> API connected <button aria-label="Help">?</button></div></header><div className="screen-page"><div className="screen-heading"><div><p>Relay command center</p><h1>{title}</h1><span>{subtitle}</span></div>{action}</div>{children}</div></section>
  </main>;
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">+</div><h2>{title}</h2><p>{copy}</p>{action}</div>;
}
