"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getBusinessId } from "../lib/api";
import type { BusinessStats } from "../lib/api";

const navItems = [
  ["Overview", "grid"],
  ["Leads", "spark"],
  ["Inbox", "inbox"],
  ["Customers", "users"],
  ["Automations", "bolt"],
  ["Analytics", "chart"]
];

const activity = [
  { name: "Priya Shah", detail: "Asked about the annual plan", channel: "WA", time: "2 min", color: "peach", status: "Hot lead" },
  { name: "Rohan Mehta", detail: "Payment link sent by AI", channel: "IG", time: "18 min", color: "lavender", status: "In progress" },
  { name: "Ananya Iyer", detail: "Booked a product demo", channel: "✉", time: "43 min", color: "mint", status: "Qualified" },
  { name: "Karan Patel", detail: "Replied to a follow-up", channel: "WA", time: "1 hr", color: "sky", status: "Engaged" }
];

function Glyph({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    spark: <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>,
    inbox: <><path d="M4 5h16v14H4z"/><path d="M4 14h5l1.5 2h3L15 14h5"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.5-3.2 2.2-5 5.5-5s5 1.8 5.5 5M16 5.5a3 3 0 0 1 0 5M17 15c2.1.2 3.3 1.8 3.7 4.3"/></>,
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l0-7Z"/>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function Home() {
  const [active, setActive] = useState("Overview");
  const [period, setPeriod] = useState("This week");
  const [apiState, setApiState] = useState<"checking" | "online" | "offline">("checking");
  const [stats, setStats] = useState<BusinessStats | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("relay_token")) router.replace("/login");
  }, [router]);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.businesses.stats(bizId).then(setStats).catch(console.error);
  }, []);

  useEffect(() => {
    async function connect() {
      try {
        const health = await fetch(`${apiUrl}/health`);
        if (!health.ok) throw new Error("API unavailable");
        setApiState("online");
      } catch {
        setApiState("offline");
      }
    }
    void connect();
  }, [apiUrl]);

  async function createWorkspace() {
    setCreatingWorkspace(true);
    try {
      const response = await fetch(`${apiUrl}/businesses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Prajwal Studio" }) });
      setApiState("online");
    } catch {
      setApiState("offline");
    } finally {
      setCreatingWorkspace(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">r</span><span>relay</span></div>
        <nav aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {navItems.map(([label, icon]) => (
            <button className={`nav-item ${active === label ? "active" : ""}`} key={label} onClick={() => setActive(label)}>
              <Glyph name={icon} /><span>{label}</span>{label === "Inbox" && <b>8</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="upgrade-card"><span>✦</span><div><strong>Unlock more with AI</strong><small>Upgrade your workspace</small></div><i>›</i></button>
          <button className="profile"><span className="avatar avatar-small">PS</span><span><strong>Prajwal Studio</strong><small>Growth plan</small></span><i>⌄</i></button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <button className="crumb"><span className="tiny-mark">r</span> Prajwal Studio <i>⌄</i></button>
          <div className="top-actions"><button className="icon-button" aria-label="Search">⌕</button><button className="icon-button notification" aria-label="Notifications">♧<em /></button><button className="help">?</button></div>
        </header>

        <div className="page">
          <div className="heading-row">
            <div><p className="eyebrow">Monday, 10 August</p><h1>Good morning, Prajwal <span>✦</span></h1><p className="subheading">Here’s how your AI sales team is performing.</p></div>
            <button className="primary-button"><span>＋</span> Create automation</button>
          </div>
          <p className={`api-status ${apiState}`}><i /> {apiState === "checking" ? "Connecting to your API…" : apiState === "online" ? "API connected" : "API offline — start the backend to enable live data"}</p>

          <div className="metric-grid">
            <article className="metric-card"><div className="metric-header"><span className="metric-icon peach">✦</span><button>•••</button></div><p>New leads</p><h2>{stats?.leads ?? "—"}</h2></article>
            <article className="metric-card"><div className="metric-header"><span className="metric-icon purple">◌</span><button>•••</button></div><p>Conversations</p><h2>{stats?.conversations ?? "—"}</h2></article>
            <article className="metric-card"><div className="metric-header"><span className="metric-icon blue">↗</span><button>•••</button></div><p>Orders</p><h2>{stats?.orders ?? "—"}</h2></article>
            <article className="metric-card revenue"><div className="metric-header"><span className="metric-icon yellow">₹</span><button>•••</button></div><p>Revenue (paid orders)</p><h2>{stats ? (Number(stats.revenue) >= 100000 ? `₹${(Number(stats.revenue) / 100000).toFixed(2)}L` : `₹${Number(stats.revenue).toLocaleString("en-IN")}`) : "—"}</h2></article>
          </div>

          <div className="dashboard-grid">
            <article className="card performance-card">
              <div className="card-heading"><div><h3>Sales performance</h3><p>Revenue generated by your AI agent</p></div><button className="select" onClick={() => setPeriod(period === "This week" ? "Last week" : "This week")}>{period} <i>⌄</i></button></div>
              <div className="chart-wrap"><div className="chart-y"><span>₹5L</span><span>₹4L</span><span>₹3L</span><span>₹2L</span><span>₹1L</span><span>₹0</span></div><div className="chart"><div className="gridlines"/><svg className="line-chart" viewBox="0 0 620 198" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#8267df" stopOpacity=".26"/><stop offset="1" stopColor="#8267df" stopOpacity="0"/></linearGradient></defs><path d="M0 168 C40 152 44 141 77 148 S118 153 139 136 S168 109 200 125 S237 158 263 142 S295 111 324 118 S353 142 385 120 S421 78 449 98 S486 139 511 100 S548 47 574 66 S600 92 620 31 L620 198 L0 198Z" fill="url(#fill)"/><path d="M0 168 C40 152 44 141 77 148 S118 153 139 136 S168 109 200 125 S237 158 263 142 S295 111 324 118 S353 142 385 120 S421 78 449 98 S486 139 511 100 S548 47 574 66 S600 92 620 31" fill="none" stroke="#7961d5" strokeWidth="3"/></svg><div className="chart-labels"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div></div></div>
              <div className="chart-summary"><div><span className="dot purple-dot"/> Revenue <strong>₹4,82,300</strong></div><span>+22.8% <b>from last week</b></span></div>
            </article>

            <article className="card agent-card"><div className="agent-orb"><span>✦</span></div><p className="live"><i /> AI agent is active</p><h3>Your agent is on it.</h3><p className="agent-copy">It’s currently managing 42 conversations and has sent 86 follow-ups today.</p><div className="agent-list"><div><span className="round-icon">✉</span><p><strong>18 conversations</strong><small>are waiting for a reply</small></p><button>Review</button></div><div><span className="round-icon pink">♨</span><p><strong>7 hot leads</strong><small>need your attention</small></p><button>View</button></div></div><button className="agent-button">View agent activity <span>→</span></button></article>
          </div>

          <article className="card activity-card"><div className="card-heading"><div><h3>Recent activity</h3><p>What’s happening across your customer channels</p></div><button className="text-button">View all <span>→</span></button></div><div className="activity-list">{activity.map((item) => <div className="activity-row" key={item.name}><span className={`avatar ${item.color}`}>{item.name.split(" ").map(part => part[0]).join("")}</span><div className="activity-person"><strong>{item.name}</strong><span>{item.detail}</span></div><span className={`channel ${item.channel === "IG" ? "ig" : ""}`}>{item.channel}</span><span className="activity-status">{item.status}</span><time>{item.time}</time><button className="more">•••</button></div>)}</div></article>
        </div>
      </section>
    </main>
  );
}
