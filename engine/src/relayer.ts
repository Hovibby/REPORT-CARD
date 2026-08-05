/**
 * relayer.ts — Permissionless on-chain flag submission.
 *
 * DECENTRALISATION: There is NO privileged relayer key.
 *
 * Any funded Stellar account can submit WASM analysis flags because the
 * on-chain contract verifies the WASM hash against ledger state itself.
 * A fraudulent submission with the wrong hash is rejected by the contract.
 *
 * The Relayer class accepts either:
 *   (a) a secret key — for automated community relayers running on servers, or
 *   (b) a pre-signed XDR — for wallet-based submissions from the dashboard.
 *
 * There is no "owner" of this role.  Anyone can run a relayer.
 */

import {
  Keypair,
  Networks,
  rpc,              // stellar-sdk v16
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Contract,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";
import type { WasmAnalysisResult } from "./scoring.js";
import type { StellarNetwork } from "@reportcard/types";

// ─────────────────────────── config ──────────────────────────────────────────

export interface RelayerConfig {
  /**
   * Secret key of any funded Stellar account (S…).
   * This is NOT a privileged key — any account may call set_flags().
   * Required when running as an automated observer.
   * Leave empty when using wallet-signed submissions.
   */
  secretKey?: string;

  /** Deployed Report Card registry contract ID (C…). */
  contractId: string;

  /** Soroban RPC URL. */
  rpcUrl: string;

  /** Stellar network. */
  network: StellarNetwork;

  /** Transaction timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
}

// ─────────────────────────── types ───────────────────────────────────────────

export interface SetFlagsParams {
  /** Target contract being analysed (C…). */
  contractId:      string;
  /** Hex-encoded SHA-256 of the deployed WASM. */
  wasmHash:        string;
  upgradeable:     boolean;
  sourceVerified:  boolean;
  adminPower:      boolean;
  /** 0–10 derived from age + distinct accounts. */
  maturityScore:   number;
  /**
   * The Stellar address that will sign and pay.
   * Required when secretKey is not set (wallet-mode).
   */
  submitterAddress?: string;
}

export interface RelayerResult {
  txHash:  string;
  ledger:  number;
  success: boolean;
  error?:  string;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

function networkPassphrase(network: StellarNetwork): string {
  switch (network) {
    case "mainnet":   return Networks.PUBLIC;
    case "testnet":   return Networks.TESTNET;
    case "futurenet": return Networks.FUTURENET;
  }
}

function wasmHashToScVal(hexHash: string): xdr.ScVal {
  const buf = Buffer.from(hexHash, "hex");
  if (buf.length !== 32) throw new Error(`WASM hash must be 32 bytes, got ${buf.length}`);
  return xdr.ScVal.scvBytes(buf);
}

async function waitForTx(
  server:      rpc.Server,
  txHash:      string,
  maxAttempts = 15
): Promise<rpc.Api.GetTransactionResponse> {
  let delay = 1_000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, delay));
    const result = await server.getTransaction(txHash);
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return result;
    delay = Math.min(delay * 1.5, 8_000);
  }
  throw new Error(`Transaction ${txHash} not confirmed after ${maxAttempts} attempts`);
}

// ─────────────────────────── Relayer class ───────────────────────────────────

export class Relayer {
  private keypair:  Keypair | null;
  private server:   rpc.Server;
  private contract: Contract;
  private config:   RelayerConfig;

  constructor(config: RelayerConfig) {
    this.config   = config;
    this.keypair  = config.secretKey ? Keypair.fromSecret(config.secretKey) : null;
    this.server   = new rpc.Server(config.rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.contractId);
  }

  /**
   * Build, simulate, sign, and submit a set_flags() transaction.
   *
   * PERMISSIONLESS: the submitter pays the fee but gains no special authority.
   * The contract enforces integrity by comparing the wasm_hash against the
   * actual on-chain WASM hash for the target contract.
   */
  async setFlags(params: SetFlagsParams): Promise<RelayerResult> {
    const passphrase = networkPassphrase(this.config.network);
    const timeout    = this.config.timeoutSeconds ?? 30;

    // Determine who is signing.
    const signerPublicKey =
      this.keypair?.publicKey() ?? params.submitterAddress;
    if (!signerPublicKey) {
      return {
        txHash:  "",
        ledger:  0,
        success: false,
        error:   "No signer: provide secretKey in RelayerConfig or submitterAddress in params.",
      };
    }

    try {
      const account = await this.server.getAccount(signerPublicKey);

      const tx = new TransactionBuilder(account, {
        fee:              BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          this.contract.call(
            "set_flags",
            new Address(signerPublicKey).toScVal(),       // submitter
            new Address(params.contractId).toScVal(),    // contract_id
            wasmHashToScVal(params.wasmHash),             // wasm_hash
            nativeToScVal(params.upgradeable,    { type: "bool" }),
            nativeToScVal(params.sourceVerified, { type: "bool" }),
            nativeToScVal(params.adminPower,     { type: "bool" }),
            nativeToScVal(params.maturityScore,  { type: "u32" }),
          )
        )
        .setTimeout(timeout)
        .build();

      // Simulate to get the resource footprint.
      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        return { txHash: "", ledger: 0, success: false, error: `Simulation failed: ${sim.error}` };
      }

      const prepared = rpc.assembleTransaction(tx, sim).build();

      if (this.keypair) {
        prepared.sign(this.keypair);
      } else {
        // Caller must sign externally and re-submit — return the unsigned XDR.
        return {
          txHash:  prepared.hash().toString("hex"),
          ledger:  0,
          success: false,
          error:   `UNSIGNED_XDR:${prepared.toXDR()}`,
        };
      }

      const submitResult = await this.server.sendTransaction(prepared);
      if (submitResult.status === "ERROR") {
        return {
          txHash:  submitResult.hash,
          ledger:  0,
          success: false,
          error:   `Submit error: ${JSON.stringify(submitResult.errorResult)}`,
        };
      }

      const confirmed = await waitForTx(this.server, submitResult.hash);
      const success   = confirmed.status === rpc.Api.GetTransactionStatus.SUCCESS;

      return {
        txHash:  submitResult.hash,
        ledger:  (confirmed as { ledger?: number }).ledger ?? 0,
        success,
        error:   success ? undefined : `Transaction failed: ${confirmed.status}`,
      };
    } catch (err) {
      return {
        txHash:  "",
        ledger:  0,
        success: false,
        error:   err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Derive maturity_score from continuous signals and call setFlags.
   * This is the main entry point for the automated engine pipeline.
   */
  async submitVerdict(
    targetContractId: string,
    wasmHash:         string,
    analysis:         WasmAnalysisResult,
    sourceVerified:   boolean,
    ageDays:          number,
    distinctAccounts: number,
    tvlProxy:         number,
  ): Promise<RelayerResult> {
    const ageScore      = ageDays          >= 365 ? 4 : ageDays          >= 90 ? 3 : ageDays          >= 30 ? 2 : ageDays          >= 7 ? 1 : 0;
    const accountScore  = distinctAccounts >= 1000? 3 : distinctAccounts >= 100? 2 : distinctAccounts >= 10 ? 1 : 0;
    const tvlScore      = tvlProxy         >= 100000? 3: tvlProxy         >= 10000? 2: tvlProxy         >= 1000 ? 1 : 0;
    const maturityScore = Math.min(ageScore + accountScore + tvlScore, 10);

    return this.setFlags({
      contractId:     targetContractId,
      wasmHash,
      upgradeable:    analysis.upgradeable,
      sourceVerified,
      adminPower:     analysis.adminPower,
      maturityScore,
    });
  }
}
