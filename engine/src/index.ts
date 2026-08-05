/**
 * index.ts — Permissionless engine scheduler / entrypoint.
 *
 * DECENTRALISATION:
 *   - No RELAYER_SECRET required.  Any funded Stellar account can submit flags.
 *   - No Docker.  Source verification uses `stellar contract fetch` to pull
 *     WASM directly from the ledger and hash it.
 *   - The engine is a stateless observer: it reads from Stellar, computes
 *     analysis, and writes back to Stellar.  No database, no off-chain store.
 *
 * Usage:
 *   node dist/index.js                    # process all contracts in data/contracts.json
 *   node dist/index.js --contract <ID>    # single contract
 *   node dist/index.js --once             # run once and exit
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchWasm, fetchContractMeta, TESTNET_CONFIG, MAINNET_CONFIG } from "./ingest.js";
import { analyzeWasm, computeScore } from "./scoring.js";
import { verifySource }              from "./verify.js";
import { Relayer }                   from "./relayer.js";
import type { StellarNetwork, NetworkConfig } from "@reportcard/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────── types ───────────────────────────────────────────

interface ContractEntry {
  contractId:    string;
  /** Optional path to a locally-built WASM for source verification. */
  localWasmPath?: string;
}

interface EngineConfig {
  network:            StellarNetwork;
  /**
   * Optional: secret key of ANY funded Stellar account.
   * Not a privileged key — just pays the transaction fee.
   * If unset the engine runs in dry-run mode.
   */
  submitterSecret:    string;
  registryContractId: string;
  intervalMs:         number;
  sorobanRpcUrl:      string;
  horizonUrl:         string;
  contracts:          ContractEntry[];
}

// ─────────────────────────── config ──────────────────────────────────────────

function loadConfig(): EngineConfig {
  const network = (process.env["STELLAR_NETWORK"] as StellarNetwork) ?? "testnet";

  const defaultNet  = network === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
  const sorobanRpcUrl = process.env["SOROBAN_RPC_URL"] ?? defaultNet.rpcUrl;
  const horizonUrl    = process.env["HORIZON_URL"]     ?? defaultNet.horizonUrl;

  // SUBMITTER_SECRET replaces the old RELAYER_SECRET.
  // It is NOT a privileged key — any funded account works.
  const submitterSecret    = process.env["SUBMITTER_SECRET"]    ?? "";
  const registryContractId = process.env["REGISTRY_CONTRACT_ID"] ?? "";

  if (!submitterSecret || !registryContractId) {
    console.warn(
      "[engine] SUBMITTER_SECRET or REGISTRY_CONTRACT_ID not set — " +
        "running in dry-run mode (analysis only, no on-chain writes)."
    );
  }

  const dataPath = path.resolve(__dirname, "../../data/contracts.json");
  let contracts: ContractEntry[] = [];
  if (fs.existsSync(dataPath)) {
    contracts = JSON.parse(fs.readFileSync(dataPath, "utf8")) as ContractEntry[];
  }

  const cliIdx = process.argv.indexOf("--contract");
  if (cliIdx !== -1 && process.argv[cliIdx + 1]) {
    contracts = [{ contractId: process.argv[cliIdx + 1]! }];
  }

  return {
    network,
    submitterSecret,
    registryContractId,
    intervalMs: parseInt(process.env["ENGINE_INTERVAL_MS"] ?? "300000", 10),
    sorobanRpcUrl,
    horizonUrl,
    contracts,
  };
}

// ─────────────────────────── pipeline ────────────────────────────────────────

async function analyseContract(
  entry:   ContractEntry,
  config:  EngineConfig,
  relayer: Relayer | null
): Promise<void> {
  const { contractId } = entry;

  const netConfig: NetworkConfig = {
    rpcUrl:            config.sorobanRpcUrl,
    horizonUrl:        config.horizonUrl,
    network:           config.network,
    networkPassphrase:
      config.network === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
  };

  console.log(`\n[engine] ── Analysing ${contractId} ──`);

  // 1. Fetch WASM from ledger via Soroban RPC.
  let wasmInfo: Awaited<ReturnType<typeof fetchWasm>>;
  try {
    wasmInfo = await fetchWasm(contractId, netConfig);
    console.log(`  WASM: ${wasmInfo.wasmSize} bytes  hash=${wasmInfo.wasmHash.slice(0, 16)}…`);
  } catch (err) {
    console.error(`  [SKIP] WASM fetch failed: ${err}`);
    return;
  }

  // 2. Static WASM analysis (byte-pattern detection — no runtime execution).
  const analysis = analyzeWasm(wasmInfo.wasmBytes);
  console.log(
    `  upgradeable=${analysis.upgradeable}  adminPower=${analysis.adminPower}` +
    `  hostFns=[${analysis.hostFunctions.slice(0, 4).join(", ")}${analysis.hostFunctions.length > 4 ? "…" : ""}]`
  );
  analysis.warnings.forEach(w => console.warn(`  ⚠  ${w}`));

  // 3. Fetch Horizon metadata for maturity scoring.
  const meta    = await fetchContractMeta(contractId, netConfig).catch(() => null);
  const ageDays = meta
    ? Math.floor((Date.now() / 1000 - meta.createdAtTimestamp) / 86400)
    : 0;

  // 4. Source verification — Stellar-native: fetch WASM from ledger and hash it.
  //    If a localWasmPath is provided, compare the local build to the on-chain hash.
  //    No Docker, no external build infra.
  let sourceVerified = false;
  if (entry.localWasmPath) {
    console.log(`  Verifying source against local WASM: ${entry.localWasmPath}`);
    const vr = await verifySource({
      rpcUrl:        config.sorobanRpcUrl,
      contractId,
      network:       config.network,
      localWasmPath: entry.localWasmPath,
    });
    sourceVerified = vr.sourceVerified;
    console.log(
      `  source_verified=${vr.sourceVerified}  method=${vr.method}` +
      (vr.error ? `  error=${vr.error}` : "")
    );
  } else {
    console.log("  No localWasmPath provided — skipping source verification.");
  }

  // 5. Score computation (dry-run log — on-chain grade is recomputed by contract).
  const score = computeScore({
    attestations:     [],
    sourceVerified,
    upgradeable:      analysis.upgradeable,
    adminPower:       analysis.adminPower,
    ageDays,
    distinctAccounts: meta?.distinctAccounts ?? 0,
    tvlProxy:         meta?.tvlProxy ?? 0,
  });
  console.log(`  Grade preview: ${score.grade} (score=${score.score})  ${score.explanation}`);

  // 6. Submit verdict on-chain — permissionless, no privileged key.
  if (relayer) {
    const result = await relayer.submitVerdict(
      contractId,
      wasmInfo.wasmHash,
      analysis,
      sourceVerified,
      ageDays,
      meta?.distinctAccounts ?? 0,
      meta?.tvlProxy ?? 0,
    );
    if (result.success) {
      console.log(`  ✓ Flags written on-chain  txHash=${result.txHash}`);
    } else if (result.error?.startsWith("UNSIGNED_XDR:")) {
      console.log("  ⚡ Unsigned XDR returned — sign and submit via wallet.");
    } else {
      console.error(`  ✗ Submit error: ${result.error}`);
    }
  } else {
    console.log("  [dry-run] No SUBMITTER_SECRET — skipping on-chain write.");
  }
}

// ─────────────────────────── scheduler ───────────────────────────────────────

async function runOnce(config: EngineConfig, relayer: Relayer | null): Promise<void> {
  if (config.contracts.length === 0) {
    console.warn("[engine] No contracts to analyse — add entries to data/contracts.json.");
    return;
  }
  for (const entry of config.contracts) {
    await analyseContract(entry, config, relayer).catch(err =>
      console.error(`[engine] Error for ${entry.contractId}: ${err}`)
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const once   = process.argv.includes("--once");

  const relayer =
    config.submitterSecret && config.registryContractId
      ? new Relayer({
          secretKey:  config.submitterSecret,
          contractId: config.registryContractId,
          rpcUrl:     config.sorobanRpcUrl,
          network:    config.network,
        })
      : null;

  console.log(
    `[engine] Report Card engine started\n` +
    `  network   = ${config.network}\n` +
    `  contracts = ${config.contracts.length}\n` +
    `  dry-run   = ${relayer === null}\n` +
    `  rpc       = ${config.sorobanRpcUrl}`
  );

  await runOnce(config, relayer);

  if (!once) {
    setInterval(() => runOnce(config, relayer).catch(console.error), config.intervalMs);
    console.log(`[engine] Scheduler running — interval=${config.intervalMs}ms`);
  }
}

main().catch(err => {
  console.error("[engine] Fatal:", err);
  process.exit(1);
});
