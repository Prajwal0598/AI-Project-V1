import type { Metadata } from "next";
import "./globals.css";
import { LEGAL_ENTITY_NAME, PRODUCT_NAME, REGISTERED_OFFICE, WEBSITE_URL } from "../lib/company";

export const metadata: Metadata = {
  title: "RelayShift — AI Sales Command Center",
  description: "Your AI sales team across every customer channel."
};

// in the server-rendered HTML of every page (including "/", which only redirects to /login once the browser runs JS)
const organizationJsonLd = { "@context": "https://schema.org", "@type": "Organization", name: PRODUCT_NAME, legalName: LEGAL_ENTITY_NAME, url: WEBSITE_URL, address: REGISTERED_OFFICE };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }} />
        {children}
      </body>
    </html>
  );
}
