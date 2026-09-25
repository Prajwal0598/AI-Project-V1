"use client";
import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { AppShell } from "../../components/app-shell";
import { api, getBusinessId, whatsappEmbeddedSignup } from "../../lib/api";
import type { AutomationRule, Business, Category, Me, OpportunityType, TeamUser, WhatsAppConnectionStatusView } from "../../lib/api";

declare global {
  interface Window {
    FB?: { init: (opts: Record<string, unknown>) => void; login: (cb: (res: { authResponse?: { code?: string } }) => void, opts: Record<string, unknown>) => void };
    fbAsyncInit?: () => void;
  }
}

const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;
const META_WHATSAPP_CONFIG_ID = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID;

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
  const [defaultLowStockThreshold, setDefaultLowStockThreshold] = useState("");
  const [proactiveSuggestionsEnabled, setProactiveSuggestionsEnabled] = useState(false);
  const [assistedBuyingEnabled, setAssistedBuyingEnabled] = useState(false);
  const [assistedBuyingMaxRecommendations, setAssistedBuyingMaxRecommendations] = useState("");
  const [assistedBuyingRankingPreference, setAssistedBuyingRankingPreference] = useState<Business["assistedBuyingRankingPreference"]>("BEST_MATCH");
  const [assistedBuyingExcludedCategoryIds, setAssistedBuyingExcludedCategoryIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [defaultRepeatPurchaseDays, setDefaultRepeatPurchaseDays] = useState("");
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [rulesError, setRulesError] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [igAccessToken, setIgAccessToken] = useState("");
  const [postmarkToken, setPostmarkToken] = useState("");
  const [razorpayKeyId, setRazorpayKeyId] = useState("");
  const [razorpayKeySecret, setRazorpayKeySecret] = useState("");
  const [razorpayWebhookSecret, setRazorpayWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [waStatus, setWaStatus] = useState<WhatsAppConnectionStatusView | null>(null);
  const [waConnecting, setWaConnecting] = useState(false);
  const [waConnectError, setWaConnectError] = useState("");
  const [showManualWhatsApp, setShowManualWhatsApp] = useState(false);
  const pendingSignupRef = useRef<{ wabaId: string; phoneNumberId: string } | null>(null);

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
      setDefaultLowStockThreshold(String(b.defaultLowStockThreshold ?? 5));
      setProactiveSuggestionsEnabled(b.proactiveSuggestionsEnabled);
      setAssistedBuyingEnabled(b.assistedBuyingEnabled);
      setAssistedBuyingMaxRecommendations(String(b.assistedBuyingMaxRecommendations ?? 5));
      setAssistedBuyingRankingPreference(b.assistedBuyingRankingPreference ?? "BEST_MATCH");
      setAssistedBuyingExcludedCategoryIds(b.assistedBuyingExcludedCategoryIds ?? []);
      setDefaultRepeatPurchaseDays(String(b.defaultRepeatPurchaseDays ?? 30));
      setRazorpayKeyId(b.razorpayKeyId ?? "");
    }).catch(console.error);
    api.auth.me().then(setMe).catch(console.error);
    api.categories.list(bizId).then(setCategories).catch(console.error);
    whatsappEmbeddedSignup.getStatus().then(setWaStatus).catch(console.error);
    loadTeam();
    loadRules();
  }, []);

  // Meta's Embedded Signup flow posts the connected WABA/phone number IDs via a window message event,
  // separately from the authorization "code" FB.login's own callback returns — both are needed to complete
  // onboarding, so this listener stashes them until FB.login's callback fires with the code (see connectWhatsApp)
  useEffect(() => {
    function handleSignupMessage(event: MessageEvent) {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "WA_EMBEDDED_SIGNUP" && data.event === "FINISH" && data.data?.waba_id && data.data?.phone_number_id) {
          pendingSignupRef.current = { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id };
        }
      } catch { /* not a JSON message we care about */ }
    }
    window.addEventListener("message", handleSignupMessage);
    return () => window.removeEventListener("message", handleSignupMessage);
  }, []);

  function connectWhatsApp() {
    setWaConnectError("");
    if (!META_APP_ID || !META_WHATSAPP_CONFIG_ID) {
      setWaConnectError("WhatsApp Embedded Signup isn't configured yet — set NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID, or use the manual connection below.");
      return;
    }
    if (!window.FB) {
      setWaConnectError("Facebook SDK hasn't loaded yet — please wait a moment and try again.");
      return;
    }
    pendingSignupRef.current = null;
    window.FB.login((response) => {
      const code = response.authResponse?.code;
      if (!code) {
        setWaConnectError("WhatsApp connection was cancelled or denied.");
        return;
      }
      const pending = pendingSignupRef.current;
      if (!pending) {
        setWaConnectError("Could not determine which WhatsApp account was selected — please try again.");
        return;
      }
      setWaConnecting(true);
      whatsappEmbeddedSignup.complete({ code, wabaId: pending.wabaId, phoneNumberId: pending.phoneNumberId })
        .then(setWaStatus)
        .catch(err => setWaConnectError(err instanceof Error ? err.message : "Could not complete the WhatsApp connection."))
        .finally(() => setWaConnecting(false));
    }, { config_id: META_WHATSAPP_CONFIG_ID, response_type: "code", override_default_response_type: true });
  }

  async function disconnectWhatsApp() {
    setWaConnectError("");
    try {
      setWaStatus(await whatsappEmbeddedSignup.disconnect());
    } catch (err) { setWaConnectError(err instanceof Error ? err.message : "Could not disconnect WhatsApp."); }
  }

  function loadRules() {
    const bizId = getBusinessId();
    if (!bizId) return;
    api.automationRules.list(bizId).then(setRules).catch(console.error);
  }

  async function updateRule(type: OpportunityType, patch: Partial<Pick<AutomationRule, "enabled" | "autoSend" | "businessHoursStart" | "businessHoursEnd" | "frequencyCapPerCustomerPerDay" | "minConfidenceForAutoSend" | "personalizedTiming">>) {
    const bizId = getBusinessId();
    if (!bizId) return;
    try {
      const updated = await api.automationRules.update(bizId, type, patch);
      setRules(prev => prev.map(r => (r.opportunityType === type ? updated : r)));
    } catch (err) { setRulesError(err instanceof Error ? err.message : "Could not update this rule."); }
  }

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
    setSaving(true); setSaved(false); setSaveError("");
    try {
      const updated = await api.businesses.update(bizId, {
        name: name.trim(),
        timezone: timezone.trim(),
        whatsappPhoneNumberId: waPhoneId.trim() || null,
        instagramPageId: igPageId.trim() || null,
        supportEmail: supportEmail.trim() || null,
        autonomyMaxOrderValue: autonomyMaxOrderValue.trim() ? Number(autonomyMaxOrderValue) : null,
        defaultLowStockThreshold: defaultLowStockThreshold.trim() ? Number(defaultLowStockThreshold) : undefined,
        proactiveSuggestionsEnabled,
        assistedBuyingEnabled,
        assistedBuyingMaxRecommendations: assistedBuyingMaxRecommendations.trim() ? Number(assistedBuyingMaxRecommendations) : undefined,
        assistedBuyingRankingPreference,
        assistedBuyingExcludedCategoryIds,
        defaultRepeatPurchaseDays: defaultRepeatPurchaseDays.trim() ? Number(defaultRepeatPurchaseDays) : undefined,
        ...(waAccessToken && { whatsappAccessToken: waAccessToken }),
        ...(igAccessToken && { instagramAccessToken: igAccessToken }),
        ...(postmarkToken && { postmarkServerToken: postmarkToken }),
        ...(razorpayKeyId.trim() !== (biz?.razorpayKeyId ?? "") && { razorpayKeyId: razorpayKeyId.trim() }),
        ...(razorpayKeySecret && { razorpayKeySecret }),
        ...(razorpayWebhookSecret && { razorpayWebhookSecret }),
      });
      setBiz(updated);
      setWaAccessToken(""); setIgAccessToken(""); setPostmarkToken(""); setRazorpayKeySecret(""); setRazorpayWebhookSecret(""); // never keep secrets in the input after saving
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { setSaveError(err instanceof Error ? err.message : "Could not save settings."); }
    finally { setSaving(false); }
  }

  return <AppShell title="Settings" subtitle="Manage your workspace, channels, and AI controls.">
    {META_APP_ID && (
      <Script
        src="https://connect.facebook.net/en_US/sdk.js"
        strategy="afterInteractive"
        onLoad={() => {
          window.fbAsyncInit = () => window.FB?.init({ appId: META_APP_ID, autoLogAppEvents: true, xfbml: false, version: "v21.0" });
          window.fbAsyncInit();
        }}
      />
    )}
    {saveError && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{saveError} <button onClick={() => setSaveError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}
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
      <h2>WhatsApp Business</h2>
      {waConnectError && <p style={{ color: "#b94940", fontSize: 12, marginBottom: 8 }}>{waConnectError}</p>}
      {waStatus?.status === "CONNECTED" ? (
        <div style={{ maxWidth: 420, marginTop: 8 }}>
          <p style={{ color: "var(--green)", fontWeight: 600 }}>✓ Connected</p>
          <p>Business: {waStatus.businessName}</p>
          <p>Number: {waStatus.displayPhoneNumber}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="primary-button" onClick={connectWhatsApp} disabled={waConnecting}>Manage Connection</button>
            <button onClick={disconnectWhatsApp} disabled={waConnecting}>Disconnect</button>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 420, marginTop: 8 }}>
          <p>Connect your WhatsApp Business account to let Relay talk to your customers.</p>
          {waStatus && !["DISCONNECTED", "CONNECTED"].includes(waStatus.status) && (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>Current status: {waStatus.status.replace(/_/g, " ").toLowerCase()}{waStatus.lastErrorMessage ? ` — ${waStatus.lastErrorMessage}` : ""}</p>
          )}
          <button className="primary-button" onClick={connectWhatsApp} disabled={waConnecting}>{waConnecting ? "Connecting…" : "Connect WhatsApp"}</button>
        </div>
      )}
      <button onClick={() => setShowManualWhatsApp(v => !v)} style={{ marginTop: 16, fontSize: 12, textDecoration: "underline" }}>
        {showManualWhatsApp ? "Hide" : "Advanced: connect manually instead"}
      </button>
      {showManualWhatsApp && (
        <div style={{ maxWidth: 420, marginTop: 12 }}>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>Fallback for when Embedded Signup isn't available — paste credentials directly from the Meta Developer Console.</p>
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
      )}
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
      <h2>Payments (Razorpay)</h2>
      <p>Lets customers pay online via UPI with a real Razorpay Payment Link. Without this configured, UPI orders use a simulated payment flow instead.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Key ID</label>
          <input value={razorpayKeyId} onChange={e => setRazorpayKeyId(e.target.value)} placeholder="rzp_live_XXXXXXXXXXXXXX" />
        </div>
        <div className="login-field">
          <label>Key secret {biz?.razorpayKeySecretConfigured && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ configured</span>}</label>
          <input type="password" value={razorpayKeySecret} onChange={e => setRazorpayKeySecret(e.target.value)} placeholder={biz?.razorpayKeySecretConfigured ? "•••••••• (leave blank to keep)" : "From Razorpay Dashboard → API Keys"} />
        </div>
        <div className="login-field">
          <label>Webhook secret {biz?.razorpayWebhookSecretConfigured && <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ configured</span>}</label>
          <input type="password" value={razorpayWebhookSecret} onChange={e => setRazorpayWebhookSecret(e.target.value)} placeholder={biz?.razorpayWebhookSecretConfigured ? "•••••••• (leave blank to keep)" : "Set this same value when creating the webhook below"} />
        </div>
        {biz && <div className="login-field">
          <label>Webhook URL — paste this into Razorpay Dashboard → Settings → Webhooks</label>
          <input readOnly value={biz.razorpayWebhookUrl} onFocus={e => e.target.select()} />
        </div>}
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Key secret and webhook secret are stored encrypted per-business. Falls back to <code>RAZORPAY_KEY_ID</code>/<code>RAZORPAY_KEY_SECRET</code>/<code>RAZORPAY_WEBHOOK_SECRET</code> in <code>.env</code> if left unset. Subscribe the webhook to the <code>payment_link.paid</code> event.</p>
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

    <section className="settings-section">
      <h2>Inventory</h2>
      <p>Get notified on the Products page when a product's stock runs low.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <div className="login-field">
          <label>Default low-stock threshold</label>
          <input value={defaultLowStockThreshold} onChange={e => setDefaultLowStockThreshold(e.target.value)} placeholder="e.g. 5" inputMode="numeric" />
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Applies to any product variant without its own custom threshold (set per-variant on the Products page).</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Assisted Buying</h2>
      <p>Lets the AI understand natural shopping requests (&quot;a shirt for a wedding under ₹2,000&quot;) and recommend matching products from your catalogue, instead of only responding to exact product names.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={assistedBuyingEnabled} onChange={e => setAssistedBuyingEnabled(e.target.checked)} />
          Enable Assisted Buying
        </label>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Off by default. Recommendations are grounded only in your published, in-stock catalogue — the AI never invents a product, price, or stock level.</p>
        <div className="login-field" style={{ marginTop: 10 }}>
          <label>Max recommendations shown per request</label>
          <input value={assistedBuyingMaxRecommendations} onChange={e => setAssistedBuyingMaxRecommendations(e.target.value)} placeholder="e.g. 5" inputMode="numeric" />
        </div>
        <div className="login-field" style={{ marginTop: 10 }}>
          <label>Ranking preference</label>
          <select value={assistedBuyingRankingPreference} onChange={e => setAssistedBuyingRankingPreference(e.target.value as Business["assistedBuyingRankingPreference"])}>
            <option value="BEST_MATCH">Best match (relevance)</option>
            <option value="VALUE">Value (cheapest first)</option>
            <option value="PREMIUM">Premium (priciest first)</option>
            <option value="NEWEST">Newest (most recently added first)</option>
          </select>
        </div>
        {categories.length > 0 && <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 13 }}>Exclude categories from recommendations</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
            {categories.map(c => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={assistedBuyingExcludedCategoryIds.includes(c.id)}
                  onChange={e => setAssistedBuyingExcludedCategoryIds(prev => e.target.checked ? [...prev, c.id] : prev.filter(id => id !== c.id))}
                />
                {c.name}
              </label>
            ))}
          </div>
        </div>}
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </section>

    <section className="settings-section">
      <h2>Proactive AI Suggestions</h2>
      <p>Relay watches conversations, carts, and inventory for sales opportunities (abandoned carts, product enquiries, back-in-stock) and drafts a message for your review in the <a href="/suggestions">Suggestions</a> inbox.</p>
      <div style={{ maxWidth: 420, marginTop: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={proactiveSuggestionsEnabled} onChange={e => setProactiveSuggestionsEnabled(e.target.checked)} />
          Enable Proactive AI Suggestions
        </label>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Every suggestion requires your review and approval before sending — nothing is messaged to a customer automatically. Off by default.</p>
        <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
      </div>

      {proactiveSuggestionsEnabled && <div style={{ marginTop: 20 }}>
        {rulesError && <div style={{ background: "#fff3f2", border: "1px solid #fcd9d6", color: "#b94940", fontSize: 12, padding: "8px 14px", marginBottom: 12 }}>{rulesError} <button onClick={() => setRulesError("")} style={{ marginLeft: 8, textDecoration: "underline" }}>Dismiss</button></div>}
        <h4 style={{ marginBottom: 6 }}>Per-type automation</h4>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: 6 }}>Type</th>
                <th style={{ padding: 6 }}>Enabled</th>
                <th style={{ padding: 6 }}>Auto-send</th>
                <th style={{ padding: 6 }}>Min confidence</th>
                <th style={{ padding: 6 }}>Business hours</th>
                <th style={{ padding: 6 }}>Personalized timing</th>
                <th style={{ padding: 6 }}>Daily cap / customer</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: 6 }}>{r.opportunityType.replace(/_/g, " ")}</td>
                  <td style={{ padding: 6 }}><input type="checkbox" checked={r.enabled} onChange={e => updateRule(r.opportunityType, { enabled: e.target.checked })} /></td>
                  <td style={{ padding: 6 }}><input type="checkbox" checked={r.autoSend} onChange={e => updateRule(r.opportunityType, { autoSend: e.target.checked })} /></td>
                  <td style={{ padding: 6 }}><input type="number" min={0} max={1} step={0.1} value={r.minConfidenceForAutoSend} onChange={e => updateRule(r.opportunityType, { minConfidenceForAutoSend: Number(e.target.value) })} style={{ width: 60 }} /></td>
                  <td style={{ padding: 6 }}>
                    <input type="number" min={0} max={23} placeholder="Start" value={r.businessHoursStart ?? ""} onChange={e => updateRule(r.opportunityType, { businessHoursStart: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 60, marginRight: 4 }} />
                    <input type="number" min={0} max={23} placeholder="End" value={r.businessHoursEnd ?? ""} onChange={e => updateRule(r.opportunityType, { businessHoursEnd: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 60 }} />
                  </td>
                  <td style={{ padding: 6 }}><input type="checkbox" checked={r.personalizedTiming} onChange={e => updateRule(r.opportunityType, { personalizedTiming: e.target.checked })} /></td>
                  <td style={{ padding: 6 }}><input type="number" min={1} placeholder="No cap" value={r.frequencyCapPerCustomerPerDay ?? ""} onChange={e => updateRule(r.opportunityType, { frequencyCapPerCustomerPerDay: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 80 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Auto-send only fires within the business-hours window (blank = no restriction) and when the opportunity's own confidence meets the minimum; outside either, the suggestion still appears in your inbox for manual approval. "Personalized timing" targets each customer's own usual reply hour (inferred from their message history) instead of the fixed business-hours window, once they have enough history — falls back to business hours otherwise.</p>
        <div style={{ maxWidth: 420, marginTop: 12 }}>
          <div className="login-field">
            <label>Repeat-purchase reminder window (days)</label>
            <input value={defaultRepeatPurchaseDays} onChange={e => setDefaultRepeatPurchaseDays(e.target.value)} placeholder="e.g. 30" inputMode="numeric" />
          </div>
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Used to estimate reorder timing for a product a customer has only bought once (customers with 2+ purchases use their own average interval instead).</p>
          <button className="primary-button" style={{ marginTop: 8 }} onClick={save} disabled={saving || !biz}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>}
    </section>
  </AppShell>;
}
