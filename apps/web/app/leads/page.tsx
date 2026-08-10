"use client";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";

const startingLeads = [
  { name: "Aarav Kapoor", source: "Instagram", intent: 92, stage: "Ready to buy", activity: "Asked about pricing", initials: "AK" },
  { name: "Maya Iyer", source: "Website", intent: 78, stage: "Qualified", activity: "Downloaded catalogue", initials: "MI" },
  { name: "Dev Malhotra", source: "WhatsApp", intent: 66, stage: "In conversation", activity: "Replied 18 min ago", initials: "DM" },
  { name: "Nisha Verma", source: "Email", intent: 45, stage: "New lead", activity: "Opened campaign", initials: "NV" }
];

export default function LeadsPage() {
  const [leads, setLeads] = useState(startingLeads);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const filtered = useMemo(() => leads.filter((lead) => lead.name.toLowerCase().includes(query.toLowerCase()) || lead.source.toLowerCase().includes(query.toLowerCase())), [leads, query]);
  function addLead() { const trimmed = name.trim(); if (!trimmed) return; setLeads([{ name: trimmed, source: "Manual", intent: 30, stage: "New lead", activity: "Added just now", initials: trimmed.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase() }, ...leads]); setName(""); setShowForm(false); }
  return <AppShell title="Leads" subtitle="Prioritise people most likely to become customers." action={<button className="primary-button" onClick={() => setShowForm(true)}>+ Add lead</button>}>
    <div className="filter-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search leads" /><button className="filter-button">All sources</button><button className="filter-button">All stages</button><span>{filtered.length} leads</span></div>
    {showForm && <div className="inline-form"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer name" onKeyDown={(event) => event.key === "Enter" && addLead()} /><button className="primary-button" onClick={addLead}>Save lead</button><button onClick={() => setShowForm(false)}>Cancel</button></div>}
    <div className="data-card lead-table"><div className="table-head"><span>Customer</span><span>Source</span><span>Intent</span><span>Stage</span><span>Latest activity</span></div>{filtered.map((lead) => <div className="table-row" key={lead.name}><div className="person"><b>{lead.initials}</b><strong>{lead.name}</strong></div><span className="source-chip">{lead.source}</span><span className={`intent ${lead.intent > 80 ? "hot" : ""}`}>{lead.intent}/100</span><span className="stage-chip">{lead.stage}</span><span className="activity-copy">{lead.activity}</span></div>)}</div>
  </AppShell>;
}
