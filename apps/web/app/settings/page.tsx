"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Business } from "../../lib/api";

export default function SettingsPage() {
  const [biz, setBiz] = useState<Business | null>(null);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.businesses.get(bizId).then(b => {
      setBiz(b);
      setName(b.name);
      setTimezone(b.timezone);
      setWaPhoneId(b.whatsappPhoneNumberId ?? "");
    }).catch(console.error);
  }, []);

  async function save() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setSaving(true); setSaved(false);
    try {
      const updated = await api.businesses.update(bizId, {
        name: name.trim(),
        timezone: timezone.trim(),
        whatsappPhoneNumberId: waPhoneId.trim() || null,
      });
      setBiz(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { console.error(err); }
    finally { setSaving(false); }
  }

  return <AppShell title="Settings" subtitle="Manage your workspace, channels, and AI controls.">
    <section className="settings-section">
      <h2>Business profile</h2>
      <p>This information is used by the AI agent to personalise replies.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field"><label>Business name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Acme Store" /></div>
        <div className="login-field"><label>Timezone</label><input value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="Asia/Kolkata" /></div>
        {saved && <p style={{ color: "var(--green)", fontSize: 12, marginBottom: 10 }}>✓ Saved</p>}
        <button className="primary-button" onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>WhatsApp configuration</h2>
      <p>Required for the webhook to route inbound messages to your workspace.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Phone Number ID</label>
          <input value={waPhoneId} onChange={e => setWaPhoneId(e.target.value)} placeholder="Numeric ID from Meta Developer Console" />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Set <code>WHATSAPP_ACCESS_TOKEN</code> and <code>WHATSAPP_VERIFY_TOKEN</code> in your <code>.env</code> file — tokens are never stored in the database.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Connected channels</h2>
      <p>Only connect accounts that your business owns and has permission to use.</p>
      <div className="integration-list">
        {[{ name: "WhatsApp Business", copy: `Phone Number ID: ${biz?.whatsappPhoneNumberId ?? "not set"}`, connected: !!biz?.whatsappPhoneNumberId }, { name: "Instagram", copy: "Manage business DMs and comments", connected: false }, { name: "Email", copy: "Send and receive from your business domain", connected: false }, { name: "OpenAI", copy: "AI reply drafts are active", connected: true }].map(item => (
          <article key={item.name}><span>{item.name[0]}</span><div><h3>{item.name}</h3><p>{item.copy}</p></div><button className={item.connected ? "connected" : "connect"}>{item.connected ? "Connected" : "Connect"}</button></article>
        ))}
      </div>
    </section>

    <section className="settings-section">
      <h2>AI autonomy</h2>
      <p>Draft mode keeps people in control while you set up the workspace.</p>
      <div className="autonomy"><strong>Draft only</strong><span>AI can analyse conversations and create replies. A human must approve every outbound message.</span><button className="selected-mode">Current mode</button></div>
    </section>
  </AppShell>;
}
