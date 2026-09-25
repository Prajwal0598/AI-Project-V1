import { LegalPage, LEGAL_CONTACT_EMAIL } from "../../components/legal-page";

export const metadata = { title: "Data Deletion Instructions — Relay" };

export default function DataDeletionPage() {
  return (
    <LegalPage title="Data Deletion Instructions">
      <p>This page explains how to request deletion of personal data held by Relay, including data collected via
      WhatsApp or Instagram conversations with a Merchant using Relay.</p>

      <h2>How to request deletion</h2>
      <p>Send a deletion request to <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: "var(--purple)" }}>{LEGAL_CONTACT_EMAIL}</a>{" "}
      from the email address associated with your account (Merchants), or including the phone number/handle you
      messaged a Merchant from (Customers). Please specify whether you'd like:</p>
      <ul>
        <li><strong>Full account deletion</strong> (Merchants) — your business profile, connected channels, and
          all associated customer/conversation/order data.</li>
        <li><strong>My data only</strong> (Customers) — your own contact details, conversation history, and order
          history with a specific Merchant.</li>
      </ul>

      <h2>What happens next</h2>
      <p>We will verify the request and complete deletion within 30 days, and confirm by email once complete.
      Some records (e.g. completed order/payment records) may be retained for a shorter additional period where
      required for tax, accounting, or fraud-prevention obligations, and deleted thereafter.</p>

      <h2>Meta-specific note</h2>
      <p>If you are contacting us as a result of removing Relay's access from your Facebook/Instagram/WhatsApp
      account settings, that action stops Relay from receiving any further messages or data from that account —
      it does not by itself delete data already stored. Use the request process above for that.</p>
    </LegalPage>
  );
}
