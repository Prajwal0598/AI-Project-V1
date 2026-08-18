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
  const [draft, setDraft] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
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
  }, []);

  async function selectConv(id: string) {
    setDraft("");
    const detail = await api.conversations.get(id).catch(console.error);
    if (detail) setSelected(detail);
  }

  async function send() {
    if (!selected || !input.trim() || sending) return;
    setSending(true);
    try {
      const msg = await api.conversations.send(selected.id, input.trim());
      setSelected(prev => prev ? { ...prev, messages: [...prev.messages, msg] } : null);
      setInput("");
      loadList();
    } catch (err) { console.error(err); }
    finally { setSending(false); }
  }

  async function generateDraft() {
    if (!selected || draftLoading) return;
    setDraftLoading(true);
    try {
      const msg = await api.conversations.aiDraft(selected.id);
      setDraft(msg.content);
    } catch (err) { console.error(err); }
    finally { setDraftLoading(false); }
  }

  async function approveDraft() {
    if (!selected || !draft || sending) return;
    setSending(true);
    try {
      const msg = await api.conversations.send(selected.id, draft);
      setSelected(prev => prev ? { ...prev, messages: [...prev.messages, msg] } : null);
      setDraft("");
    } catch (err) { console.error(err); }
    finally { setSending(false); }
  }

  const visibleMessages = (selected?.messages ?? []).filter(
    m => (m.metadata as { state?: string } | null)?.state !== "draft"
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
              <button className="filter-button">Customer profile</button>
            </header>
            <div className="message-stream" ref={streamRef}>
              {visibleMessages.map((m: Message) => (
                <div key={m.id} className={`bubble ${m.direction === "OUTBOUND" ? "outbound" : "inbound"}`}>
                  {m.content}
                  <time style={{ display: "block", fontSize: 10, opacity: 0.55, marginTop: 4 }}>{fmtTime(m.sentAt)}</time>
                </div>
              ))}
              {draft && <div className="ai-draft">
                <span>AI draft</span>
                <p>{draft}</p>
                <button className="primary-button" onClick={approveDraft} disabled={sending}>Approve &amp; send</button>
                <button onClick={() => setDraft("")}>Discard</button>
              </div>}
            </div>
            <footer>
              <button className="ai-draft-button" onClick={generateDraft} disabled={draftLoading}>
                {draftLoading ? "Generating…" : "Generate AI draft"}
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
