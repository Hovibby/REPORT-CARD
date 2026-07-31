/**
 * @reportcard/types
 *
 * Single source of truth for all shared types across the monorepo.
 * Used by: @reportcard/sdk, @reportcard/engine, @reportcard/web
 *
 * Rules:
 *  - No runtime code here — types only.
 *  - Every interface mirrors the Soroban on-chain struct layout exactly.
 *  - Numeric field names use camelCase to match the SDK's scValToNative output.
 */

// ─────────────────────────── grade ───────────────────────────────────────────

/** Letter grade assigned by the registry. Higher is safer. */
export type GradeLetter = "A" | "B" | "C" | "D" | "F";

/** Numeric equivalent of a grade letter (A=5 … F=1). */
export type GradeNumeric = 1 | 2 | 3 | 4 | 5;

/** Grade object returned by the on-chain is_safe() call. */
export interface Grade {
  /** Letter representation: "A" | "B" | "C" | "D" | "F" */
  letter: GradeLetter;
  /** Raw weighted score, 0–100. */
  score: number;
  /** Numeric equivalent: A=5, B=4, C=3, D=2, F=1. */
  numeric: GradeNumeric;
}

// ─────────────────────────── safety record ───────────────────────────────────

/**
 * Full on-chain SafetyRecord as returned by is_safe().
 * Field names match the camelCase output of @stellar/stellar-sdk scValToNative.
 */
export interface SafetyRecord {
  grade: Grade;
  /** True when the WASM contains an admin-controlled upgrade path. */
  upgradeable: boolean;
  /** True when a reproducible build matched the on-chain WASM hash. */
  sourceVerified: boolean;
  /** SHA-256 of the deployed WASM bytecode, hex-encoded. */
  wasmHash: string;
  /** Number of valid auditor attestations stored for this contract. */
  attestationCount: number;
  /** True when dangerous admin functions (mint/freeze/drain) are present. */
  adminPower: boolean;
  /** 0–10 score derived from contract age, distinct users, and TVL proxy. */
  maturityScore: number;
}

/** Default record for contracts that have never been analysed. Always grade F. */
export const UNKNOWN_RECORD: SafetyRecord = {
  grade: { letter: "F", score: 0, numeric: 1 },
  upgradeable: true,
  sourceVerified: false,
  wasmHash: "0".repeat(64),
  attestationCount: 0,
  adminPower: true,
  maturityScore: 0,
};

// ─────────────────────────── auditor ─────────────────────────────────────────

/** Auditor identity as stored on-chain. */
export interface Auditor {
  /** Reputation weight, 1–100. Set by the admin at onboarding. */
  reputation: number;
  /** SHA-256 of the auditor's off-chain profile (IPFS / Arweave CID). */
  metaHash: string;
  /** Whether the auditor is currently active. False = slashed/deactivated. */
  active: boolean;
}

// ─────────────────────────── attestation ─────────────────────────────────────

/** A single auditor attestation as stored on-chain. */
export interface Attestation {
  /** WASM hash this attestation covers. */
  wasmHash: string;
  /** true = auditor marked the contract safe, false = unsafe. */
  verdict: boolean;
  /** Auditor's stated confidence, 1–100. */
  confidence: number;
  /** Ledger timestamp when the attestation was submitted. */
  ledgerTs: number;
}

// ─────────────────────────── wallet kit interface ────────────────────────────

/**
 * Minimal structural interface for a Stellar wallet kit that can sign
 * transactions. Kept loose to stay compatible with stellar-wallets-kit v1 and v2.
 */
export interface WalletKit {
  signTransaction(
    xdr: string,
    opts: { address: string; networkPassphrase: string }
  ): Promise<{ signedTxXdr: string }>;
}

// ─────────────────────────── network ─────────────────────────────────────────

export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

export interface NetworkConfig {
  rpcUrl: string;
  horizonUrl: string;
  network: StellarNetwork;
  networkPassphrase: string;
}

export const TESTNET: NetworkConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
};

export const MAINNET: NetworkConfig = {
  rpcUrl: "https://mainnet.sorobanrpc.com",
  horizonUrl: "https://horizon.stellar.org",
  network: "mainnet",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
};

// ─────────────────────────── grade helpers ────────────────────────────────────

/** Convert a raw 0-100 score to a GradeLetter. */
export function scoreToLetter(score: number): GradeLetter {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

/** Convert a GradeLetter to its numeric equivalent. */
export function letterToNumeric(letter: GradeLetter): GradeNumeric {
  const map: Record<GradeLetter, GradeNumeric> = { A: 5, B: 4, C: 3, D: 2, F: 1 };
  return map[letter];
}

/** Human-readable label for each grade. */
export const GRADE_LABELS: Record<GradeLetter, string> = {
  A: "Safe",
  B: "Mostly safe",
  C: "Use caution",
  D: "High risk",
  F: "Do not sign",
};

/** Scoring signal weights. Must sum to 100. */
export const SIGNAL_WEIGHTS = {
  attestation: 30,
  sourceVerification: 25,
  upgradeability: 20,
  adminPower: 15,
  maturity: 10,
} as const;
