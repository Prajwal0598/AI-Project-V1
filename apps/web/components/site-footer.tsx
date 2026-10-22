import Link from "next/link";
import { LEGAL_ENTITY_NAME, PRODUCT_NAME, REGISTERED_OFFICE } from "../lib/company";

const FOOTER_LINKS = [
  ["About", "/about"],
  ["Privacy Policy", "/privacy"],
  ["Terms of Service", "/terms"],
  ["Cookie Policy", "/cookies"],
  ["Data Deletion", "/data-deletion"],
] as const;

export function SiteFooter({ align = "left" }: { align?: "left" | "center" }) {
  return (
    <footer style={{ textAlign: align, fontSize: 12.5, lineHeight: 1.6, color: "var(--ink)" }}>
      <p style={{ margin: 0 }}>{PRODUCT_NAME} is operated by <strong>{LEGAL_ENTITY_NAME}</strong>.</p>
      <address style={{ fontStyle: "normal", margin: "4px 0 0" }}>Registered office: {REGISTERED_OFFICE}</address>
      <nav aria-label="Company and legal information" style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: align === "center" ? "center" : "flex-start" }}>
        {FOOTER_LINKS.map(([label, href]) => (
          <Link key={href} href={href} style={{ color: "var(--muted)" }}>{label}</Link>
        ))}
      </nav>
    </footer>
  );
}
