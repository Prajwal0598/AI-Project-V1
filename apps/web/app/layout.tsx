import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay — AI Sales Command Center",
  description: "Your AI sales team across every customer channel."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
