import { LegalPage } from "../../components/legal-page";
import { LEGAL_ENTITY_NAME, PRODUCT_NAME, REGISTERED_OFFICE, WEBSITE_URL } from "../../lib/company";

export const metadata = { title: "About — RelayShift" };

const COMPANY_DETAILS: [string, React.ReactNode][] = [
  ["Legal name", LEGAL_ENTITY_NAME],
  ["Product name", PRODUCT_NAME],
  ["Website", <a key="site" href={WEBSITE_URL} style={{ color: "var(--purple)" }}>{WEBSITE_URL.replace("https://", "")}</a>],
  ["Registered office", REGISTERED_OFFICE],
];

export default function AboutPage() {
  return (
    <LegalPage title="About RelayShift" showLastUpdated={false}>
      <p>{PRODUCT_NAME} is an AI sales assistant for commerce businesses. It connects a business's WhatsApp Business, Instagram, and/or email
      channels so customer questions are answered, orders are taken, and payments are collected through Razorpay, with a dashboard for the
      business to manage its conversations, orders, and inventory.</p>

      <h2>Company information</h2>
      <p>{PRODUCT_NAME} is the product name. The product is operated by the legal entity named below.</p>
      <dl style={{ margin: "16px 0 0" }}>
        {COMPANY_DETAILS.map(([label, value]) => (
          <div key={label} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
            <dt style={{ fontSize: 12, color: "var(--muted)" }}>{label}</dt>
            <dd style={{ margin: "2px 0 0", fontWeight: 600 }}>{value}</dd>
          </div>
        ))}
      </dl>

      <h2>Policies</h2>
      <p>See our <a href="/terms" style={{ color: "var(--purple)" }}>Terms of Service</a>, <a href="/privacy" style={{ color: "var(--purple)" }}>Privacy Policy</a>,{" "}
      <a href="/cookies" style={{ color: "var(--purple)" }}>Cookie Policy</a>, and <a href="/data-deletion" style={{ color: "var(--purple)" }}>Data Deletion</a> instructions.</p>
    </LegalPage>
  );
}
