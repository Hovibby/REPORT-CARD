"use client";

/**
 * Auditor portal — lets a registered auditor sign and submit an attestation
 * for a specific contract + WASM hash using their connected wallet.
 *
 * Flow:
 *   1. Connect wallet (Freighter via stellar-wallets-kit)
 *   2. Enter contract ID + WASM hash + verdict + confidence
 *   3. Sign the attestation payload with the wallet
 *   4. Call submit_attestation() on the registry contract
 */

import { useState, useCallback } from "react";
import WalletButton from "@/components/WalletButton";
import { useWallet } from "@/lib/useWallet";
import type { WalletKit } from "@/lib/useWallet";
import { submitAttestation } from "@/lib/registry";

type Verdict = "safe" | "unsafe";

interface FormState {
  contractId: string;
  wasmHash: string;
  verdict: Verdict;
  confidence: string;
}

const EMPTY: FormState = {
  contractId: "",
  wasmHash: "",
  verdict: "safe",
  confidence: "80",
};

export default function AuditorPage() {
  const { address, kit } = useWallet();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [status, setStatus] = useState<
    | { type: "idle" }
    | { type: "submitting" }
    | { type: "success"; txHash: string }
    | { type: "error"; message: string }
  >({ type: "idle" });

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    },
    []
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || !kit) {
      setStatus({ type: "error", message: "Connect your wallet first." });
      return;
    }

    const conf = parseInt(form.confidence, 10);
    if (isNaN(conf) || conf < 1 || conf > 100) {
      setStatus({ type: "error", message: "Confidence must be 1–100." });
      return;
    }

    setStatus({ type: "submitting" });
    try {
      const txHash = await submitAttestation({
        auditorAddress: address,
        contractId: form.contractId,
        wasmHash: form.wasmHash,
        verdict: form.verdict === "safe",
        confidence: conf,
        // kit is narrowed to non-null by the guard above, but TypeScript
        // doesn't track that across the conditional — assert here.
        kit: kit as WalletKit,
      });
      setStatus({ type: "success", txHash });
      setForm(EMPTY);
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <main className="max-w-xl mx-auto px-4 py-10 space-y-8">
      <a
        href="/"
        className="text-sm text-slate-400 hover:text-slate-200 transition-colors inline-flex items-center gap-1"
      >
        ← Home
      </a>

      <div>
        <h1 className="text-2xl font-bold">Auditor Portal</h1>
        <p className="text-slate-400 text-sm mt-1">
          Submit a signed attestation bound to a specific WASM hash.
        </p>
      </div>

      {/* Wallet connection */}
      <div className="flex items-center gap-3">
        <WalletButton />
        {address && (
          <span className="mono text-xs text-slate-400 truncate-id">
            {address}
          </span>
        )}
      </div>

      {/* Attestation form */}
      <form
        onSubmit={handleSubmit}
        className="space-y-5"
        aria-label="Submit attestation"
      >
        <Field
          label="Contract ID"
          name="contractId"
          value={form.contractId}
          onChange={handleChange}
          placeholder="C…"
          pattern="C[A-Z2-7]{55}"
          title="A valid Stellar contract ID (starts with C, 56 chars)"
          required
        />

        <Field
          label="WASM hash (hex SHA-256)"
          name="wasmHash"
          value={form.wasmHash}
          onChange={handleChange}
          placeholder="e.g. a1b2c3…"
          pattern="[0-9a-fA-F]{64}"
          title="64 hex characters"
          required
        />

        <div className="space-y-1">
          <label
            htmlFor="verdict"
            className="block text-sm font-medium text-slate-300"
          >
            Verdict
          </label>
          <select
            id="verdict"
            name="verdict"
            value={form.verdict}
            onChange={handleChange}
            className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="safe">Safe</option>
            <option value="unsafe">Unsafe</option>
          </select>
        </div>

        <Field
          label="Confidence (1–100)"
          name="confidence"
          type="number"
          value={form.confidence}
          onChange={handleChange}
          min="1"
          max="100"
          required
        />

        <button
          type="submit"
          disabled={!address || status.type === "submitting"}
          className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
          aria-busy={status.type === "submitting"}
        >
          {status.type === "submitting" ? "Signing & submitting…" : "Submit attestation"}
        </button>
      </form>

      {/* Status messages */}
      {status.type === "success" && (
        <div
          role="status"
          className="rounded-lg border border-green-700 bg-green-950 px-4 py-3 text-green-300 text-sm space-y-1"
        >
          <p className="font-semibold">Attestation submitted.</p>
          <p className="mono text-xs break-all">tx: {status.txHash}</p>
        </div>
      )}
      {status.type === "error" && (
        <div
          role="alert"
          className="rounded-lg border border-red-700 bg-red-950 px-4 py-3 text-red-300 text-sm"
        >
          {status.message}
        </div>
      )}
    </main>
  );
}

// ── helper sub-component ──────────────────────────────────────────────────────

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
}

function Field({ label, name, ...rest }: FieldProps) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={name}
        className="block text-sm font-medium text-slate-300"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        {...rest}
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-50 mono text-sm placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </div>
  );
}
