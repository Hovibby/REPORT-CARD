import { Suspense } from "react";
import { notFound } from "next/navigation";
import GradeCard from "@/components/GradeCard";
import EvidenceChecklist from "@/components/EvidenceChecklist";
import AttestationList from "@/components/AttestationList";
import { fetchSafetyRecord } from "@/lib/registry";

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props) {
  return {
    title: `Report Card — ${params.id.slice(0, 12)}…`,
  };
}

export default async function ContractPage({ params }: Props) {
  const contractId = params.id;

  // Basic format guard — Stellar contract IDs start with C and are 56 chars.
  if (!contractId.startsWith("C") || contractId.length !== 56) {
    notFound();
  }

  const record = await fetchSafetyRecord(contractId);

  return (
    <main className="max-w-4xl mx-auto px-4 py-10 space-y-8">
      {/* Back */}
      <a
        href="/"
        className="text-sm text-slate-400 hover:text-slate-200 transition-colors inline-flex items-center gap-1"
        aria-label="Back to home"
      >
        ← Home
      </a>

      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Contract Safety Report</h1>
        <p
          className="mono text-sm text-slate-400 break-all"
          title={contractId}
          aria-label={`Contract ID: ${contractId}`}
        >
          {contractId}
        </p>
      </div>

      {/* Grade card — big, visible verdict */}
      <GradeCard record={record} contractId={contractId} />

      {/* Evidence checklist — explains every signal */}
      <section aria-labelledby="evidence-heading">
        <h2
          id="evidence-heading"
          className="text-lg font-semibold mb-3 text-slate-200"
        >
          Evidence breakdown
        </h2>
        <EvidenceChecklist record={record} />
      </section>

      {/* Attestations */}
      <section aria-labelledby="attestations-heading">
        <h2
          id="attestations-heading"
          className="text-lg font-semibold mb-3 text-slate-200"
        >
          Auditor attestations
        </h2>
        <Suspense
          fallback={
            <p className="text-slate-500 text-sm" role="status">
              Loading attestations…
            </p>
          }
        >
          <AttestationList contractId={contractId} wasmHash={record?.wasmHash} />
        </Suspense>
      </section>
    </main>
  );
}
