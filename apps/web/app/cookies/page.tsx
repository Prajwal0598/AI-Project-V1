import { LegalPage, LEGAL_CONTACT_EMAIL } from "../../components/legal-page";

export const metadata = { title: "Cookie Policy — RelayShift" };

export default function CookiePolicyPage() {
  return (
    <LegalPage title="Cookie Policy">
      <p>This page explains the cookies and similar technologies involved when you use the RelayShift website and
      merchant dashboard.</p>

      <h2>1. Storage created by RelayShift (essential)</h2>
      <p>RelayShift's own code does not set cookies. To keep you signed in, the dashboard stores an access token and a
      refresh token in your browser's <strong>local storage</strong>. They stay on your device, are sent only to
      RelayShift's own API to authenticate your requests, and are removed when you log out or clear your browser data.
      This storage is essential for signing in.</p>

      <h2>2. Third-party technologies</h2>
      <p>When you open the dashboard's Settings page (sign-in required), it may load two third-party scripts: Meta's
      Facebook JavaScript SDK (when the WhatsApp connection feature is configured), which is used to connect a WhatsApp
      Business account, and Razorpay Checkout, which is used to pay for a RelayShift subscription. When loaded, these
      providers may use cookies, local storage, or similar technologies under their own policies. We do not control
      them.</p>

      <h2>3. Error monitoring</h2>
      <p>If error monitoring is enabled, our pages may send technical error and performance information (such as error
      messages, the page address, and browser details) to Sentry so we can find and fix problems.</p>

      <h2>4. What we do not use</h2>
      <p>RelayShift's own pages do not use advertising cookies or analytics tools, and RelayShift does not currently
      provide a cookie banner or preference manager. The public pages (sign-in, About, Privacy, Terms, Cookies, and Data
      Deletion) do not load the third-party scripts described in section 2.</p>

      <h2>5. Customers' messaging channels</h2>
      <p>When a customer messages a Merchant on WhatsApp, Instagram, or email, any cookies used are set by that
      platform (Meta, the customer's email provider) under their own respective policies — RelayShift does not set
      cookies on a customer's device.</p>

      <h2>6. If this changes</h2>
      <p>If we introduce analytics or advertising cookies in the future, this page will be updated first, and
      we'll provide a way to opt out where required by law.</p>

      <p>Questions: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>.</p>
    </LegalPage>
  );
}
