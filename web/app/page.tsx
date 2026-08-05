import { Suspense } from "react";
import SearchBar from "@/components/SearchBar";
import RecentContracts from "@/components/RecentContracts";
import HeroStats from "@/components/HeroStats";

export default function HomePage() {
  return (
    <main className="flex flex-col min-h-screen">
      {/* ── Nav ─────────────────────────────────────────────────── */}
      <nav
        className="border-b border-slate-700 px-6 py-4 flex items-center justify-between"
        role="banner"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden="true">📋</span>
          <span className="font-bold text-lg tracking-tight">Report Card</span>
          <span className="hidden sm:inline text-xs text-slate-400 border border-slate-600 rounded px-2 py-0.5 ml-1">
            Stellar Trust-Oracle Suite
          </span>
        </div>
        <a
          href="https://github.com/Hovibby/REPORT-CARD"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="View source on GitHub (opens in new tab)"
        >
          GitHub
        </a>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section
        className="flex flex-col items-center justify-center gap-6 px-6 py-16 text-center"
        aria-labelledby="hero-heading"
      >
        <h1
          id="hero-heading"
          className="text-4xl sm:text-5xl font-extrabold tracking-tight"
        >
          Before your wallet signs,
          <br />
          <span className="text-sky-400">ask is_safe(contract)</span>
        </h1>
        <p className="max-w-xl text-slate-400 text-lg">
          Fully on-chain safety registry — no admin keys, no privileged relayers.
          Audit attestations · WASM analysis · source verification fused into
          one A–F grade any wallet or contract can read permissionlessly.
        </p>

        {/* Search */}
        <div className="w-full max-w-2xl">
          <SearchBar />
        </div>

        {/* Stats */}
        <Suspense fallback={null}>
          <HeroStats />
        </Suspense>
      </section>

      {/* ── Recent contracts ─────────────────────────────────────── */}
      <section
        className="px-6 pb-16 max-w-5xl mx-auto w-full"
        aria-labelledby="recent-heading"
      >
        <h2
          id="recent-heading"
          className="text-xl font-semibold mb-4 text-slate-300"
        >
          Recently analysed
        </h2>
        <Suspense
          fallback={
            <p className="text-slate-500 text-sm" role="status">
              Loading…
            </p>
          }
        >
          <RecentContracts />
        </Suspense>
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer className="mt-auto border-t border-slate-800 px-6 py-6 text-center text-xs text-slate-500">
        Apache-2.0 · data CC-BY-4.0 · Stellar Trust-Oracle Suite ·{" "}
        <a
          href="https://github.com/Hovibby/REPORT-CARD"
          target="_blank"
          rel="noreferrer"
          className="hover:text-slate-300 transition-colors"
        >
          GitHub
        </a>
      </footer>
    </main>
  );
}
