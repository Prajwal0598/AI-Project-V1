"use client";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId } from "../../lib/api";
import type { Business, Me, TeamUser } from "../../lib/api";

export default function SettingsPage() {
  const [biz, setBiz] = useState<Business | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePassword, setInvitePassword] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamUser["role"]>("MEMBER");
  const [inviteError, setInviteError] = useState("");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [igPageId, setIgPageId] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [autonomyMaxOrderValue, setAutonomyMaxOrderValue] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [igAccessToken, setIgAccessToken] = useState("");
  const [postmarkToken, setPostmarkToken] = useState("");
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
      setIgPageId(b.instagramPageId ?? "");
      setSupportEmail(b.supportEmail ?? "");
      setAutonomyMaxOrderValue(b.autonomyMaxOrderValue ?? "");
    }).catch(console.error);
    api.auth.me().then(setMe).catch(console.error);
    loadTeam();
  }, []);

  function loadTeam() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.users.list(bizId).then(setTeam).catch(console.error);
  }

  async function invite() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setInviteError("");
    try {
      await api.users.create(bizId, { email: inviteEmail.trim(), password: invitePassword, name: inviteName.trim(), role: inviteRole });
      setInviteEmail(""); setInvitePassword(""); setInviteName(""); setInviteRole("MEMBER");
      loadTeam();
    } catch (err) { setInviteError(err instanceof Error ? err.message : "Could not add teammate."); }
  }

  async function changeRole(userId: string, role: TeamUser["role"]) {
    try {
      await api.users.updateRole(userId, role);
      loadTeam();
    } catch (err) { console.error(err); }
  }

  async function save() {
    const bizId = getBusinessId();
    if (!bizId) return;
    setSaving(true); setSaved(false);
    try {
      const updated = await api.businesses.update(bizId, {
        name: name.trim(),
        timezone: timezone.trim(),
        whatsappPhoneNumberId: waPhoneId.trim() || null,
        instagramPageId: igPageId.trim() || null,
        supportEmail: supportEmail.trim() || null,
        autonomyMaxOrderValue: autonomyMaxOrderValue.trim() ? Number(autonomyMaxOrderValue) : null,
        ...(waAccessToken && { whatsappAccessToken: waAccessToken }),
        ...(igAccessToken && { instagramAccessToken: igAccessToken }),
        ...(postmarkToken && { postmarkServerToken: postmarkToken }),
      });
      setBiz(updated);
      setWaAccessToken(""); setIgAccessToken(""); setPostmarkToken(""); // never keep secrets in the input after saving
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
        <div className="login-field">
          <label>Access token {biz?.whatsappAccessTokenConfigured && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ configured</span>}</label>
          <input type="password" value={waAccessToken} onChange={e => setWaAccessToken(e.target.value)} placeholder={biz?.whatsappAccessTokenConfigured ? "•••••••• (leave blank to keep)" : "Permanent access token from Meta"} />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Stored encrypted per-business. Falls back to <code>WHATSAPP_ACCESS_TOKEN</code> in <code>.env</code> if left unset. <code>WHATSAPP_VERIFY_TOKEN</code>/<code>WHATSAPP_APP_SECRET</code> remain server-side only.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Instagram configuration</h2>
      <p>Required for the webhook to route inbound Instagram DMs to your workspace.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Instagram Page ID</label>
          <input value={igPageId} onChange={e => setIgPageId(e.target.value)} placeholder="Numeric ID from Meta Developer Console" />
        </div>
        <div className="login-field">
          <label>Page access token {biz?.instagramAccessTokenConfigured && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ configured</span>}</label>
          <input type="password" value={igAccessToken} onChange={e => setIgAccessToken(e.target.value)} placeholder={biz?.instagramAccessTokenConfigured ? "•••••••• (leave blank to keep)" : "Page access token from Meta"} />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Stored encrypted per-business. Falls back to <code>INSTAGRAM_PAGE_ACCESS_TOKEN</code> in <code>.env</code> if left unset. <code>INSTAGRAM_VERIFY_TOKEN</code>/<code>INSTAGRAM_APP_SECRET</code> remain server-side only.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Email configuration</h2>
      <p>Required for the webhook to route inbound emails to your workspace.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Support email address</label>
          <input value={supportEmail} onChange={e => setSupportEmail(e.target.value)} placeholder="support@yourbusiness.com" />
        </div>
        <div className="login-field">
          <label>Postmark server token {biz?.postmarkServerTokenConfigured && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ configured</span>}</label>
          <input type="password" value={postmarkToken} onChange={e => setPostmarkToken(e.target.value)} placeholder={biz?.postmarkServerTokenConfigured ? "•••••••• (leave blank to keep)" : "Server token from Postmark"} />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Stored encrypted per-business. Falls back to <code>POSTMARK_SERVER_TOKEN</code> in <code>.env</code> if left unset. <code>EMAIL_FROM</code>/<code>EMAIL_WEBHOOK_SECRET</code> remain server-side only.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Team</h2>
      <p>Owners and admins can manage business settings, approve high-value orders, and change order status. Members can handle conversations and view data.</p>
      <div className="integration-list" style={{ marginTop: 12 }}>
        {team.map(u => (
          <article key={u.id}>
            <span>{(u.name ?? u.email).slice(0, 2).toUpperCase()}</span>
            <div><h3>{u.name ?? u.email}</h3><p>{u.email}</p></div>
            {me?.role === "OWNER" && u.role !== "OWNER" ? (
              <select value={u.role} onChange={e => changeRole(u.id, e.target.value as TeamUser["role"])} className="filter-button" style={{ fontSize: 11 }}>
                <option value="ADMIN">Admin</option>
                <option value="MEMBER">Member</option>
              </select>
            ) : (
              <span className="source-chip">{u.role}</span>
            )}
          </article>
        ))}
      </div>
      {me?.role === "OWNER" && (
        <div style={{ maxWidth: 420, marginTop: 16 }}>
          <div className="login-field"><label>Name</label><input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="Teammate name" /></div>
          <div className="login-field"><label>Email</label><input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="teammate@yourbusiness.com" /></div>
          <div className="login-field"><label>Temporary password</label><input type="password" value={invitePassword} onChange={e => setInvitePassword(e.target.value)} placeholder="Min. 8 characters" /></div>
          <div className="login-field">
            <label>Role</label>
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as TeamUser["role"])}>
              <option value="ADMIN">Admin</option>
              <option value="MEMBER">Member</option>
            </select>
          </div>
          {inviteError && <p style={{ color: "#b94940", fontSize: 12, marginBottom: 10 }}>{inviteError}</p>}
          <button className="primary-button" onClick={invite} disabled={!inviteEmail.trim() || invitePassword.length < 8 || !inviteName.trim()}>Add teammate</button>
        </div>
      )}
    </section>

    <section className="settings-section">
      <h2>Connected channels</h2>
      <p>Only connect accounts that your business owns and has permission to use.</p>
      <div className="integration-list">
        {[{ name: "WhatsApp Business", copy: `Phone Number ID: ${biz?.whatsappPhoneNumberId ?? "not set"}`, connected: !!biz?.whatsappPhoneNumberId }, { name: "Instagram", copy: `Page ID: ${biz?.instagramPageId ?? "not set"}`, connected: !!biz?.instagramPageId }, { name: "Email", copy: `Support address: ${biz?.supportEmail ?? "not set"}`, connected: !!biz?.supportEmail }, { name: "OpenAI", copy: "AI reply drafts are active", connected: true }].map(item => (
          <article key={item.name}><span>{item.name[0]}</span><div><h3>{item.name}</h3><p>{item.copy}</p></div><button className={item.connected ? "connected" : "connect"}>{item.connected ? "Connected" : "Connect"}</button></article>
        ))}
      </div>
    </section>

    <section className="settings-section">
      <h2>AI autonomy</h2>
      <p>The AI replies to customers automatically — no human approval step for everyday conversations.</p>
      <div className="autonomy"><strong>Fully autonomous</strong><span>AI reads every inbound message, decides whether to answer or place an order, and sends the reply directly to the customer.</span><button className="selected-mode">Current mode</button></div>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Require approval for orders above</label>
          <input value={autonomyMaxOrderValue} onChange={e => setAutonomyMaxOrderValue(e.target.value)} placeholder="e.g. 5000 (leave blank for no limit)" inputMode="decimal" />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Orders above this total are held for your approval on the Orders page instead of being placed automatically. Escalated conversations (ambiguous requests, complaints) also pause the AI until you resolve them from the Inbox.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>
  </AppShell>;
}
