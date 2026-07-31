import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Report Card — Soroban Contract Safety Registry",
  description:
    "Before your wallet signs, ask is_safe(contract). Audit attestations + WASM analysis + source verification fused into one A–F grade.",
  openGraph: {
    title: "Report Card",
    description: "Safety registry for Soroban smart contracts.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-900">
        {children}
      </body>
    </html>
  );
}
