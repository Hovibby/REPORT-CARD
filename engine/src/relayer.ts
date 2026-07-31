/**
 * relayer.ts — Submit computed verdicts on-chain via the Report Card contract.
 *
 * The relayer holds the privileged key that is authorised to call set_flags().
 * It signs and submits Soroban transactions using @stellar/stellar-sdk.
 */

import {
  Keypair,
  Networks,
  SorobanRpc,
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
  secretKey: string;           // relayer's Stellar secret key (S...)
  contractId: string;          // deployed Report Card contract ID (C...)
  rpcUrl: string;
  network: StellarNetwork;
  timeoutSeconds?: number;
}

function networkPassphrase(network: RelayerConfig["network"]): string {
  switch (network) {
    case "mainnet":   return Networks.PUBLIC;
    case "testnet":   return Networks.TESTNET;
    case "futurenet": return Networks.FUTURENET;
  }
}

// ─────────────────────────── types ───────────────────────────────────────────

export interface SetFlagsParams {
  contractId: string;       // target contract being analysed (C...)
  wasmHash: string;         // hex-encoded SHA-256
  upgradeable: boolean;
  sourceVerified: boolean;
  adminPower: boolean;
  maturityScore: number;    // 0-10
}

export interface RelayerResult {
  txHash: string;
  ledger: number;
  success: boolean;
  error?: string;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

/** Convert a hex WASM hash string to a 32-byte xdr.ScVal (BytesN<32>). */
function wasmHashToScVal(hexHash: string): xdr.ScVal {
  const buf = Buffer.from(hexHash, "hex");
  if (buf.length !== 32) {
    throw new Error(`WASM hash must be 32 bytes, got ${buf.length}`);
  }
  return xdr.ScVal.scvBytes(buf);
}

/** Poll for transaction confirmation with exponential back-off. */
async function waitForTransaction(
  server: SorobanRpc.Server,
  txHash: string,
  maxAttempts = 15
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  let attempts = 0;
  let delay = 1000;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, delay));
    const result = await server.getTransaction(txHash);

    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }

    attempts++;
    delay = Math.min(delay * 1.5, 8000);
  }

  throw new Error(`Transaction ${txHash} not confirmed after ${maxAttempts} attempts`);
}

// ─────────────────────────── main export ─────────────────────────────────────

export class Relayer {
  private keypair: Keypair;
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: RelayerConfig;

  constructor(config: RelayerConfig) {
    this.config = config;
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.contractId);
  }

  /**
   * Submit set_flags() to the Report Card registry for a specific contract.
   * This is the primary write path used by the off-chain engine.
   */
  async setFlags(params: SetFlagsParams): Promise<RelayerResult> {
    const passphrase = networkPassphrase(this.config.network);
    const timeout = this.config.timeoutSeconds ?? 30;

    try {
      // Load the relayer's account sequence number.
      const account = await this.server.getAccount(this.keypair.publicKey());

      // Build the transaction.
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          this.contract.call(
            "set_flags",
            // contract_id: Address
            new Address(params.contractId).toScVal(),
            // wasm_hash: BytesN<32>
            wasmHashToScVal(params.wasmHash),
            // upgradeable: bool
            nativeToScVal(params.upgradeable, { type: "bool" }),
            // source_verified: bool
            nativeToScVal(params.sourceVerified, { type: "bool" }),
            // admin_power: bool
            nativeToScVal(params.adminPower, { type: "bool" }),
            // maturity_score: u32
            nativeToScVal(params.maturityScore, { type: "u32" })
          )
        )
        .setTimeout(timeout)
        .build();

      // Simulate to get the footprint and resource fee.
      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        return {
          txHash: "",
          ledger: 0,
          success: false,
          error: `Simulation failed: ${simResult.error}`,
        };
      }

      // Assemble the transaction with the simulation result (sorobanData).
      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(this.keypair);

      // Submit.
      const submitResult = await this.server.sendTransaction(preparedTx);
      if (submitResult.status === "ERROR") {
        return {
          txHash: submitResult.hash,
          ledger: 0,
          success: false,
          error: `Submit error: ${JSON.stringify(submitResult.errorResult)}`,
        };
      }

      // Poll for confirmation.
      const confirmed = await waitForTransaction(this.server, submitResult.hash);
      const success = confirmed.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS;

      return {
        txHash: submitResult.hash,
        ledger: (confirmed as any).ledger ?? 0,
        success,
        error: success ? undefined : `Transaction failed: ${confirmed.status}`,
      };
    } catch (err) {
      return {
        txHash: "",
        ledger: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Convenience wrapper: derive maturity_score (0-10) from raw meta then
   * call setFlags in a single step.
   */
  async submitVerdict(
    targetContractId: string,
    wasmHash: string,
    analysis: WasmAnalysisResult,
    sourceVerified: boolean,
    ageDays: number,
    distinctAccounts: number,
    tvlProxy: number
  ): Promise<RelayerResult> {
    // Derive 0-10 maturity score from continuous signals.
    const ageScore =
      ageDays >= 365 ? 4 : ageDays >= 90 ? 3 : ageDays >= 30 ? 2 : ageDays >= 7 ? 1 : 0;
    const accountScore =
      distinctAccounts >= 1000 ? 3 : distinctAccounts >= 100 ? 2 : distinctAccounts >= 10 ? 1 : 0;
    const tvlScore =
      tvlProxy >= 100000 ? 3 : tvlProxy >= 10000 ? 2 : tvlProxy >= 1000 ? 1 : 0;
    const maturityScore = Math.min(ageScore + accountScore + tvlScore, 10);

    return this.setFlags({
      contractId: targetContractId,
      wasmHash,
      upgradeable: analysis.upgradeable,
      sourceVerified,
      adminPower: analysis.adminPower,
      maturityScore,
    });
  }
}
