"use client";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { ConversationSummary, ConversationDetail, Message } from "../../lib/api";

function customerName(c: { firstName: string | null; lastName: string | null; phone: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Unknown";
}
function timeAgo(d: string | null) {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}
function fmtTime(d: string) {
  return new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
const CHANNEL_BADGE: Record<string, string> = { WHATSAPP: "WA", INSTAGRAM: "IG", EMAIL: "✉", WEB: "W", MANUAL: "M" };

export default function InboxPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationDetail | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [aiReplying, setAiReplying] = useState(false);
  const [error, setError] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);

  // auto-scroll to latest message
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [selected?.messages.length]);

  function loadList() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.conversations.list(bizId).then(setConversations).catch(console.error);
  }

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.conversations.list(bizId)
      .then(setConversations)
      .catch(console.error)
      .finally(() => setLoading(false));

    // poll every 5 s so inbound WhatsApp messages appear without a manual refresh
    const interval = setInterval(loadList, 5000);
    return () => clearInterval(interval);
  }, []);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.id ?? null;

  // silently refresh the open conversation so inbound replies appear
  useEffect(() => {
    const interval = setInterval(() => {
      const id = selectedIdRef.current;
      if (!id) return;
      api.conversations.get(id)
        .then(detail => setSelected(prev => prev?.id === id ? detail : prev))
        .catch(console.error);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  async function selectConv(id: string) {
    const detail = await api.conversations.get(id).catch(console.error);
    if (detail) setSelected(detail);
  }

  async function send() {
    if (!selected || !input.trim() || sending) return;
    setSending(true); setError("");
    try {
      const msg = await api.conversations.send(selected.id, input.trim());
      setSelected(prev => prev ? { ...prev, messages: [...prev.messages, msg] } : null);
      setInput("");
      loadList();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to send message."); }
    finally { setSending(false); }
  }

  async function generateAiReply() {
    if (!selected || aiReplying) return;
    setAiReplying(true); setError("");
    try {
      const result = await api.conversations.aiDraft(selected.id);
      if (result.message) {
        setSelected(prev => prev ? { ...prev, messages: [...prev.messages, result.message!] } : null);
      } else {
        // the AI stayed silent (e.g. this conversation was just escalated) — refresh to pick up the new state
        const refreshed = await api.conversations.get(selected.id);
        setSelected(refreshed);
        if (refreshed.escalated) setError("This conversation has been escalated to a human — the AI will stay quiet until you resume it.");
      }
      if (result.orderCreated) {
        setError(`✓ Order created — ${result.orderCreated.currency} ${result.orderCreated.total} (#${result.orderCreated.id.slice(-8).toUpperCase()})`);
      }
      loadList();
    } catch (err) { setError(err instanceof Error ? err.message : "AI could not generate a reply."); }
    finally { setAiReplying(false); }
  }

  async function resumeAi() {
    if (!selected) return;
    try {
      const updated = await api.conversations.resume(selected.id);
      setSelected(prev => prev ? { ...prev, escalated: updated.escalated, escalationReason: updated.escalationReason } : null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not resume the AI."); }
  }

  async function changeOutcome(outcome: ConversationSummary["outcome"]) {
    if (!selected) return;
    try {
      const updated = await api.conversations.setOutcome(selected.id, outcome);
      setSelected(prev => prev ? { ...prev, outcome: updated.outcome } : null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update the outcome label."); }
  }

  const visibleMessages = (selected?.messages ?? []).filter(
    m => ((m.metadata as { state?: string } | null)?.state ?? "").toLowerCase() !== "draft"
  );

  return <AppShell title="Inbox" subtitle="One place for every customer conversation.">
    <div className="inbox-layout">
      <aside className="conversation-list">
        <div className="inbox-search">Conversations</div>
        {loading && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>Loading…</p>}
        {!loading && conversations.length === 0 && <p style={{ padding: "16px", color: "var(--muted)", fontSize: 12 }}>No conversations yet.</p>}
        {conversations.map(c => (
          <button key={c.id} className={selected?.id === c.id ? "conversation selected" : "conversation"} onClick={() => selectConv(c.id)}>
            <b>{customerName(c.customer).slice(0, 2).toUpperCase()}</b>
            <span>
              <strong>{customerName(c.customer)} <span className={`channel ${c.channel === "INSTAGRAM" ? "ig" : ""}`} style={{ fontSize: 8, verticalAlign: "middle" }}>{CHANNEL_BADGE[c.channel] ?? c.channel}</span></strong>
              <small>{c.messages[0]?.content.slice(0, 48) ?? c.channel}</small>
            </span>
            <time>{timeAgo(c.lastMessageAt)}</time>
          </button>
        ))}
      </aside>
      <section className="conversation-panel">
        {!selected
          ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--muted)", fontSize: 13 }}>Select a conversation</div>
          : <>
            <header>
              <div>
                <b>{customerName(selected.customer)}</b>
                <small><i /> {selected.channel}</small>
              </div>
              <select value={selected.outcome} onChange={e => changeOutcome(e.target.value as ConversationSummary["outcome"])} className="filter-button" style={{ fontSize: 11 }}>
                <option value="OPEN">Open</option>
                <option value="SALE">Sale</option>
                <option value="SUPPORT">Support</option>
                <option value="ESCALATED">Escalated</option>
                <option value="LOST">Lost</option>
                <option value="ABANDONED">Abandoned</option>
              </select>
              <button className="filter-button">Customer profile</button>
            </header>
            {selected.escalated && (
              <div style={{ background: "#fff8e8", border: "1px solid #f3dfa8", color: "#8a6a1f", fontSize: 12, padding: "8px 14px", margin: "0 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>⚠ Escalated to a human{selected.escalationReason ? ` — ${selected.escalationReason}` : ""}. The AI won't reply until you resume it.</span>
                <button onClick={resumeAi} style={{ textDecoration: "underline", fontWeight: 600 }}>Resume AI</button>
              </div>
            )}
            {error && <div style={{ background: error.startsWith("✓") ? "#eefaf3" : "#fff3f2", border: `1px solid ${error.startsWith("✓") ? "#bfe8d3" : "#fcd9d6"}`, color: error.startsWith("✓") ? "#237a52" : "#b94940", fontSize: 12, padding: "8px 14px", margin: "0 16px" }}>{error} <button onClick={() => setError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}
            <div className="message-stream" ref={streamRef}>
              {visibleMessages.map((m: Message) => (
                <div key={m.id} className={`bubble ${m.direction === "OUTBOUND" ? "outbound" : "inbound"}`}>
                  {m.content}
                  <time style={{ display: "block", fontSize: 10, opacity: 0.55, marginTop: 4 }}>{fmtTime(m.sentAt)}</time>
                </div>
              ))}
            </div>
            <footer>
              <button className="ai-draft-button" onClick={generateAiReply} disabled={aiReplying || selected.escalated}>
                {aiReplying ? "AI replying…" : selected.escalated ? "AI paused (escalated)" : "Generate AI reply"}
              </button>
              <input placeholder="Reply to customer…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} />
              <button className="send-button" onClick={send} disabled={sending || !input.trim()}>Send</button>
            </footer>
          </>
        }
      </section>
    </div>
  </AppShell>;
}
