import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_ENTITY_NAME } from "../lib/company";
import { SiteFooter } from "./site-footer";

// the legal pages import the entity name from here; it is defined once in lib/company.ts
export { LEGAL_ENTITY_NAME };
// single contact address shown on the Privacy, Terms, Cookie and Data Deletion pages
export const LEGAL_CONTACT_EMAIL = "prajwalms0598@gmail.com";
export const LEGAL_LAST_UPDATED = "23 October 2026";

export function LegalPage({ title, children, showLastUpdated = true }: { title: string; children: ReactNode; showLastUpdated?: boolean }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--canvas)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 80px" }}>
        <Link href="/" style={{ color: "var(--purple)", fontSize: 13, textDecoration: "none" }}>← Back to RelayShift</Link>
        <h1 style={{ marginTop: 16, marginBottom: showLastUpdated ? 4 : 32 }}>{title}</h1>
        {showLastUpdated && <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 32 }}>Last updated: {LEGAL_LAST_UPDATED}</p>}
        <div style={{ lineHeight: 1.7, fontSize: 14, color: "var(--ink)" }}>{children}</div>
        <div style={{ marginTop: 56, paddingTop: 20, borderTop: "1px solid var(--line)" }}>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
