/**
 * ingest.ts — Soroban RPC + Horizon data pull
 *
 * Fetches:
 *   - Deployed WASM bytecode for a contract (via getLedgerEntries)
 *   - Contract creation ledger + transaction count (Horizon)
 *   - Distinct account count interacting with the contract (Horizon)
 */

import { SorobanRpc, Contract, xdr } from "@stellar/stellar-sdk";
import * as crypto from "node:crypto";
import type { NetworkConfig } from "@reportcard/types";
import { TESTNET as TESTNET_DEFAULTS, MAINNET as MAINNET_DEFAULTS } from "@reportcard/types";

// Re-export the network configs using the names expected by engine/index.ts.
export type { NetworkConfig };
export type IngestConfig = NetworkConfig;

export const TESTNET_CONFIG: IngestConfig = TESTNET_DEFAULTS;
export const MAINNET_CONFIG: IngestConfig = MAINNET_DEFAULTS;

// ─────────────────────────── types ───────────────────────────────────────────

export interface WasmInfo {
  wasmHash: string;        // hex SHA-256 of the WASM bytes
  wasmBytes: Buffer;       // raw WASM bytecode
  wasmSize: number;        // bytes
}

export interface ContractMeta {
  contractId: string;
  wasmHash: string;
  createdAtLedger: number;
  createdAtTimestamp: number;
  txCount: number;          // approximate operation count from Horizon
  distinctAccounts: number; // approximate unique callers
  tvlProxy: number;         // native XLM balance held (proxy for TVL)
}

// ─────────────────────────── RPC helpers ─────────────────────────────────────

/**
 * Fetch the WASM bytecode for a deployed contract.
 *
 * Strategy:
 *   1. getLedgerEntries(ContractData) to get the WASM hash stored under the
 *      contract's instance key.
 *   2. getLedgerEntries(ContractCode) to get the actual WASM bytes.
 */
export async function fetchWasm(
  contractId: string,
  config: IngestConfig = TESTNET_CONFIG
): Promise<WasmInfo> {
  const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

  // Step 1: get the contract instance ledger entry to extract the wasm_hash.
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(contractId).address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const instanceResult = await server.getLedgerEntries(instanceKey);
  if (!instanceResult.entries || instanceResult.entries.length === 0) {
    throw new Error(`Contract ${contractId} not found on ledger`);
  }

  const instanceEntry = instanceResult.entries[0].val;
  const contractInstance =
    instanceEntry.contractData().val().instance();
  const executableType = contractInstance.executable().switch();

  let wasmHashBytes: Buffer;

  if (executableType.name === "contractExecutableWasm") {
    wasmHashBytes = Buffer.from(
      contractInstance.executable().wasmHash()
    );
  } else {
    throw new Error(`Contract ${contractId} is a built-in (stellar asset contract), not WASM`);
  }

  const wasmHashHex = wasmHashBytes.toString("hex");

  // Step 2: fetch the actual WASM bytes from the ContractCode ledger entry.
  const codeKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: wasmHashBytes,
    })
  );

  const codeResult = await server.getLedgerEntries(codeKey);
  if (!codeResult.entries || codeResult.entries.length === 0) {
    throw new Error(`WASM code for hash ${wasmHashHex} not found on ledger`);
  }

  const wasmBytes = Buffer.from(
    codeResult.entries[0].val.contractCode().code()
  );

  // Verify the hash matches what the contract instance declared.
  const computedHash = crypto
    .createHash("sha256")
    .update(wasmBytes)
    .digest("hex");

  if (computedHash !== wasmHashHex) {
    throw new Error(
      `WASM hash mismatch: declared=${wasmHashHex}, computed=${computedHash}`
    );
  }

  return {
    wasmHash: wasmHashHex,
    wasmBytes,
    wasmSize: wasmBytes.length,
  };
}

// ─────────────────────────── Horizon helpers ─────────────────────────────────

interface HorizonOperationsPage {
  _embedded: { records: Array<{ type: string; source_account: string; created_at: string }> };
  _links: { next?: { href: string } };
}

/**
 * Fetch contract metadata from Horizon: creation ledger, tx/op count,
 * distinct callers, and native XLM balance as a TVL proxy.
 */
export async function fetchContractMeta(
  contractId: string,
  config: IngestConfig = TESTNET_CONFIG
): Promise<ContractMeta> {
  const base = config.horizonUrl.replace(/\/$/, "");

  // ── creation time via contract data ──────────────────────────────────────
  // Horizon does not expose a "created_at" for contract IDs directly, so we
  // fall back to the Soroban RPC getLedgerEntries latestLedger as an upper
  // bound and use 0 when unavailable.
  let createdAtLedger = 0;
  let createdAtTimestamp = 0;

  try {
    const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });
    const latest = await server.getLatestLedger();
    createdAtLedger = latest.sequence; // approximation; real value needs event indexing
    createdAtTimestamp = Math.floor(Date.now() / 1000);
  } catch {
    // non-fatal — degrade gracefully
  }

  // ── operation count + distinct accounts ──────────────────────────────────
  let txCount = 0;
  const accountSet = new Set<string>();
  let url: string | null =
    `${base}/operations?limit=200&order=asc&include_failed=false`;

  // Page through Horizon operations and filter those invoking this contract.
  // Cap at 1000 records to avoid excessive network calls in the engine.
  let pages = 0;
  while (url && pages < 5) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) break;
      const page: HorizonOperationsPage = await resp.json() as HorizonOperationsPage;
      for (const op of page._embedded.records) {
        if (
          op.type === "invoke_host_function" &&
          // Horizon embeds the contract ID in the operation; filter client-side.
          JSON.stringify(op).includes(contractId)
        ) {
          txCount++;
          if (op.source_account) accountSet.add(op.source_account);
        }
      }
      url = page._links?.next?.href ?? null;
      pages++;
    } catch {
      break;
    }
  }

  // ── native XLM balance (TVL proxy) ───────────────────────────────────────
  let tvlProxy = 0;
  try {
    // Contract addresses on Horizon are the C… StrKey form.
    const accountResp = await fetch(`${base}/accounts/${contractId}`);
    if (accountResp.ok) {
      const acctData = await accountResp.json() as { balances: Array<{ asset_type: string; balance: string }> };
      for (const bal of acctData.balances) {
        if (bal.asset_type === "native") {
          tvlProxy = parseFloat(bal.balance);
        }
      }
    }
  } catch {
    // non-fatal
  }

  return {
    contractId,
    wasmHash: "", // caller fills this in from fetchWasm result
    createdAtLedger,
    createdAtTimestamp,
    txCount,
    distinctAccounts: accountSet.size,
    tvlProxy,
  };
}
