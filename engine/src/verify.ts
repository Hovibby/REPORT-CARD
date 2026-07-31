/**
 * verify.ts — Source verification (M3)
 *
 * Checks whether a reproducible build of a public Git repo produces a WASM
 * binary whose SHA-256 matches the on-chain WASM hash.
 *
 * Strategy
 * ────────
 * 1. Clone / pull the repo at the specified commit.
 * 2. Run the build inside a deterministic Docker container (or natively if
 *    Docker is unavailable — degrade gracefully to source_verified=false).
 * 3. Optimise the output WASM the same way stellar contract optimize does.
 * 4. Hash the result and compare to the on-chain hash.
 *
 * The Docker image is `stellar/soroban-env-host:latest` which ships a pinned
 * Rust toolchain, soroban-cli, and wasm-opt so builds are reproducible across
 * machines.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─────────────────────────── types ───────────────────────────────────────────

export interface VerifyInput {
  /** On-chain WASM hash (hex SHA-256, 64 chars). */
  onChainHash: string;
  /** Public Git repo URL (https://github.com/…). */
  repoUrl: string;
  /** Exact commit SHA or tag to build. */
  commitSha: string;
  /** Path inside the repo to the contract crate (e.g. "contracts/report_card"). */
  contractPath?: string;
  /** Contract crate name as it appears in Cargo.toml. */
  crateName?: string;
  /** Use Docker for reproducible builds (recommended). */
  useDocker?: boolean;
}

export interface VerifyResult {
  sourceVerified: boolean;
  computedHash: string;
  onChainHash: string;
  method: "docker" | "native" | "unavailable";
  error?: string;
}

// ─────────────────────────── helpers ─────────────────────────────────────────

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isDockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isCargoAvailable(): boolean {
  try {
    const r = spawnSync("cargo", ["--version"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Clone a repo at a specific commit into a temp directory.
 * Returns the path to the cloned directory.
 */
function cloneRepo(repoUrl: string, commitSha: string, tmpDir: string): string {
  const repoDir = path.join(tmpDir, "repo");
  execSync(`git clone --quiet "${repoUrl}" "${repoDir}"`, { timeout: 120_000 });
  execSync(`git -C "${repoDir}" checkout --quiet "${commitSha}"`, { timeout: 30_000 });
  return repoDir;
}

// ─────────────────────────── docker build ────────────────────────────────────

const DOCKER_IMAGE = "docker.io/stellar/stellar-cli:latest";

/**
 * Build inside a Docker container for reproducibility.
 * Mounts the cloned repo read-only and writes the WASM to a tmp output dir.
 */
function buildWithDocker(
  repoDir: string,
  contractPath: string,
  crateName: string,
  outputDir: string
): string {
  const containerOutput = "/output";

  // Run: docker run --rm -v repoDir:/src:ro -v outputDir:/output IMAGE
  //        sh -c "cd /src/<contractPath> && stellar contract build && \
  //               stellar contract optimize ... && cp *.optimized.wasm /output/"
  const buildCmd = [
    `cd /src/${contractPath}`,
    `stellar contract build`,
    `stellar contract optimize --wasm target/wasm32-unknown-unknown/release/${crateName}.wasm`,
    `cp target/wasm32-unknown-unknown/release/${crateName}.optimized.wasm ${containerOutput}/`,
  ].join(" && ");

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=none", // no network inside container for reproducibility
      "-v", `${repoDir}:/src:ro`,
      "-v", `${outputDir}:${containerOutput}`,
      DOCKER_IMAGE,
      "sh", "-c", buildCmd,
    ],
    { encoding: "utf8", timeout: 300_000 }
  );

  if (result.status !== 0) {
    throw new Error(
      `Docker build failed (exit ${result.status}):\n${result.stderr}`
    );
  }

  const wasmFile = path.join(outputDir, `${crateName}.optimized.wasm`);
  if (!fs.existsSync(wasmFile)) {
    throw new Error(`Build succeeded but WASM file not found at ${wasmFile}`);
  }
  return wasmFile;
}

// ─────────────────────────── native build ────────────────────────────────────

/**
 * Build natively (fallback when Docker is unavailable).
 * Less reproducible due to local toolchain differences.
 */
function buildNative(
  repoDir: string,
  contractPath: string,
  crateName: string
): string {
  const cwd = path.join(repoDir, contractPath);

  execSync(
    "stellar contract build",
    { cwd, timeout: 180_000, stdio: "inherit" }
  );
  execSync(
    `stellar contract optimize --wasm target/wasm32-unknown-unknown/release/${crateName}.wasm`,
    { cwd, timeout: 60_000, stdio: "inherit" }
  );

  return path.join(
    cwd,
    "target",
    "wasm32-unknown-unknown",
    "release",
    `${crateName}.optimized.wasm`
  );
}

// ─────────────────────────── main export ─────────────────────────────────────

/**
 * Verify that building `repoUrl` at `commitSha` produces a WASM whose
 * SHA-256 matches `onChainHash`.
 */
export async function verifySource(input: VerifyInput): Promise<VerifyResult> {
  const {
    onChainHash,
    repoUrl,
    commitSha,
    contractPath = ".",
    crateName = "contract",
    useDocker = true,
  } = input;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report_card_verify_"));

  try {
    // Clone the repo.
    let repoDir: string;
    try {
      repoDir = cloneRepo(repoUrl, commitSha, tmpDir);
    } catch (err) {
      return {
        sourceVerified: false,
        computedHash: "",
        onChainHash,
        method: "unavailable",
        error: `Git clone failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let wasmFile: string;
    let method: VerifyResult["method"];

    if (useDocker && isDockerAvailable()) {
      method = "docker";
      const outputDir = path.join(tmpDir, "output");
      fs.mkdirSync(outputDir);
      try {
        wasmFile = buildWithDocker(repoDir, contractPath, crateName, outputDir);
      } catch (err) {
        return {
          sourceVerified: false,
          computedHash: "",
          onChainHash,
          method,
          error: `Docker build failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (isCargoAvailable()) {
      method = "native";
      try {
        wasmFile = buildNative(repoDir, contractPath, crateName);
      } catch (err) {
        return {
          sourceVerified: false,
          computedHash: "",
          onChainHash,
          method,
          error: `Native build failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      return {
        sourceVerified: false,
        computedHash: "",
        onChainHash,
        method: "unavailable",
        error: "Neither Docker nor Cargo is available; cannot perform source verification.",
      };
    }

    // Hash the built WASM and compare.
    const computedHash = sha256File(wasmFile);
    const sourceVerified =
      computedHash.toLowerCase() === onChainHash.toLowerCase();

    return { sourceVerified, computedHash, onChainHash, method };
  } finally {
    // Clean up temp directory.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // non-fatal
    }
  }
}

// ─────────────────────────── fast-path hash check ────────────────────────────

/**
 * If the caller already has the WASM bytes locally, skip the build step and
 * just compare hashes.  Useful for the dashboard's "verify a local file" flow.
 */
export function verifyLocalWasm(
  localWasmPath: string,
  onChainHash: string
): VerifyResult {
  if (!fs.existsSync(localWasmPath)) {
    return {
      sourceVerified: false,
      computedHash: "",
      onChainHash,
      method: "unavailable",
      error: `File not found: ${localWasmPath}`,
    };
  }
  const computedHash = sha256File(localWasmPath);
  return {
    sourceVerified: computedHash.toLowerCase() === onChainHash.toLowerCase(),
    computedHash,
    onChainHash,
    method: "native",
  };
}
