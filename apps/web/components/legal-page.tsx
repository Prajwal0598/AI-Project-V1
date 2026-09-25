import Link from "next/link";
import type { ReactNode } from "react";

const LEGAL_NAV = [
  ["Privacy Policy", "/privacy"],
  ["Terms of Service", "/terms"],
  ["Cookie Policy", "/cookies"],
  ["Data Deletion", "/data-deletion"],
] as const;

// company/contact details aren't finalized yet (incorporation + domain are still in progress) — every legal
// page below reads from here so there's exactly one place to update once they are, instead of hunting through
// four separate pages. Replace with the real registered entity/address/contact before relying on these pages.
export const LEGAL_ENTITY_NAME = "RelayShift Technologies Private Limited (incorporation in progress)";
export const LEGAL_CONTACT_EMAIL = "support@relay.example"; // TODO: replace once the production domain is live
export const LEGAL_LAST_UPDATED = "25 September 2026";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--canvas)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 80px" }}>
        <Link href="/" style={{ color: "var(--purple)", fontSize: 13, textDecoration: "none" }}>← Back to Relay</Link>
        <h1 style={{ marginTop: 16, marginBottom: 4 }}>{title}</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 32 }}>Last updated: {LEGAL_LAST_UPDATED}</p>
        <div style={{ lineHeight: 1.7, fontSize: 14, color: "var(--ink)" }}>{children}</div>
        <nav style={{ marginTop: 56, paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", gap: 16, flexWrap: "wrap" }}>
          {LEGAL_NAV.map(([label, href]) => (
            <Link key={href} href={href} style={{ fontSize: 12, color: "var(--muted)" }}>{label}</Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
