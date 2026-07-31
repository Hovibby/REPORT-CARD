import type { SafetyRecord } from "@/lib/registry";
import { getGradeVisual } from "@/lib/gradeUtils";
import clsx from "clsx";

interface Props {
  record: SafetyRecord;
  contractId: string;
}

export default function GradeCard({ record, contractId }: Props) {
  const { grade } = record;
  const visual = getGradeVisual(grade.letter);

  return (
    <div
      className={clsx(
        "rounded-2xl border p-6 flex flex-col sm:flex-row items-start sm:items-center gap-6",
        visual.bg,
        visual.border
      )}
      role="region"
      aria-label={`Safety grade: ${grade.letter} — ${visual.label}`}
    >
      {/* Big grade letter */}
      <div
        className={clsx(
          "text-7xl font-black leading-none tabular-nums",
          visual.text
        )}
        aria-hidden="true"
      >
        {grade.letter}
      </div>

      <div className="flex-1 space-y-2">
        {/* Label + score */}
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className={clsx("text-xl font-bold", visual.text)}>
            {visual.emoji} {visual.label}
          </span>
          <span className="text-slate-400 text-sm">
            Score: {grade.score}/100
          </span>
        </div>

        {/* Flag pills */}
        <div
          className="flex flex-wrap gap-2 text-xs font-medium"
          aria-label="Risk flags"
        >
          <Pill
            active={record.upgradeable}
            activeClass="bg-red-900 text-red-300 border-red-700"
            inactiveClass="bg-green-900/30 text-green-400 border-green-800"
            label={record.upgradeable ? "Upgradeable" : "Not upgradeable"}
          />
          <Pill
            active={record.adminPower}
            activeClass="bg-orange-900 text-orange-300 border-orange-700"
            inactiveClass="bg-green-900/30 text-green-400 border-green-800"
            label={record.adminPower ? "Admin power" : "No admin power"}
          />
          <Pill
            active={!record.sourceVerified}
            activeClass="bg-yellow-900 text-yellow-300 border-yellow-700"
            inactiveClass="bg-green-900/30 text-green-400 border-green-800"
            label={record.sourceVerified ? "Source verified" : "Source unverified"}
          />
          <Pill
            active={record.attestationCount === 0}
            activeClass="bg-slate-800 text-slate-400 border-slate-600"
            inactiveClass="bg-green-900/30 text-green-400 border-green-800"
            label={
              record.attestationCount === 0
                ? "No attestations"
                : `${record.attestationCount} attestation${record.attestationCount === 1 ? "" : "s"}`
            }
          />
        </div>

        {/* WASM hash */}
        <p className="mono text-xs text-slate-500 break-all" aria-label="WASM hash">
          WASM: {record.wasmHash === "0".repeat(64) ? "unknown" : record.wasmHash}
        </p>

        {/* Upgrade warning — the demo target from the spec */}
        {record.upgradeable && (
          <p
            role="alert"
            className="text-sm text-red-300 font-medium mt-1"
          >
            Admin can replace this code at any time.
          </p>
        )}
      </div>
    </div>
  );
}

// ── helper ────────────────────────────────────────────────────────────────────

function Pill({
  active,
  activeClass,
  inactiveClass,
  label,
}: {
  active: boolean;
  activeClass: string;
  inactiveClass: string;
  label: string;
}) {
  return (
    <span
      className={clsx(
        "border rounded-full px-2.5 py-0.5",
        active ? activeClass : inactiveClass
      )}
    >
      {label}
    </span>
  );
}
