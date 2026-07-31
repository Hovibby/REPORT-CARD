/**
 * HeroStats — shows aggregate registry stats on the homepage.
 * Server component — fetches from the seed dataset (no external call needed
 * until a production db is wired up).
 */

import seedData from "@/lib/seedAttestations";
import knownAuditors from "@/lib/knownAuditors";

export default function HeroStats() {
  const contractCount = Object.keys(seedData).length;
  const auditorCount = knownAuditors.length;
  const attestationCount = Object.values(seedData).flat().length;

  return (
    <dl
      className="flex flex-wrap justify-center gap-8 text-center"
      aria-label="Registry statistics"
    >
      <Stat value={contractCount} label="Contracts analysed" />
      <Stat value={auditorCount} label="Registered auditors" />
      <Stat value={attestationCount} label="Attestations on-chain" />
    </dl>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <dt className="text-3xl font-extrabold text-brand-500">{value}</dt>
      <dd className="text-sm text-slate-400 mt-0.5">{label}</dd>
    </div>
  );
}
