/**
 * @reportcard/sdk — one-line isSafe() client for the Report Card registry.
 *
 * Wallet pre-sign hook (the integration promise from the spec):
 *
 *   import { ReportCard } from '@reportcard/sdk';
 *   const rc = new ReportCard({ network: 'testnet' });
 *   const g  = await rc.isSafe(contractId);
 *   if (g.grade <= 'D' || g.upgradeable) showWarning(g);
 *
 * The SDK supports two transport modes:
 *   - 'rpc'  — calls the Soroban RPC directly (requires @stellar/stellar-sdk)
 *   - 'http' — calls the /api/safety endpoint of a deployed dashboard instance
 *              (no Stellar SDK dependency; works in any JS runtime)
 */

// All shared types come from @reportcard/types — the single source of truth.
export type {
  GradeLetter,
  GradeNumeric,
  Grade,
  SafetyRecord,
  StellarNetwork,
} from "@reportcard/types";

import type { GradeLetter, GradeNumeric, StellarNetwork } from "@reportcard/types";

// ─────────────────────────── SDK-specific types ───────────────────────────────

/**
 * Enriched result returned by isSafe(). Extends SafetyRecord with SDK
 * conveniences: contractId, a flat grade letter/numeric, and an explanation.
 */
export interface SafetyResult {
  contractId: string;
  /** Letter grade: A | B | C | D | F */
  grade: GradeLetter;
  /** Numeric equivalent: A=5 … F=1. Use this for numeric comparisons. */
  gradeNumeric: GradeNumeric;
  /** Raw weighted score, 0–100. */
  score: number;
  upgradeable: boolean;
  sourceVerified: boolean;
  adminPower: boolean;
  attestationCount: number;
  wasmHash: string;
  maturityScore: number;
  /** Human-readable summary of the main risk factors. */
  explanation: string;
  /** Full on-chain record for advanced use. */
  raw: unknown;
}

export interface ReportCardOptions {
  /** Stellar network to target. Default: 'testnet'. */
  network?: StellarNetwork;

  /**
   * Transport mode.
   * 'rpc'  — direct Soroban RPC (requires stellar-sdk peer dep)
   * 'http' — REST call to the dashboard API (no extra deps)
   * Default: 'http' when apiUrl is set, otherwise 'rpc'.
   */
  transport?: "rpc" | "http";

  /**
   * Base URL of the deployed Report Card dashboard.
   * Used when transport='http'.
   * Example: 'https://reportcard.stellar.example.com'
   */
  apiUrl?: string;

  /**
   * Soroban RPC URL.
   * Used when transport='rpc'.
   * Default: public testnet RPC.
   */
  rpcUrl?: string;

  /**
   * Deployed Report Card registry contract ID.
   * Required when transport='rpc'.
   */
  registryContractId?: string;
}

const DEFAULT_RPC: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
  futurenet: "https://rpc-futurenet.stellar.org",
};

// ─────────────────────────── SDK class ───────────────────────────────────────

export class ReportCard {
  private opts: Required<
    Pick<ReportCardOptions, "network" | "transport">
  > &
    ReportCardOptions;

  constructor(options: ReportCardOptions = {}) {
    const network = options.network ?? "testnet";
    const transport =
      options.transport ??
      (options.apiUrl ? "http" : "rpc");

    this.opts = { ...options, network, transport };
  }

  /**
   * Fetch the safety record for a Soroban contract.
   *
   * @param contractId  56-character Stellar contract ID (starts with C)
   * @returns           SafetyResult with grade, flags, and explanation
   */
  async isSafe(contractId: string): Promise<SafetyResult> {
    switch (this.opts.transport) {
      case "http":
        return this._fetchHttp(contractId);
      case "rpc":
        return this._fetchRpc(contractId);
    }
  }

  // ── HTTP transport ──────────────────────────────────────────────────────

  private async _fetchHttp(contractId: string): Promise<SafetyResult> {
    const base = (this.opts.apiUrl ?? "").replace(/\/$/, "");
    const url = `${base}/api/safety?id=${encodeURIComponent(contractId)}`;

    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      // Don't cache in the SDK — callers control caching.
      cache: "no-store",
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(
        `Report Card API error ${resp.status}: ${err?.error ?? resp.statusText}`
      );
    }

    const data = await resp.json() as { contractId: string; record: Record<string, unknown> };
    return this._normalise(contractId, data.record);
  }

  // ── RPC transport ───────────────────────────────────────────────────────

  private async _fetchRpc(contractId: string): Promise<SafetyResult> {
    // Dynamically import @stellar/stellar-sdk so the SDK doesn't bundle it
    // for callers who use the HTTP transport.
    const {
      SorobanRpc,
      Contract,
      Address,
      scValToNative,
      TransactionBuilder,
      Account,
      BASE_FEE,
      Networks,
    } = await import("@stellar/stellar-sdk");

    const registryId = this.opts.registryContractId;
    if (!registryId) {
      throw new Error(
        "registryContractId is required when transport='rpc'. " +
          "Pass it in the ReportCard constructor options."
      );
    }

    const rpcUrl = this.opts.rpcUrl ?? DEFAULT_RPC[this.opts.network];
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    const contract = new Contract(registryId);

    const networkPassphrase =
      this.opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

    // Build a view transaction (no signing needed for read-only simulate).
    const DUMMY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const account = new Account(DUMMY, "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("is_safe", new Address(contractId).toScVal()))
      .setTimeout(10)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }

    if (!sim.result?.retval) {
      // Contract returned nothing — treat as unknown (F).
      return this._normalise(contractId, {});
    }

    const native = scValToNative(sim.result.retval) as Record<string, unknown>;
    return this._normalise(contractId, native);
  }

  // ── normaliser ──────────────────────────────────────────────────────────

  private _normalise(
    contractId: string,
    raw: Record<string, unknown>
  ): SafetyResult {
    const grade = (raw["grade"] as Record<string, unknown>) ?? {};
    const letter = (String(grade["letter"] ?? "F")) as GradeLetter;
    const numeric = Number(grade["numeric"] ?? 1);
    const score = Number(grade["score"] ?? 0);
    const upgradeable = Boolean(raw["upgradeable"] ?? true);
    const sourceVerified = Boolean(raw["source_verified"] ?? false);
    const adminPower = Boolean(raw["admin_power"] ?? true);
    const attestationCount = Number(raw["attestation_count"] ?? 0);
    const maturityScore = Number(raw["maturity_score"] ?? 0);

    let wasmHash = "0".repeat(64);
    const wh = raw["wasm_hash"];
    if (wh instanceof Uint8Array) {
      wasmHash = Buffer.from(wh).toString("hex");
    } else if (typeof wh === "string") {
      wasmHash = wh;
    }

    // Build explanation.
    const parts: string[] = [];
    if (upgradeable) parts.push("Admin can replace this code at any time.");
    if (adminPower) parts.push("Dangerous admin functions present.");
    if (!sourceVerified) parts.push("Source not verified.");
    if (attestationCount === 0) parts.push("No audit attestations.");
    const explanation =
      parts.length > 0 ? parts.join(" ") : "All signals are healthy.";

    return {
      contractId,
      grade: letter,
      gradeNumeric: numeric,
      score,
      upgradeable,
      sourceVerified,
      adminPower,
      attestationCount,
      wasmHash,
      maturityScore,
      explanation,
      raw,
    };
  }
}

// ─────────────────────────── convenience export ───────────────────────────────

/** Shorthand: single isSafe() call without constructing a class instance. */
export async function isSafe(
  contractId: string,
  options?: ReportCardOptions
): Promise<SafetyResult> {
  return new ReportCard(options).isSafe(contractId);
}
