/**
 * registry.ts
 *
 * Client for the on-chain Report Card registry contract.
 * Compatible with @stellar/stellar-sdk v16 (SorobanRpc is now exported as `rpc`).
 *
 * Two entry-points:
 *   fetchSafetyRecord(contractId) — server-side view call via Soroban RPC
 *   submitAttestation(params)     — client-side signed transaction via wallet
 */

import {
  Contract,
  rpc,            // v16: was SorobanRpc in v13
  scValToNative,
  xdr,
  Address,
  nativeToScVal,
  Account,
  TransactionBuilder,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";

import type {
  SafetyRecord,
  GradeLetter,
  GradeNumeric,
  WalletKit,
} from "@reportcard/types";

import { UNKNOWN_RECORD } from "@reportcard/types";

export type { SafetyRecord, GradeLetter };
export { UNKNOWN_RECORD };

// ─────────────────────────── env ─────────────────────────────────────────────

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

const REGISTRY_ID =
  process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID ?? "";

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;

// ─────────────────────────── RPC helpers ─────────────────────────────────────

function getServer(): rpc.Server {
  return new rpc.Server(RPC_URL, { allowHttp: false });
}

function getContract(): Contract {
  if (!REGISTRY_ID) {
    throw new Error(
      "NEXT_PUBLIC_REGISTRY_CONTRACT_ID is not set. " +
        "Deploy the contract and add it to .env.local."
    );
  }
  return new Contract(REGISTRY_ID);
}

function buildViewTransaction(operation: xdr.Operation) {
  // A dummy source account — simulateTransaction doesn't require a funded account.
  const DUMMY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
  return new TransactionBuilder(new Account(DUMMY, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(10)
    .build();
}

// ─────────────────────────── data parsing ────────────────────────────────────

function bufToHex(val: unknown): string {
  if (val instanceof Uint8Array) return Buffer.from(val).toString("hex");
  if (typeof val === "string") return val;
  return "0".repeat(64);
}

function parseRecord(raw: Record<string, unknown>): SafetyRecord {
  const grade = (raw["grade"] as Record<string, unknown>) ?? {};
  return {
    grade: {
      letter: String(grade["letter"] ?? "F") as GradeLetter,
      score: Number(grade["score"] ?? 0),
      numeric: Number(grade["numeric"] ?? 1) as GradeNumeric,
    },
    upgradeable: Boolean(raw["upgradeable"] ?? true),
    sourceVerified: Boolean(raw["source_verified"] ?? false),
    wasmHash: bufToHex(raw["wasm_hash"]),
    attestationCount: Number(raw["attestation_count"] ?? 0),
    adminPower: Boolean(raw["admin_power"] ?? true),
    maturityScore: Number(raw["maturity_score"] ?? 0),
  };
}

// ─────────────────────────── read ────────────────────────────────────────────

/**
 * Call is_safe(contractId) on the registry and return a typed SafetyRecord.
 * Returns UNKNOWN_RECORD when the registry ID is unset or the RPC call fails.
 */
export async function fetchSafetyRecord(
  contractId: string
): Promise<SafetyRecord> {
  if (!REGISTRY_ID) return UNKNOWN_RECORD;

  try {
    const server = getServer();
    const contract = getContract();

    const result = await server.simulateTransaction(
      buildViewTransaction(
        contract.call("is_safe", new Address(contractId).toScVal())
      )
    );

    if (rpc.Api.isSimulationError(result)) {
      console.error("[registry] simulateTransaction error:", result.error);
      return UNKNOWN_RECORD;
    }

    if (!result.result?.retval) return UNKNOWN_RECORD;

    const native = scValToNative(result.result.retval) as Record<string, unknown>;
    return parseRecord(native);
  } catch (err) {
    console.error("[registry] fetchSafetyRecord error:", err);
    return UNKNOWN_RECORD;
  }
}

// ─────────────────────────── write ───────────────────────────────────────────

export interface SubmitAttestationParams {
  auditorAddress: string;
  contractId: string;
  wasmHash: string;   // hex SHA-256, 64 chars
  verdict: boolean;
  confidence: number; // 1–100
  kit: WalletKit;
}

export async function submitAttestation(
  params: SubmitAttestationParams
): Promise<string> {
  const { auditorAddress, contractId, wasmHash, verdict, confidence, kit } = params;

  const server = getServer();
  const contract = getContract();
  const account = await server.getAccount(auditorAddress);

  const wasmHashBytes = Buffer.from(wasmHash, "hex");
  if (wasmHashBytes.length !== 32) {
    throw new Error("WASM hash must be exactly 32 bytes (64 hex chars).");
  }

  const dummySig = new Uint8Array(64);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "submit_attestation",
        new Address(auditorAddress).toScVal(),
        new Address(contractId).toScVal(),
        xdr.ScVal.scvBytes(wasmHashBytes),
        nativeToScVal(verdict, { type: "bool" }),
        nativeToScVal(confidence, { type: "u32" }),
        xdr.ScVal.scvBytes(dummySig)
      )
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();

  const { signedTxXdr } = await kit.signTransaction(prepared.toXDR(), {
    address: auditorAddress,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const submitResult = await server.sendTransaction(signedTx);

  if (submitResult.status === "ERROR") {
    throw new Error(
      `Transaction submit failed: ${JSON.stringify(submitResult.errorResult)}`
    );
  }

  return submitResult.hash;
}
