/**
 * @reportcard/sdk — Stellar-native safety client for the Report Card registry.
 *
 * DECENTRALISATION:
 *   - isSafe()       — pure read, no keys, no auth.
 *   - submitFlags()  — permissionless write; any wallet can submit WASM
 *                      analysis.  The on-chain contract verifies the WASM
 *                      hash against ledger state, so no trust in the caller.
 *   - No privileged keys.  No Docker.  No off-chain database.
 *
 * Quick start:
 *
 *   import { ReportCard } from '@reportcard/sdk';
 *
 *   // Read (no wallet needed)
 *   const rc = new ReportCard({ network: 'testnet', registryContractId: 'C…' });
 *   const g  = await rc.isSafe(contractId);
 *   if (g.gradeNumeric <= 2 || g.upgradeable) showWarning(g);
 *
 *   // Write — any wallet, no admin
 *   const tx = await rc.buildSubmitFlagsXdr(flags);
 *   const { signedTxXdr } = await wallet.signTransaction(tx, { ... });
 *   const hash = await rc.sendSignedXdr(signedTxXdr);
 */

// ── re-export shared types ────────────────────────────────────────────────────
export type {
  GradeLetter,
  GradeNumeric,
  Grade,
  SafetyRecord,
  StellarNetwork,
} from "@reportcard/types";

import type { GradeLetter, GradeNumeric, StellarNetwork } from "@reportcard/types";

// ─────────────────────────── SDK types ───────────────────────────────────────

export interface SafetyResult {
  contractId:       string;
  grade:            GradeLetter;
  /** A=5 … F=1 — use this for numeric comparisons. */
  gradeNumeric:     GradeNumeric;
  score:            number;
  upgradeable:      boolean;
  sourceVerified:   boolean;
  adminPower:       boolean;
  attestationCount: number;
  wasmHash:         string;
  maturityScore:    number;
  explanation:      string;
  raw:              unknown;
}

export interface SubmitFlagsInput {
  /** Account that will sign and pay the transaction fee (any funded account). */
  submitterAddress:  string;
  /** Target contract being analysed. */
  contractId:        string;
  /** Hex SHA-256 of the deployed WASM (64 chars). */
  wasmHash:          string;
  upgradeable:       boolean;
  sourceVerified:    boolean;
  adminPower:        boolean;
  /** 0–10 derived from age + distinct callers. */
  maturityScore:     number;
}

export interface ReportCardOptions {
  network?:             StellarNetwork;
  /** Soroban RPC URL. Defaults to public SDF testnet endpoint. */
  rpcUrl?:              string;
  /** Deployed registry contract ID (C…). Required for all calls. */
  registryContractId?:  string;
  /**
   * HTTP transport: base URL of a deployed dashboard instance.
   * Use this for environments where @stellar/stellar-sdk is not available.
   */
  apiUrl?:              string;
  transport?:           "rpc" | "http";
}

const DEFAULT_RPC: Record<string, string> = {
  testnet:   "https://soroban-testnet.stellar.org",
  mainnet:   "https://mainnet.sorobanrpc.com",
  futurenet: "https://rpc-futurenet.stellar.org",
};

// ─────────────────────────── ReportCard class ────────────────────────────────

export class ReportCard {
  private opts: Required<Pick<ReportCardOptions, "network" | "transport">>
    & ReportCardOptions;

  constructor(options: ReportCardOptions = {}) {
    const network   = options.network   ?? "testnet";
    const transport = options.transport ?? (options.apiUrl ? "http" : "rpc");
    this.opts = { ...options, network, transport };
  }

  // ── read (no wallet required) ─────────────────────────────────────────────

  async isSafe(contractId: string): Promise<SafetyResult> {
    return this.opts.transport === "http"
      ? this._fetchHttp(contractId)
      : this._fetchRpc(contractId);
  }

  // ── permissionless write — build unsigned XDR ─────────────────────────────

  /**
   * Build the unsigned set_flags() transaction XDR.
   * Pass the returned string to your wallet's signTransaction() method,
   * then call sendSignedXdr() with the result.
   *
   * No privileged key required — any funded Stellar account may submit flags.
   */
  async buildSubmitFlagsXdr(input: SubmitFlagsInput): Promise<string> {
    const {
      rpc,
      Contract,
      Address,
      nativeToScVal,
      xdr,
      TransactionBuilder,
      BASE_FEE,
      Networks,
    } = await import("@stellar/stellar-sdk");

    const registryId = this._requireRegistryId();
    const rpcUrl     = this.opts.rpcUrl ?? DEFAULT_RPC[this.opts.network];
    const server     = new rpc.Server(rpcUrl, { allowHttp: false });
    const contract   = new Contract(registryId);
    const passphrase = this.opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

    const account = await server.getAccount(input.submitterAddress);

    // Pack the WASM hash into BytesN<32>.
    const wasmHashBytes = Buffer.from(input.wasmHash, "hex");
    if (wasmHashBytes.length !== 32) throw new Error("wasmHash must be 64 hex chars.");

    const tx = new TransactionBuilder(account, {
      fee:               BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(
        contract.call(
          "set_flags",
          new Address(input.submitterAddress).toScVal(),
          new Address(input.contractId).toScVal(),
          xdr.ScVal.scvBytes(wasmHashBytes),
          nativeToScVal(input.upgradeable,    { type: "bool" }),
          nativeToScVal(input.sourceVerified, { type: "bool" }),
          nativeToScVal(input.adminPower,     { type: "bool" }),
          nativeToScVal(input.maturityScore,  { type: "u32"  }),
        )
      )
      .setTimeout(30)
      .build();

    // Simulate to attach the resource footprint.
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    return rpc.assembleTransaction(tx, sim).build().toXDR();
  }

  /**
   * Submit a wallet-signed XDR and return the transaction hash.
   */
  async sendSignedXdr(signedXdr: string): Promise<string> {
    const { rpc, TransactionBuilder, Networks } =
      await import("@stellar/stellar-sdk");

    const rpcUrl     = this.opts.rpcUrl ?? DEFAULT_RPC[this.opts.network];
    const server     = new rpc.Server(rpcUrl, { allowHttp: false });
    const passphrase = this.opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

    const tx     = TransactionBuilder.fromXDR(signedXdr, passphrase);
    const result = await server.sendTransaction(tx);

    if (result.status === "ERROR") {
      throw new Error(`Submit failed: ${JSON.stringify(result.errorResult)}`);
    }

    // Poll for confirmation.
    let delay = 1_000;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, delay));
      const status = await server.getTransaction(result.hash);
      if (status.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (status.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Transaction failed: ${status.status}`);
        }
        return result.hash;
      }
      delay = Math.min(delay * 1.5, 8_000);
    }

    throw new Error(`Transaction ${result.hash} not confirmed after 15 attempts`);
  }

  // ── private: RPC read ─────────────────────────────────────────────────────

  private async _fetchRpc(contractId: string): Promise<SafetyResult> {
    const {
      rpc,           // v16 export — was SorobanRpc in v13
      Contract,
      Address,
      scValToNative,
      TransactionBuilder,
      Account,
      BASE_FEE,
      Networks,
    } = await import("@stellar/stellar-sdk");

    const registryId = this._requireRegistryId();
    const rpcUrl     = this.opts.rpcUrl ?? DEFAULT_RPC[this.opts.network];
    const server     = new rpc.Server(rpcUrl, { allowHttp: false });
    const contract   = new Contract(registryId);
    const passphrase = this.opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

    // Read-only simulate — no signing, no fee.
    const DUMMY  = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const tx = new TransactionBuilder(new Account(DUMMY, "0"), {
      fee:               BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call("is_safe", new Address(contractId).toScVal()))
      .setTimeout(10)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation error: ${sim.error}`);
    if (!sim.result?.retval) return this._normalise(contractId, {});

    const native = scValToNative(sim.result.retval) as Record<string, unknown>;
    return this._normalise(contractId, native);
  }

  // ── private: HTTP read ────────────────────────────────────────────────────

  private async _fetchHttp(contractId: string): Promise<SafetyResult> {
    const base = (this.opts.apiUrl ?? "").replace(/\/$/, "");
    const resp = await fetch(`${base}/api/safety?id=${encodeURIComponent(contractId)}`, {
      headers: { Accept: "application/json" },
      cache:   "no-store",
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(`Report Card API ${resp.status}: ${err?.error ?? resp.statusText}`);
    }
    const data = await resp.json() as { contractId: string; record: Record<string, unknown> };
    return this._normalise(contractId, data.record);
  }

  // ── private: normalise ────────────────────────────────────────────────────

  private _normalise(contractId: string, raw: Record<string, unknown>): SafetyResult {
    const grade          = (raw["grade"] as Record<string, unknown>) ?? {};
    const letter         = String(grade["letter"]  ?? "F") as GradeLetter;
    const gradeNumeric   = Number(grade["numeric"] ?? 1)   as GradeNumeric;
    const score          = Number(grade["score"]   ?? 0);
    const upgradeable    = Boolean(raw["upgradeable"]      ?? true);
    const sourceVerified = Boolean(raw["source_verified"]  ?? false);
    const adminPower     = Boolean(raw["admin_power"]      ?? true);
    const attestationCount = Number(raw["attestation_count"] ?? 0);
    const maturityScore  = Number(raw["maturity_score"]    ?? 0);

    let wasmHash = "0".repeat(64);
    const wh = raw["wasm_hash"];
    if (wh instanceof Uint8Array) wasmHash = Buffer.from(wh).toString("hex");
    else if (typeof wh === "string") wasmHash = wh;

    const parts: string[] = [];
    if (upgradeable)    parts.push("Admin can replace this code at any time.");
    if (adminPower)     parts.push("Dangerous admin functions present.");
    if (!sourceVerified) parts.push("Source not verified against on-chain WASM.");
    if (attestationCount === 0) parts.push("No audit attestations for this WASM hash.");
    const explanation = parts.length > 0 ? parts.join(" ") : "All signals are healthy.";

    return {
      contractId, grade: letter, gradeNumeric, score,
      upgradeable, sourceVerified, adminPower,
      attestationCount, wasmHash, maturityScore,
      explanation, raw,
    };
  }

  private _requireRegistryId(): string {
    const id = this.opts.registryContractId;
    if (!id) throw new Error("registryContractId is required. Pass it in ReportCardOptions.");
    return id;
  }
}

// ── convenience exports ───────────────────────────────────────────────────────

export async function isSafe(
  contractId: string,
  options?:   ReportCardOptions,
): Promise<SafetyResult> {
  return new ReportCard(options).isSafe(contractId);
}

export async function submitFlags(
  input:    SubmitFlagsInput,
  signFn:   (xdr: string) => Promise<string>,
  options?: ReportCardOptions,
): Promise<string> {
  const rc  = new ReportCard(options);
  const xdr = await rc.buildSubmitFlagsXdr(input);
  const signed = await signFn(xdr);
  return rc.sendSignedXdr(signed);
}
