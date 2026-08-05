import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Report Card — Soroban Contract Safety Registry",
  description:
    "Fully decentralised safety registry for Soroban smart contracts. No admin keys, no privileged relayers. is_safe(contract) returns an A–F grade backed by on-chain attestations, WASM analysis, and source verification.",
  openGraph: {
    title: "Report Card — Soroban Safety Registry",
    description: "Permissionless on-chain safety grades for Soroban smart contracts.",
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
