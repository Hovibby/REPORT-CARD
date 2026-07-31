/**
 * scoring.ts — Signal computation + weighted rubric
 *
 * Implements the five-signal rubric defined in the spec.
 * All logic is pure (no network calls); receives pre-fetched data.
 *
 * Weights (must sum to 100):
 *   30 — Signed audit attestations
 *   25 — Source verification
 *   20 — Upgradeability exposure
 *   15 — Admin-power surface
 *   10 — Maturity & usage
 */

import type { GradeLetter } from "@reportcard/types";
import { scoreToLetter, letterToNumeric, SIGNAL_WEIGHTS } from "@reportcard/types";

// Re-export so engine/index.ts can import from here without needing types directly.
export type { GradeLetter };

// ─────────────────────────── constants ───────────────────────────────────────

const W_ATTESTATION = SIGNAL_WEIGHTS.attestation;
const W_SOURCE      = SIGNAL_WEIGHTS.sourceVerification;
const W_UPGRADE     = SIGNAL_WEIGHTS.upgradeability;
const W_ADMIN       = SIGNAL_WEIGHTS.adminPower;
const W_MATURITY    = SIGNAL_WEIGHTS.maturity;

// ─────────────────────────── types ───────────────────────────────────────────

export interface AttestationInput {
  auditorReputation: number; // 1-100
  verdict: boolean;          // true = safe
  confidence: number;        // 1-100
  wasmHashMatch: boolean;    // attestation hash matches on-chain hash
}

export interface ScoringInput {
  // Signal 1 — attestations
  attestations: AttestationInput[];

  // Signal 2 — source verification
  sourceVerified: boolean;

  // Signal 3 — upgradeability (true = contract CAN be upgraded = bad)
  upgradeable: boolean;

  // Signal 4 — admin power (true = dangerous admin functions present = bad)
  adminPower: boolean;

  // Signal 5 — maturity
  ageDays: number;
  distinctAccounts: number;
  tvlProxy: number; // XLM equivalent
}

export interface ScoringResult {
  grade: GradeLetter;
  numeric: number;    // 5=A … 1=F
  score: number;      // 0-100 raw weighted score
  signals: {
    attestationScore: number;   // 0-100 contribution before weighting
    sourceScore: number;
    upgradeScore: number;
    adminScore: number;
    maturityScore: number;
  };
  flags: {
    upgradeable: boolean;
    adminPower: boolean;
    sourceVerified: boolean;
    attestationCount: number;
    validAttestationCount: number;
  };
  explanation: string;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

/** Map a raw 0-100 score to a letter grade. Uses the shared helper from @reportcard/types. */
export function scoreToGrade(score: number): { letter: GradeLetter; numeric: number } {
  const letter = scoreToLetter(score);
  return { letter, numeric: letterToNumeric(letter) };
}

/**
 * Compute the attestation contribution (0-100).
 *
 * Only attestations whose wasm_hash matches the on-chain hash count.
 * Reputation-weighted average of (verdict × confidence), then normalised.
 *
 * Formula:
 *   weighted_safe = Σ(reputation × confidence) for verdicts=true
 *   weighted_total = Σ(reputation × confidence) for all valid attestations
 *   contribution = (weighted_safe / weighted_total) * 100 ... then decayed by count
 */
function computeAttestationScore(attestations: AttestationInput[]): number {
  const valid = attestations.filter((a) => a.wasmHashMatch);
  if (valid.length === 0) return 0;

  let weightedSafe = 0;
  let weightedTotal = 0;

  for (const a of valid) {
    const w = a.auditorReputation * a.confidence;
    weightedTotal += w;
    if (a.verdict) weightedSafe += w;
  }

  if (weightedTotal === 0) return 0;

  const safeRatio = weightedSafe / weightedTotal; // 0-1
  const countBonus = Math.min(valid.length / 3, 1); // ramps up with 3+ attestations

  // Blend: ratio matters most; count bonus adds up to 20 extra points.
  return Math.round(safeRatio * 80 + countBonus * 20);
}

/**
 * Compute the maturity score (0-100).
 *
 * Three sub-signals, each 0-33, summed and capped at 100:
 *   - Age: log-scale, 30 days → ~33 pts, 365 days → ~66 pts, 730 days → ~100 pts.
 *   - Distinct accounts: log-scale, 100 users → ~50 pts.
 *   - TVL: log-scale, 10k XLM → ~50 pts.
 */
function computeMaturityScore(
  ageDays: number,
  distinctAccounts: number,
  tvlProxy: number
): number {
  const ageScore =
    ageDays <= 0 ? 0 : Math.min(Math.log10(ageDays + 1) / Math.log10(731) * 100, 100);

  const accountScore =
    distinctAccounts <= 0
      ? 0
      : Math.min(Math.log10(distinctAccounts + 1) / Math.log10(1001) * 100, 100);

  const tvlScore =
    tvlProxy <= 0
      ? 0
      : Math.min(Math.log10(tvlProxy + 1) / Math.log10(100001) * 100, 100);

  return Math.round((ageScore + accountScore + tvlScore) / 3);
}

// ─────────────────────────── main export ─────────────────────────────────────

/** Compute the full weighted score and grade for a contract. */
export function computeScore(input: ScoringInput): ScoringResult {
  // Signal 1 — attestations (0-100)
  const attestationScore = computeAttestationScore(input.attestations);

  // Signal 2 — source verification (0 or 100)
  const sourceScore = input.sourceVerified ? 100 : 0;

  // Signal 3 — upgradeability (100 = NOT upgradeable = good)
  const upgradeScore = input.upgradeable ? 0 : 100;

  // Signal 4 — admin power (100 = no dangerous admin = good)
  const adminScore = input.adminPower ? 0 : 100;

  // Signal 5 — maturity (0-100)
  const maturityScore = computeMaturityScore(
    input.ageDays,
    input.distinctAccounts,
    input.tvlProxy
  );

  // Weighted sum
  const raw =
    (attestationScore * W_ATTESTATION +
      sourceScore * W_SOURCE +
      upgradeScore * W_UPGRADE +
      adminScore * W_ADMIN +
      maturityScore * W_MATURITY) /
    100;

  const score = Math.round(raw);
  const { letter, numeric } = scoreToGrade(score);

  // Build human-readable explanation.
  const parts: string[] = [];
  if (input.upgradeable)
    parts.push("Admin can replace this code at any time (upgradeable).");
  if (input.adminPower)
    parts.push("Dangerous admin functions detected (mint/freeze/drain).");
  if (!input.sourceVerified)
    parts.push("Source code not verified against on-chain WASM hash.");

  const validAtts = input.attestations.filter((a) => a.wasmHashMatch);
  if (validAtts.length === 0) {
    parts.push("No audit attestations for the current WASM hash.");
  } else {
    const safeCount = validAtts.filter((a) => a.verdict).length;
    parts.push(
      `${safeCount}/${validAtts.length} auditor attestation(s) mark this contract safe.`
    );
  }

  const explanation =
    parts.length > 0 ? parts.join(" ") : "All signals are healthy.";

  return {
    grade: letter,
    numeric,
    score,
    signals: {
      attestationScore,
      sourceScore,
      upgradeScore,
      adminScore,
      maturityScore,
    },
    flags: {
      upgradeable: input.upgradeable,
      adminPower: input.adminPower,
      sourceVerified: input.sourceVerified,
      attestationCount: input.attestations.length,
      validAttestationCount: validAtts.length,
    },
    explanation,
  };
}

// ─────────────────────────── WASM static analysis ────────────────────────────
// These helpers are consumed by the engine's ingest pipeline.
// They operate on raw WASM bytes and look for known dangerous patterns.

export interface WasmAnalysisResult {
  upgradeable: boolean;
  adminPower: boolean;
  hostFunctions: string[];
  warnings: string[];
}

/**
 * Static analysis of WASM bytecode.
 *
 * Looks for:
 *   - Upgradeability: calls to `update_current_contract_wasm` host function
 *   - Admin power: patterns associated with mint/burn/freeze/drain
 *   - Host function inventory for the dashboard
 *
 * This is a heuristic byte-string search over the WASM binary.
 * A full disassembly pass (via `wabt` or `binaryen`) can be layered on later.
 */
export function analyzeWasm(wasmBytes: Buffer): WasmAnalysisResult {
  const text = wasmBytes.toString("latin1"); // treat bytes as latin1 for substring search
  const warnings: string[] = [];

  // ── upgradeability ────────────────────────────────────────────────────────
  // Soroban's `update_current_contract_wasm` is encoded as the string
  // "update_current_contract_wasm" in the custom section / import section.
  const UPGRADE_PATTERNS = [
    "update_current_contract_wasm",
    "set_code",
    "upgrade",
  ];
  const upgradeable = UPGRADE_PATTERNS.some((p) => text.includes(p));
  if (upgradeable) {
    warnings.push(
      `Upgradeability pattern detected: contract WASM can be replaced by an admin.`
    );
  }

  // ── admin power ───────────────────────────────────────────────────────────
  // Look for export names that suggest dangerous admin capabilities.
  const ADMIN_POWER_PATTERNS = [
    "mint",
    "burn",
    "freeze",
    "clawback",
    "drain",
    "set_admin",
    "authorize",
    "set_authorized",
  ];
  const adminPower = ADMIN_POWER_PATTERNS.some((p) => text.includes(p));
  if (adminPower) {
    warnings.push(
      `Admin-power functions detected (mint/freeze/drain/clawback). Verify they are properly access-controlled.`
    );
  }

  // ── host function inventory ───────────────────────────────────────────────
  // Soroban host functions appear in the WASM import section as strings.
  const ALL_HOST_FUNCTIONS = [
    "invoke_contract",
    "get_ledger_info",
    "require_auth",
    "require_auth_for_args",
    "emit_event",
    "put_contract_data",
    "get_contract_data",
    "del_contract_data",
    "create_contract",
    "update_current_contract_wasm",
    "call",
    "try_call",
  ];
  const hostFunctions = ALL_HOST_FUNCTIONS.filter((fn) => text.includes(fn));

  return { upgradeable, adminPower, hostFunctions, warnings };
}
