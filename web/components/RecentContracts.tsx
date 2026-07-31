/**
 * RecentContracts — lists the seed dataset contracts with grade badges.
 * Server component.
 */

import Link from "next/link";
import seedContracts from "@/lib/seedContracts";
import { getGradeVisual } from "@/lib/gradeUtils";
import clsx from "clsx";

export default function RecentContracts() {
  const contracts = seedContracts.slice(0, 8);

  if (contracts.length === 0) {
    return (
      <p className="text-slate-500 text-sm">
        No contracts in the seed dataset yet.
      </p>
    );
  }

  return (
    <ul
      className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      aria-label="Recently analysed contracts"
    >
      {contracts.map((c) => {
        const visual = getGradeVisual(c.grade);
        return (
          <li key={c.contractId}>
            <Link
              href={`/contract/${c.contractId}`}
              className={clsx(
                "flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors hover:bg-slate-800/60 focus:outline-none focus:ring-2 focus:ring-brand-500",
                visual.border,
                visual.bg
              )}
              aria-label={`${c.name} — grade ${c.grade}`}
            >
              {/* Grade badge */}
              <span
                className={clsx(
                  "text-2xl font-black w-8 text-center shrink-0",
                  visual.text
                )}
                aria-hidden="true"
              >
                {c.grade}
              </span>

              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm text-slate-200 truncate">
                  {c.name}
                </p>
                <p className="mono text-xs text-slate-500 truncate-id">
                  {c.contractId}
                </p>
              </div>

              <div className="shrink-0 text-xs text-slate-500 text-right space-y-0.5">
                {c.upgradeable && (
                  <p className="text-red-400 font-medium">Upgradeable</p>
                )}
                {c.sourceVerified && (
                  <p className="text-green-400">Verified</p>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
