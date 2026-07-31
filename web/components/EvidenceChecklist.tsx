import type { SafetyRecord } from "@/lib/registry";
import clsx from "clsx";

interface Props {
  record: SafetyRecord;
}

interface CheckItem {
  signal: string;
  weight: number;
  pass: boolean;
  detail: string;
}

function buildChecklist(r: SafetyRecord): CheckItem[] {
  return [
    {
      signal: "Signed audit attestations",
      weight: 30,
      pass: r.attestationCount > 0,
      detail:
        r.attestationCount > 0
          ? `${r.attestationCount} attestation(s) on record for the current WASM hash.`
          : "No recognised auditor has attested to this WASM hash.",
    },
    {
      signal: "Source verification",
      weight: 25,
      pass: r.sourceVerified,
      detail: r.sourceVerified
        ? "A reproducible build of the claimed source repo matches the on-chain WASM hash."
        : "Source code has not been verified against the on-chain WASM hash.",
    },
    {
      signal: "Upgradeability exposure",
      weight: 20,
      pass: !r.upgradeable,
      detail: r.upgradeable
        ? "An admin-controlled code-swap path was detected. The contract logic can be silently replaced."
        : "No upgrade path detected in the WASM bytecode.",
    },
    {
      signal: "Admin-power surface",
      weight: 15,
      pass: !r.adminPower,
      detail: r.adminPower
        ? "Dangerous admin functions (mint/freeze/drain) are present and may be gated by a single key."
        : "No dangerous admin-power functions detected.",
    },
    {
      signal: "Maturity & usage",
      weight: 10,
      pass: r.maturityScore >= 5,
      detail: `Maturity score: ${r.maturityScore}/10 (age + distinct users + value held).`,
    },
  ];
}

export default function EvidenceChecklist({ record }: Props) {
  const items = buildChecklist(record);

  return (
    <ul className="space-y-3" aria-label="Evidence checklist">
      {items.map((item) => (
        <li
          key={item.signal}
          className={clsx(
            "flex items-start gap-3 rounded-xl border px-4 py-3",
            item.pass
              ? "border-green-800 bg-green-900/20"
              : "border-slate-700 bg-slate-800/40"
          )}
        >
          {/* Pass/fail icon */}
          <span
            className={clsx(
              "mt-0.5 shrink-0 text-lg",
              item.pass ? "text-green-400" : "text-slate-500"
            )}
            aria-hidden="true"
          >
            {item.pass ? "✓" : "✗"}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium text-sm text-slate-200">
                {item.signal}
              </span>
              <span className="text-xs text-slate-500">
                weight: {item.weight}%
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">{item.detail}</p>
          </div>

          {/* Visual pass/fail badge */}
          <span
            className={clsx(
              "shrink-0 text-xs font-semibold rounded-full px-2 py-0.5 border",
              item.pass
                ? "text-green-400 border-green-700 bg-green-900/30"
                : "text-slate-500 border-slate-700 bg-slate-800"
            )}
            aria-label={item.pass ? "pass" : "fail"}
          >
            {item.pass ? "PASS" : "FAIL"}
          </span>
        </li>
      ))}
    </ul>
  );
}
