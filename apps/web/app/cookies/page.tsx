import { LegalPage, LEGAL_CONTACT_EMAIL } from "../../components/legal-page";

export const metadata = { title: "Cookie Policy — Relay" };

export default function CookiePolicyPage() {
  return (
    <LegalPage title="Cookie Policy">
      <p>Relay's merchant dashboard does not use tracking or advertising cookies.</p>

      <h2>1. What we actually use</h2>
      <p>Sign-in to the Relay dashboard is kept using your browser's <strong>local storage</strong> (an access
      token and a refresh token), not cookies. This data stays on your device and is only sent to Relay's own API
      to authenticate your requests — it is never shared with a third party.</p>

      <h2>2. Third-party channels</h2>
      <p>When a customer messages a Merchant on WhatsApp, Instagram, or email, any cookies used are set by that
      platform (Meta, the customer's email provider) under their own respective policies — Relay does not set
      cookies on a customer's device.</p>

      <h2>3. If this changes</h2>
      <p>If we introduce analytics or advertising cookies in the future, this page will be updated first, and
      we'll provide a way to opt out where required by law.</p>

      <p>Questions: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>.</p>
    </LegalPage>
  );
}
