import { LegalPage, LEGAL_ENTITY_NAME, LEGAL_CONTACT_EMAIL } from "../../components/legal-page";

export const metadata = { title: "Privacy Policy — Relay" };

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>This Privacy Policy explains what data Relay ("we", "us") collects when a merchant business ("Merchant")
      uses the Relay platform, and when that Merchant's customers ("Customers") message the Merchant through a
      channel Relay operates on the Merchant's behalf (WhatsApp, Instagram Direct, or email).</p>

      <h2>1. Who this applies to</h2>
      <p>Relay is operated by {LEGAL_ENTITY_NAME}. Merchants sign up directly with Relay. Customers interact with
      a Merchant's chat channel and are not required to sign up with Relay directly — their messages and order
      data are processed by Relay solely to provide that Merchant's chat-commerce service.</p>

      <h2>2. Data we collect</h2>
      <p><strong>From Merchants:</strong> account/contact details (name, email, password hash), business profile
      information, connected channel identifiers (WhatsApp phone number, Instagram Page ID, support email), and
      payment-processing configuration (Razorpay key ID — the key secret and channel access tokens are encrypted
      at rest and never displayed back to you once saved).</p>
      <p><strong>From Customers, on a Merchant's behalf:</strong> name, phone number and/or email address as
      provided to the Merchant's chat channel, message content, order and payment history with that Merchant,
      and product-interest signals (e.g. products viewed or asked about) used to generate replies and
      recommendations.</p>

      <h2>3. How we use it</h2>
      <ul>
        <li>To operate the chat-commerce flow: routing messages, generating AI replies, managing carts/orders,
          and sending payment links and order updates.</li>
        <li>Message content and relevant product/order context are sent to our AI provider (OpenAI) solely to
          generate a reply for that conversation — never to train external models on your data.</li>
        <li>Payment collection is handled by Razorpay; Relay does not store card numbers or bank credentials.</li>
        <li>To detect and prevent abuse, and to maintain security logs (e.g. webhook signature verification,
          authentication attempts).</li>
      </ul>

      <h2>4. Data sharing</h2>
      <p>We share data with the sub-processors required to deliver the service: Meta (WhatsApp/Instagram message
      delivery), OpenAI (AI-generated replies), Razorpay (payment collection), and Postmark (transactional email).
      We do not sell personal data, and Merchant data is never shared with or visible to other Merchants on the
      platform.</p>

      <h2>5. Data retention</h2>
      <p>Conversation, order, and customer records are retained for as long as the Merchant's account is active,
      so the Merchant can maintain their own customer history. A Merchant or Customer may request deletion at any
      time — see our <a href="/data-deletion" style={{ color: "var(--purple)" }}>Data Deletion</a> page.</p>

      <h2>6. Security</h2>
      <p>Channel access tokens and payment credentials are encrypted at rest (AES-256-GCM). Inbound webhooks are
      signature-verified. Access to a Merchant's data is scoped strictly to that Merchant's own account.</p>

      <h2>7. Your rights</h2>
      <p>You may request access to, correction of, or deletion of your personal data by contacting{" "}
      <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>.</p>

      <h2>8. Changes to this policy</h2>
      <p>We may update this policy as the service evolves. Material changes will be reflected by updating the
      "Last updated" date above.</p>
    </LegalPage>
  );
}
