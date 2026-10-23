import { LegalPage, LEGAL_ENTITY_NAME, LEGAL_CONTACT_EMAIL } from "../../components/legal-page";

export const metadata = { title: "Privacy Policy — RelayShift" };

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>This Privacy Policy explains what data RelayShift ("we", "us") collects when a merchant business ("Merchant")
      uses the RelayShift platform, and when that Merchant's customers ("Customers") message the Merchant through a
      channel RelayShift operates on the Merchant's behalf (WhatsApp, Instagram Direct, or email).</p>

      <h2>1. Who this applies to</h2>
      <p>RelayShift is operated by {LEGAL_ENTITY_NAME}. Merchants sign up directly with RelayShift. Customers interact with
      a Merchant's chat channel and are not required to sign up with RelayShift directly — their messages and order
      data are processed by RelayShift solely to provide that Merchant's chat-commerce service. A Customer can also
      contact the Merchant directly about their data.</p>

      <h2>2. Data we collect</h2>
      <p><strong>From Merchants:</strong></p>
      <ul>
        <li>Account details: name, email address, and a password stored as a hash.</li>
        <li>Business details: business name, support email, product catalogue (including product images), and settings.</li>
        <li>Connected accounts: WhatsApp phone number and business account identifiers, Instagram Page ID, and the
          access tokens and Razorpay keys used to connect them (stored encrypted; secrets are never shown back to
          you once saved).</li>
        <li>Subscription details: plan, status, and Razorpay subscription identifiers. Card and payment details are
          collected by Razorpay, not by us.</li>
      </ul>
      <p><strong>From Customers, on a Merchant's behalf:</strong></p>
      <ul>
        <li>Contact details: name, phone number, email address, or social media handle, as provided through the
          Merchant's chat channel.</li>
        <li>Message content: the messages a Customer sends and the replies sent to them.</li>
        <li>Delivery address, given at checkout.</li>
        <li>Carts and orders: items, quantities, totals, payment method, and order status.</li>
        <li>Payment metadata: Razorpay payment link and payment identifiers and payment status. We do not store card
          numbers or bank credentials.</li>
        <li>Derived data: product-interest signals (for example products viewed or asked about), a lead score
          calculated from conversation and order history, and whether the Merchant has marked the Customer as opted
          out of proactive messages.</li>
      </ul>

      <h2>3. How we use it</h2>
      <ul>
        <li>To operate the chat-commerce flow: routing messages, generating AI replies, managing carts/orders,
          and sending payment links and order updates.</li>
        <li>Message content and context are sent to our AI provider, OpenAI, to generate replies and message drafts.
          This can include the Customer's name, the conversation so far, the Merchant's product catalogue, and the
          Customer's recent orders. Follow-up drafts (for example abandoned-cart, back-in-stock, repeat-purchase, and
          win-back messages) can include the Customer's name and the product or purchase they relate to. OpenAI
          processes this data under its own API terms and policies, which govern how it handles that data.</li>
        <li>Payment collection is handled by Razorpay; RelayShift does not store card numbers or bank credentials.</li>
        <li>To detect and prevent abuse, and to maintain security logs (e.g. webhook signature verification,
          authentication attempts).</li>
      </ul>

      <h2>4. Data sharing</h2>
      <p>We use the following service providers to deliver RelayShift and share with each the data it needs:</p>
      <ul>
        <li><strong>Meta</strong> (WhatsApp and Instagram) — delivering and receiving messages, and connecting a
          Merchant's WhatsApp Business account.</li>
        <li><strong>OpenAI</strong> — generating AI replies and message drafts (see section 3).</li>
        <li><strong>Razorpay</strong> — payments from Customers to Merchants, and billing for RelayShift subscriptions.</li>
        <li><strong>Postmark</strong> — sending and receiving email for Merchants who use the email channel.</li>
        <li><strong>Railway</strong> — hosting our application, database, and stored files.</li>
        <li><strong>Sentry</strong> — error monitoring, only where it is enabled.</li>
      </ul>
      <p>We do not sell personal data, and a Merchant's data is not shown to other Merchants on the platform.</p>

      <h2>5. Where data is stored and transferred</h2>
      <p>Our application and database are hosted on Railway in the United States (US West region). Our other
      providers process data in the countries where they operate, which may include countries outside India. As a
      result, personal data may be transferred to and processed in countries outside India.</p>

      <h2>6. Data retention</h2>
      <p>Conversation, order, and customer records are kept for as long as the Merchant's account exists, so the
      Merchant can maintain their own customer history. Cancelling a subscription, or letting it end, stops paid
      features such as AI auto-replies but does not by itself delete the account's data; data is deleted when a
      deletion request is completed. A Merchant or Customer may request deletion at any time — see our{" "}
      <a href="/data-deletion" style={{ color: "var(--purple)" }}>Data Deletion</a> page.</p>
      <p>We take a database backup every day and keep each backup for 14 days, so deleted data can remain in
      backups until they expire. Some records, such as order and payment records, may be kept longer where needed
      for tax, accounting, fraud-prevention, or dispute purposes. Error reports and operational logs are kept by
      our hosting and monitoring providers under their own retention settings.</p>

      <h2>7. Security</h2>
      <ul>
        <li>Channel access tokens and Razorpay credentials stored in our database are encrypted at rest with AES-256-GCM.</li>
        <li>Passwords are stored as one-way hashes, not in readable form.</li>
        <li>Inbound webhooks from Meta and Razorpay are signature-verified; inbound email webhooks are protected by a
          shared secret.</li>
        <li>A Merchant's data is accessed only through that Merchant's own account.</li>
      </ul>
      <p>Other data, such as message content and customer details, is stored in our database without separate
      field-level encryption by us. No system is completely secure.</p>

      <h2>8. Promotional and follow-up messages</h2>
      <p>Merchants can set RelayShift up to send follow-ups to their customers, such as abandoned-cart reminders,
      back-in-stock notices, repeat-purchase suggestions, win-back messages, and promotional broadcasts. These
      proactive messages are off by default, and the Merchant chooses whether to review each message first or let it
      send automatically.</p>
      <p>Merchants are responsible for having their customers' consent to be contacted and for following the
      messaging rules of WhatsApp and Instagram. RelayShift does not collect customer consent itself.</p>
      <p>A Merchant can mark a customer as opted out of proactive messages, and RelayShift then skips that customer.
      RelayShift does not currently detect opt-out replies such as "STOP" automatically. A customer who does not
      want these messages should tell the Merchant, or contact us at the address below.</p>

      <h2>9. Your rights and contact</h2>
      <p>You may request access to, correction of, or deletion of your personal data, or raise a concern or complaint
      about how it is handled, by contacting {LEGAL_ENTITY_NAME} at{" "}
      <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>. Customers
      of a Merchant can also contact the Merchant directly.</p>

      <h2>10. Changes to this policy</h2>
      <p>We may update this policy as the service evolves. Material changes will be reflected by updating the
      "Last updated" date above.</p>
    </LegalPage>
  );
}
