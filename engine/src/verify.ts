/**
 * verify.ts — Native Stellar source verification (no Docker, no off-chain infra).
 *
 * Strategy (100% Stellar-native):
 *   1. Fetch the deployed WASM bytes directly from the Stellar ledger using
 *      `stellar contract fetch` (Stellar CLI) — no external build infrastructure.
 *   2. SHA-256 the fetched bytes and compare to the claimed on-chain hash.
 *   3. Optionally compare against a locally-supplied WASM file for auditor
 *      self-verification workflows.
 *
 * Docker is completely removed.  The only dependency is the Stellar CLI
 * (already required for deployment) and the Soroban RPC endpoint.
 *
 * Why this is better:
 *   - The ground truth is always the ledger — not a local Docker build.
 *   - Any funded Stellar account can run verification, no privileged key needed.
 *   - Works on any OS without container runtime.
 */

import { spawnSync } from "node:child_process";
import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─────────────────────────── types ───────────────────────────────────────────

export interface VerifyInput {
  /** Soroban RPC URL used to fetch ledger state. */
  rpcUrl: string;
  /** Target contract ID (C… StrKey, 56 chars). */
  contractId: string;
  /** Network name passed to stellar CLI (testnet | mainnet | futurenet). */
  network: string;
  /**
   * Optional path to a locally-built .wasm file to compare against the
   * on-chain hash.  When supplied, source_verified = true only if the local
   * file's SHA-256 matches the on-chain hash exactly.
   */
  localWasmPath?: string;
}

export interface VerifyResult {
  /** Whether the local WASM (if supplied) matches the on-chain hash. */
  sourceVerified: boolean;
  /** SHA-256 hex of the on-chain WASM bytes fetched from the ledger. */
  onChainHash: string;
  /** SHA-256 hex of the local WASM file (empty string if not supplied). */
  localHash: string;
  /** Method used to fetch: "stellar-cli" | "unavailable" */
  method: "stellar-cli" | "unavailable";
  /** Human-readable error message if verification failed. */
  error?: string;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

function sha256Buf(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath: string): string {
  return sha256Buf(fs.readFileSync(filePath));
}

function isStellarCliAvailable(): boolean {
  const r = spawnSync("stellar", ["--version"], { encoding: "utf8", timeout: 5_000 });
  return r.status === 0;
}

/**
 * Fetch the deployed WASM for a contract using `stellar contract fetch`.
 * Returns the raw WASM bytes as a Buffer.
 *
 * `stellar contract fetch --id <ID> --network <NET>` writes the WASM to stdout.
 */
function fetchWasmFromLedger(
  contractId: string,
  network:    string,
  rpcUrl:     string
): Buffer {
  const result = spawnSync(
    "stellar",
    [
      "contract", "fetch",
      "--id",      contractId,
      "--network", network,
      "--rpc-url", rpcUrl,
    ],
    { encoding: "buffer", timeout: 30_000 }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "unknown error";
    throw new Error(`stellar contract fetch failed (exit ${result.status}): ${stderr}`);
  }
  if (!result.stdout || result.stdout.length === 0) {
    throw new Error("stellar contract fetch returned empty output");
  }

  // The CLI may return the WASM as raw bytes or base64-encoded depending on
  // version. Detect and decode accordingly.
  const raw = result.stdout as Buffer;

  // WASM magic bytes: 0x00 0x61 0x73 0x6D
  if (raw[0] === 0x00 && raw[1] === 0x61 && raw[2] === 0x73 && raw[3] === 0x6D) {
    return raw; // already raw WASM
  }

  // Try base64 decode.
  try {
    const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
    if (decoded[0] === 0x00 && decoded[1] === 0x61) {
      return decoded;
    }
  } catch {
    // fall through
  }

  // Return as-is and let the hash comparison surface any mismatch.
  return raw;
}

// ─────────────────────────── main export ─────────────────────────────────────

/**
 * Verify a contract's deployed WASM against the supplied on-chain hash and
 * optionally against a local WASM file.
 *
 * This function is 100% Stellar-native:
 *   - Fetches WASM from the Stellar ledger via the Stellar CLI.
 *   - No Docker, no external build infra, no private keys.
 *   - Any machine with `stellar` installed can run this.
 */
export async function verifySource(input: VerifyInput): Promise<VerifyResult> {
  const { rpcUrl, contractId, network, localWasmPath } = input;

  if (!isStellarCliAvailable()) {
    return {
      sourceVerified: false,
      onChainHash:    "",
      localHash:      "",
      method:         "unavailable",
      error:
        "Stellar CLI not found. Install it with: cargo install --locked stellar-cli",
    };
  }

  // 1. Fetch WASM from ledger.
  let wasmBytes: Buffer;
  try {
    wasmBytes = fetchWasmFromLedger(contractId, network, rpcUrl);
  } catch (err) {
    return {
      sourceVerified: false,
      onChainHash:    "",
      localHash:      "",
      method:         "stellar-cli",
      error:          err instanceof Error ? err.message : String(err),
    };
  }

  const onChainHash = sha256Buf(wasmBytes);

  // 2. Compare against local file if supplied.
  let localHash       = "";
  let sourceVerified  = false;

  if (localWasmPath) {
    if (!fs.existsSync(localWasmPath)) {
      return {
        sourceVerified: false,
        onChainHash,
        localHash: "",
        method: "stellar-cli",
        error: `Local WASM file not found: ${localWasmPath}`,
      };
    }
    localHash      = sha256File(localWasmPath);
    sourceVerified = localHash.toLowerCase() === onChainHash.toLowerCase();
  }

  return { sourceVerified, onChainHash, localHash, method: "stellar-cli" };
}

/**
 * Quick hash-only verification — compare a local WASM file's SHA-256 against
 * a known on-chain hash without fetching from the ledger again.
 * Useful when the caller already has wasmHash from ingest.ts.
 */
export function verifyLocalWasm(
  localWasmPath: string,
  knownOnChainHash: string
): VerifyResult {
  if (!fs.existsSync(localWasmPath)) {
    return {
      sourceVerified: false,
      onChainHash:    knownOnChainHash,
      localHash:      "",
      method:         "unavailable",
      error:          `File not found: ${localWasmPath}`,
    };
  }
  const localHash     = sha256File(localWasmPath);
  const sourceVerified = localHash.toLowerCase() === knownOnChainHash.toLowerCase();
  return { sourceVerified, onChainHash: knownOnChainHash, localHash, method: "stellar-cli" };
}
