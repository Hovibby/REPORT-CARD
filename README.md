# 📋 Report Card

<img src="assets/logo.svg" alt="Report Card — Soroban Smart Contract Safety Registry" width="420"/>

> **A fully decentralised safety registry for Soroban smart contracts — so wallets can warn users before they sign.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Data: CC-BY-4.0](https://img.shields.io/badge/Data-CC--BY--4.0-green.svg)](LICENSE)
[![Stellar Network](https://img.shields.io/badge/Network-Stellar%20Testnet-purple.svg)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Runtime-Soroban-blueviolet.svg)](https://soroban.stellar.org)

Before your wallet signs, it asks one question:

```
is_safe(contract_id) → { grade: "A", upgradeable: false, attestation_count: 2, … }
```

Audit attestations · WASM static analysis · source verification — fused into a single **A–F grade** that any wallet, contract, or dApp reads in one call, **with no admin keys, no privileged relayers, and no off-chain database.**

---

## Why fully decentralised?

Most safety registries have a hidden single point of failure: one admin key that can censor contracts, one relayer that can forge analysis results, one server that can go offline.

Report Card removes all three:

| Old (centralised) | New (Stellar-native) |
|---|---|
| Single `admin` key onboards auditors | On-chain **governance council** — `Vec<Address>` + threshold |
| Single `relayer` key writes flags | **Permissionless** `set_flags()` — any account submits; contract verifies hash on-chain |
| Docker build for source verification | **`stellar contract fetch`** — WASM pulled directly from the ledger |
| Off-chain database | All state in **Soroban persistent storage** |
| Hardcoded RPC endpoints | Configurable, no trust in any single provider |

---

## The 10-second demo

| Scenario | Grade | What you see |
|---|---|---|
| Paste a secretly-upgradeable contract | **D** | 🔴 "Admin can replace this code at any time." |
| Paste a fully-audited, source-verified contract | **A** | ✅ Auditor name · WASM hash · confidence 95% |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 3 — Dashboard  (Next.js 14 · Tailwind · app router)           │
│                                                                      │
│  /                  Homepage: search · stats · recent contracts      │
│  /contract/[id]     Full report: grade · evidence · attestations     │
│  /auditor           Permissionless attestation portal (wallet-signed)│
│  /api/safety?id=    CORS-open JSON endpoint — any wallet can call    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  fetchSafetyRecord()  /  /api/safety
┌──────────────────────────▼───────────────────────────────────────────┐
│  LAYER 2 — Engine  (Node.js 20 · TypeScript · ESM)                   │
│                                                                      │
│  ingest.ts    Fetch WASM from ledger via Soroban RPC                 │
│  scoring.ts   5-signal weighted rubric → A–F grade                   │
│  verify.ts    `stellar contract fetch` → SHA-256 → compare          │
│  relayer.ts   ANY funded account submits flags (not a privileged key)│
│  index.ts     Scheduler + CLI  (dry-run if no SUBMITTER_SECRET)      │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  set_flags()  ·  submit_attestation()
┌──────────────────────────▼───────────────────────────────────────────┐
│  LAYER 1 — Contract  (Rust · Soroban SDK 21 · WASM)                  │
│                                                                      │
│  initialize(members, threshold)  Bootstrap governance council        │
│  is_safe(contract_id) → Record   Pure read, A–F grade + evidence     │
│  propose(id, kind, payload)      Council member creates proposal     │
│  vote(id, exec_data)             Council members vote; auto-executes │
│  get_council()                   Read current council + threshold    │
│  submit_attestation(...)         Auditor signs verdict (wallet auth) │
│  set_flags(submitter, ...)       PERMISSIONLESS — hash verified live │
│  get_proposal(id)                Read pending proposal               │
│  event: graded                   On every grade change               │
│  event: executed                 On proposal execution               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Scoring rubric

| Signal | Weight | What it measures |
|---|:---:|---|
| Signed audit attestations | **30%** | Recognised auditors sign the exact WASM hash; weighted by governance-set reputation |
| Source verification | **25%** | `stellar contract fetch` output SHA-256 matches on-chain WASM hash |
| Upgradeability exposure | **20%** | `update_current_contract_wasm` detected in WASM bytecode |
| Admin-power surface | **15%** | Unbounded mint / freeze / drain exports detected |
| Maturity & usage | **10%** | Contract age · distinct callers · native XLM TVL proxy |

**Grade thresholds:** A ≥ 80 · B ≥ 65 · C ≥ 50 · D ≥ 35 · F < 35

---

## Governance model

The registry is governed by an on-chain **council** — a `Vec<Address>` with a configurable threshold. No single key has unilateral power.

### Actions requiring a council vote

| Action | Proposal kind |
|---|---|
| Update auditor reputation | `aud_rep` |
| Deactivate an auditor | `aud_dact` |
| Replace the council itself | `council` |

### Proposal lifecycle

```
propose(id, kind, payload_hash)   ← any council member
  └─ vote(id, exec_data)          ← each council member
       └─ when votes ≥ threshold  → auto-executes + emits `executed` event
                                  → proposal removed from storage
```

Proposals expire after **17,280 ledgers (~24 hours)**. Expired proposals cannot be executed.

---

## Repository structure

```
report_card/
│
├── packages/types/            @reportcard/types — shared TypeScript types
│
├── contracts/report_card/
│   ├── src/lib.rs             Soroban contract (governance + permissionless flags)
│   └── src/test.rs            Tests: council init, proposals, permissionless set_flags
│
├── engine/
│   ├── src/index.ts           Scheduler — any account, no privileged key
│   ├── src/ingest.ts          Soroban RPC WASM pull + Horizon metadata
│   ├── src/scoring.ts         5-signal weighted rubric
│   ├── src/verify.ts          stellar contract fetch → SHA-256 (no Docker)
│   └── src/relayer.ts         Permissionless flag submission
│
├── web/
│   ├── app/page.tsx           Homepage
│   ├── app/contract/[id]/     Full safety report
│   ├── app/auditor/           Permissionless attestation portal
│   └── app/api/safety/        CORS-open JSON endpoint
│
├── sdk/index.ts               isSafe() + buildSubmitFlagsXdr() + sendSignedXdr()
├── scripts/deploy.sh          Council-based deploy (no single admin key)
└── data/contracts.json        CC-BY-4.0 open contract dataset
```

---

## Quick start

### Prerequisites

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli
# Node.js 20+
```

### 1 — Create and fund council accounts

```bash
stellar keys generate council0 --network testnet
stellar keys generate council1 --network testnet
stellar keys fund council0 --network testnet
stellar keys fund council1 --network testnet
```

### 2 — Deploy with governance council

```bash
bash scripts/deploy.sh
# → prints CONTRACT_ID
```

### 3 — Configure environment

```bash
cp web/.env.local.example web/.env.local
# NEXT_PUBLIC_REGISTRY_CONTRACT_ID=<CONTRACT_ID>

cp engine/.env.example engine/.env
# REGISTRY_CONTRACT_ID=<CONTRACT_ID>
# SUBMITTER_SECRET=<any funded account — not a privileged key>
```

### 4 — Install and run

```bash
npm install --legacy-peer-deps
npm run dev:web      # → http://localhost:3000
npm run dev:engine -- --once   # analyse data/contracts.json once
```

---

## Smart-contract API

### Read (pure, no fees, no auth)

| Function | Returns | Description |
|---|---|---|
| `is_safe(contract_id)` | `SafetyRecord` | Full grade + evidence. Returns F for unknown contracts. |
| `get_council()` | `Council` | Current governance council + threshold. |
| `get_auditor(auditor)` | `Option<Auditor>` | Auditor reputation + active status. |
| `get_attestation(contract, auditor)` | `Option<Attestation>` | Specific attestation record. |
| `get_proposal(id)` | `Option<Proposal>` | Pending governance proposal. |

### Write

| Function | Auth | Description |
|---|---|---|
| `initialize(members, threshold)` | all members (once) | Bootstrap governance council. |
| `propose(proposer, id, kind, payload)` | council member | Create a governance proposal. |
| `vote(voter, id, exec_data)` | council member | Vote; auto-executes at threshold. |
| `submit_attestation(auditor, ...)` | auditor `require_auth()` | Signed verdict bound to WASM hash. |
| `set_flags(submitter, contract_id, ...)` | **any account** | PERMISSIONLESS — hash verified on-chain. |

---

## SDK

```bash
npm install @reportcard/sdk
```

### Read — no wallet, no keys

```ts
import { ReportCard } from '@reportcard/sdk';

const rc = new ReportCard({
  network:             'testnet',
  registryContractId:  'C…',
});

const g = await rc.isSafe(contractId);
if (g.gradeNumeric <= 2 || g.upgradeable) showWarning(g);
```

### Permissionless write — any wallet can submit flags

```ts
// Build the unsigned transaction XDR.
const xdr = await rc.buildSubmitFlagsXdr({
  submitterAddress: wallet.address,   // any funded account — not a special key
  contractId:       targetContract,
  wasmHash:         '…hex sha256…',
  upgradeable:      false,
  sourceVerified:   true,
  adminPower:       false,
  maturityScore:    7,
});

// Sign with any Stellar wallet.
const { signedTxXdr } = await wallet.signTransaction(xdr, { ... });

// Submit.
const txHash = await rc.sendSignedXdr(signedTxXdr);
```

### Soroban cross-contract guard (Rust)

```rust
let g = reportcard::Client::new(&env, &REGISTRY_ID).is_safe(&target);
assert!(g.grade.numeric >= 4, "target contract is below grade B");
```

### HTTP (wallets, scripts, curl — no SDK needed)

```bash
curl "https://your-dashboard.example.com/api/safety?id=C…"
```

---

## Engine environment variables

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `STELLAR_NETWORK` | | `testnet` | `testnet` \| `mainnet` \| `futurenet` |
| `REGISTRY_CONTRACT_ID` | ✓ | — | Deployed registry contract ID |
| `SUBMITTER_SECRET` | | — | **Any** funded account secret — not privileged. Omit for dry-run. |
| `SOROBAN_RPC_URL` | | SDF testnet | Soroban RPC endpoint |
| `HORIZON_URL` | | SDF testnet | Horizon API endpoint |
| `ENGINE_INTERVAL_MS` | | `300000` | Re-scan interval in ms |
| `LOG_LEVEL` | | `info` | `error` \| `warn` \| `info` \| `debug` |

---

## Dashboard environment variables

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `NEXT_PUBLIC_REGISTRY_CONTRACT_ID` | ✓ | — | Deployed registry contract ID |
| `NEXT_PUBLIC_NETWORK` | | `testnet` | `testnet` \| `mainnet` |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | | SDF testnet | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | | SDF testnet | Horizon API endpoint |

---

## Threat model

| Attack vector | Mitigation |
|---|---|
| **Single admin capture** | No single admin key. All governance requires ≥ threshold council votes. Council itself is replaceable by vote. |
| **Fake auditor registration** | Reputation set by council proposal + vote. Low-rep attestations barely move the grade. |
| **Fraudulent flag submission** | `set_flags()` is permissionless but the contract verifies the WASM hash against live ledger state. Wrong hash = on-chain rejection. |
| **Attestation hash mismatch** | Attestations bound to WASM hash. Redeploying new WASM invalidates the grade automatically. |
| **Time-of-check / time-of-use upgrade** | Upgradeable contracts are permanently flagged and grade-capped regardless of attestations. |
| **Governance takeover** | Council replacement requires threshold votes. Proposals expire in 24 h. New council must be valid (threshold ≤ size). |
| **Single RPC provider dependency** | RPC URL is configurable per deployment. Engine falls back to dry-run if RPC is unavailable. |

---

## Decentralisation path

| Stage | Status | Description |
|---|---|---|
| **Now** | ✅ | On-chain governance council, permissionless flags, no Docker, no private keys |
| **Next** | 🔜 | Public auditor self-registration via governance proposal UI |
| **Future** | 🔜 | Auditor DAO — token-weighted reputation, slashing, appeals |
| **Future** | 🔜 | Multi-validator flag aggregation — N engines each submit independently |

---

## Open-source principles

- **Explainable** — every grade is reproducible from public on-chain data.
- **Permissionless** — anyone can submit analysis, anyone can attest, anyone can read.
- **Composable** — the whole value is `is_safe()`. One call, any contract, any wallet.
- **Not a blacklist** — scores are transparent, contestable, and governed on-chain.
- **Dual license** — Apache-2.0 (code) · CC-BY-4.0 (data).

---

## Contributing

1. Fork and branch off `main`.
2. Contract changes: `cd contracts/report_card && cargo test --features testutils`
3. TypeScript: `npm run lint --workspaces --if-present`
4. Update `CHANGELOG.md` under `[Unreleased]`.
5. Open a PR with what changed and what was tested.

---

## License

| Scope | License |
|---|---|
| All source code | [Apache-2.0](LICENSE) |
| Open dataset (`data/`) | [CC-BY-4.0](LICENSE) |
