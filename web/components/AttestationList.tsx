/**
 * AttestationList — shows on-chain auditor attestations for a contract.
 *
 * This is a server component that reads directly from the on-chain registry.
 * Because Soroban's persistent storage doesn't support iteration, attestations
 * are indexed off-chain by the engine and served from /api/attestations or
 * from the seed data file.  Here we fetch the known auditors from the seed
 * dataset and check each one against the contract.
 */

import attestors from "@/lib/knownAuditors";
import clsx from "clsx";

interface Props {
  contractId: string;
  wasmHash?: string;
}

interface DisplayAttestation {
  auditorAddress: string;
  auditorName: string;
  verdict: boolean;
  confidence: number;
  wasmHashMatch: boolean;
}

// Seed attestations from the open dataset for demo purposes.
// In production the engine indexes these from on-chain events.
async function loadAttestations(
  contractId: string,
  wasmHash: string | undefined
): Promise<DisplayAttestation[]> {
  // In a production deployment the engine writes to a Postgres/Supabase db
  // and we'd fetch from there.  For the hackathon demo we return static seed
  // data if the contract is in our seed dataset.
  const { default: seedData } = await import("@/lib/seedAttestations");
  const entries = seedData[contractId] ?? [];

  return entries.map((e: {
    auditorAddress: string;
    verdict: boolean;
    confidence: number;
    wasmHash: string;
  }) => ({
    auditorAddress: e.auditorAddress,
    auditorName:
      attestors.find((a) => a.address === e.auditorAddress)?.name ??
      e.auditorAddress.slice(0, 12) + "…",
    verdict: e.verdict,
    confidence: e.confidence,
    wasmHashMatch: !wasmHash || e.wasmHash === wasmHash,
  }));
}

export default async function AttestationList({ contractId, wasmHash }: Props) {
  const attestations = await loadAttestations(contractId, wasmHash);

  if (attestations.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-6 text-center">
        <p className="text-slate-400 text-sm">
          No attestations on record for this contract.
        </p>
        <a
          href="/auditor"
          className="mt-2 inline-block text-brand-500 hover:text-brand-400 text-sm transition-colors"
        >
          Are you an auditor? Submit one →
        </a>
      </div>
    );
  }

  return (
    <ul className="space-y-3" aria-label="Auditor attestations">
      {attestations.map((a) => (
        <li
          key={a.auditorAddress}
          className={clsx(
            "rounded-xl border px-4 py-3 flex items-center gap-4",
            a.verdict
              ? "border-green-800 bg-green-900/20"
              : "border-red-800 bg-red-900/20"
          )}
        >
          {/* Verdict icon */}
          <span
            className={clsx(
              "text-xl shrink-0",
              a.verdict ? "text-green-400" : "text-red-400"
            )}
            aria-hidden="true"
          >
            {a.verdict ? "✓" : "✗"}
          </span>

          <div className="flex-1 min-w-0 space-y-0.5">
            <p className="font-medium text-sm text-slate-200">{a.auditorName}</p>
            <p className="mono text-xs text-slate-500 truncate-id">
              {a.auditorAddress}
            </p>
          </div>

          <div className="shrink-0 text-right space-y-0.5">
            <p
              className={clsx(
                "text-xs font-semibold",
                a.verdict ? "text-green-400" : "text-red-400"
              )}
            >
              {a.verdict ? "SAFE" : "UNSAFE"}
            </p>
            <p className="text-xs text-slate-500">
              confidence: {a.confidence}%
            </p>
            {!a.wasmHashMatch && (
              <p className="text-xs text-yellow-500">hash mismatch</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
