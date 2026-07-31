/**
 * index.ts — Engine scheduler / entrypoint
 *
 * Runs the full analysis pipeline for a list of contracts:
 *   ingest → analyse WASM → verify source → score → relay verdict on-chain
 *
 * Usage:
 *   pnpm start                         # process contracts in data/contracts.json
 *   pnpm start -- --contract <ID>      # process a single contract
 *   pnpm start -- --once               # run once and exit (no scheduler loop)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWasm, fetchContractMeta, TESTNET_CONFIG, MAINNET_CONFIG } from "./ingest.js";
import { analyzeWasm, computeScore } from "./scoring.js";
import { verifySource } from "./verify.js";
import { Relayer } from "./relayer.js";
import type { StellarNetwork, NetworkConfig } from "@reportcard/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────── config ──────────────────────────────────────────

interface ContractEntry {
  contractId: string;
  repoUrl?: string;
  commitSha?: string;
  contractPath?: string;
  crateName?: string;
}

interface EngineConfig {
  network: StellarNetwork;
  relayerSecret: string;
  registryContractId: string;
  intervalMs: number;
  sorobanRpcUrl: string;       // from env: SOROBAN_RPC_URL
  horizonUrl: string;          // from env: HORIZON_URL
  contracts: ContractEntry[];
}

function loadConfig(): EngineConfig {
  const network =
    (process.env["STELLAR_NETWORK"] as StellarNetwork) ?? "testnet";
  const relayerSecret = process.env["RELAYER_SECRET"] ?? "";
  const registryContractId = process.env["REGISTRY_CONTRACT_ID"] ?? "";
  const intervalMs = parseInt(process.env["ENGINE_INTERVAL_MS"] ?? "300000", 10);

  // Override RPC/Horizon endpoints from env, falling back to the shared defaults.
  const defaultNet = network === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
  const sorobanRpcUrl = process.env["SOROBAN_RPC_URL"] ?? defaultNet.rpcUrl;
  const horizonUrl    = process.env["HORIZON_URL"]     ?? defaultNet.horizonUrl;

  if (!relayerSecret || !registryContractId) {
    console.warn(
      "[engine] RELAYER_SECRET or REGISTRY_CONTRACT_ID not set — " +
        "will run in dry-run mode (no on-chain writes)."
    );
  }

  // Load contract list from data/contracts.json (relative to project root).
  const dataPath = path.resolve(__dirname, "../../data/contracts.json");
  let contracts: ContractEntry[] = [];
  if (fs.existsSync(dataPath)) {
    contracts = JSON.parse(fs.readFileSync(dataPath, "utf8")) as ContractEntry[];
  }

  // CLI override: --contract <ID>
  const cliIdx = process.argv.indexOf("--contract");
  if (cliIdx !== -1 && process.argv[cliIdx + 1]) {
    contracts = [{ contractId: process.argv[cliIdx + 1]! }];
  }

  return {
    network,
    relayerSecret,
    registryContractId,
    intervalMs,
    sorobanRpcUrl,
    horizonUrl,
    contracts,
  };
}

// ─────────────────────────── pipeline ────────────────────────────────────────

async function analyseContract(
  entry: ContractEntry,
  config: EngineConfig,
  relayer: Relayer | null
): Promise<void> {
  const { contractId } = entry;

  // Build a NetworkConfig from the resolved env values so every downstream
  // call uses the same endpoints (not the hardcoded TESTNET_CONFIG defaults).
  const netConfig: NetworkConfig = {
    rpcUrl:            config.sorobanRpcUrl,
    horizonUrl:        config.horizonUrl,
    network:           config.network,
    networkPassphrase:
      config.network === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
  };

  console.log(`[engine] Analysing ${contractId} …`);

  // 1. Fetch WASM
  let wasmInfo: Awaited<ReturnType<typeof fetchWasm>>;
  try {
    wasmInfo = await fetchWasm(contractId, netConfig);
    console.log(
      `  WASM fetched: ${wasmInfo.wasmSize} bytes, hash=${wasmInfo.wasmHash.slice(0, 16)}…`
    );
  } catch (err) {
    console.error(`  [SKIP] WASM fetch failed: ${err}`);
    return;
  }

  // 2. Static WASM analysis
  const analysis = analyzeWasm(wasmInfo.wasmBytes);
  console.log(
    `  upgradeable=${analysis.upgradeable}, adminPower=${analysis.adminPower}, ` +
      `hostFunctions=[${analysis.hostFunctions.join(", ")}]`
  );
  if (analysis.warnings.length) {
    analysis.warnings.forEach((w) => console.warn(`  ⚠  ${w}`));
  }

  // 3. Fetch contract metadata (Horizon)
  const meta = await fetchContractMeta(contractId, netConfig).catch(() => null);
  const ageDays = meta
    ? Math.floor((Date.now() / 1000 - meta.createdAtTimestamp) / 86400)
    : 0;

  // 4. Source verification (optional — only if repoUrl + commitSha provided)
  let sourceVerified = false;
  if (entry.repoUrl && entry.commitSha) {
    console.log(`  Verifying source: ${entry.repoUrl}@${entry.commitSha} …`);
    const vr = await verifySource({
      onChainHash: wasmInfo.wasmHash,
      repoUrl: entry.repoUrl,
      commitSha: entry.commitSha,
      contractPath: entry.contractPath,
      crateName: entry.crateName,
      useDocker: true,
    });
    sourceVerified = vr.sourceVerified;
    console.log(
      `  source_verified=${vr.sourceVerified} (method=${vr.method})` +
        (vr.error ? ` error=${vr.error}` : "")
    );
  }

  // 5. Compute score (dry-run / logging — on-chain grade is computed by the contract)
  const scoreResult = computeScore({
    attestations: [],           // on-chain attestations not fetched here; contract does this
    sourceVerified,
    upgradeable: analysis.upgradeable,
    adminPower: analysis.adminPower,
    ageDays,
    distinctAccounts: meta?.distinctAccounts ?? 0,
    tvlProxy: meta?.tvlProxy ?? 0,
  });
  console.log(
    `  Computed grade: ${scoreResult.grade} (score=${scoreResult.score}) — ${scoreResult.explanation}`
  );

  // 6. Submit verdict on-chain
  if (relayer) {
    const result = await relayer.submitVerdict(
      contractId,
      wasmInfo.wasmHash,
      analysis,
      sourceVerified,
      ageDays,
      meta?.distinctAccounts ?? 0,
      meta?.tvlProxy ?? 0
    );
    if (result.success) {
      console.log(`  ✓ Verdict written on-chain: txHash=${result.txHash}`);
    } else {
      console.error(`  ✗ Relayer error: ${result.error}`);
    }
  } else {
    console.log(
      "  [dry-run] No RELAYER_SECRET — skipping on-chain write."
    );
  }
}

// ─────────────────────────── scheduler ───────────────────────────────────────

async function runOnce(config: EngineConfig, relayer: Relayer | null): Promise<void> {
  if (config.contracts.length === 0) {
    console.warn("[engine] No contracts to analyse. Add entries to data/contracts.json.");
    return;
  }

  for (const entry of config.contracts) {
    await analyseContract(entry, config, relayer).catch((err) =>
      console.error(`[engine] Unhandled error for ${entry.contractId}: ${err}`)
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const once = process.argv.includes("--once");

  const relayer =
    config.relayerSecret && config.registryContractId
      ? new Relayer({
          secretKey: config.relayerSecret,
          contractId: config.registryContractId,
          rpcUrl: config.sorobanRpcUrl,
          network: config.network,
        })
      : null;

  console.log(
    `[engine] Starting Report Card engine (network=${config.network}, ` +
      `contracts=${config.contracts.length}, dry-run=${relayer === null})`
  );

  await runOnce(config, relayer);

  if (!once) {
    setInterval(() => {
      runOnce(config, relayer).catch(console.error);
    }, config.intervalMs);
    console.log(`[engine] Scheduler started — interval=${config.intervalMs}ms`);
  }
}

main().catch((err) => {
  console.error("[engine] Fatal:", err);
  process.exit(1);
});
