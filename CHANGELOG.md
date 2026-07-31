# Changelog

All notable changes to Report Card are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Planned
- Auditor DAO governing reputation weights and dispute resolution
- Automated formal-property checks (no unbounded mint) feeding the grade
- Wallet-SDK partnerships for default pre-sign `is_safe()` checks
- Grade badge widget for dApp frontends
- Slashing mechanism: on-chain proof that a "safe" verdict was wrong

---

## [0.1.0] — 2026-07-31

### Added

**Soroban contract (`contracts/`)**
- `initialize(admin, relayer)` — bootstrap the registry
- `is_safe(contract_id) → SafetyRecord` — pure read returning A–F grade + evidence
- `register_auditor(auditor, reputation, meta_hash)` — admin onboards auditor
- `deactivate_auditor(auditor)` — admin slashes / disables auditor
- `submit_attestation(...)` — auditor submits signed verdict bound to WASM hash
- `set_flags(...)` — relayer writes objective WASM analysis flags
- `graded` event emitted on every grade change (for wallet indexers)
- Deterministic weighted scoring rubric: attestations 30%, source 25%, upgradeability 20%, admin-power 15%, maturity 10%
- 14 unit + integration tests

**Off-chain engine (`engine/`)**
- WASM pull via Soroban RPC `getLedgerEntries`
- Static WASM analysis: upgrade-path and admin-power pattern detection
- Reproducible-build source verification (Docker-first, native Cargo fallback)
- Relayer: simulate → assemble → sign → submit → poll confirmation
- Scheduler with configurable interval, `--once`, and `--contract` CLI flags
- Dry-run mode when `RELAYER_SECRET` is unset

**Dashboard (`web/`)**
- Homepage with contract search, hero stats, recent contracts grid
- `/contract/[id]` — GradeCard, EvidenceChecklist, AttestationList
- `/auditor` — wallet-connected attestation signing portal
- `/api/safety?id=` — CORS-open JSON endpoint for wallets and scripts
- Wallet connect via `stellar-wallets-kit` (Freighter + all modules)

**SDK (`sdk/`)**
- `ReportCard` class with `http` and `rpc` transport modes
- `isSafe(contractId)` convenience function
- Zero required runtime dependencies for HTTP transport

**Monorepo**
- `packages/types` — shared TypeScript types across all packages
- Root `package.json` with npm workspaces
- Root `.gitignore` and `.gitattributes`
- Comprehensive `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- GitHub Actions CI: contract tests, TypeScript build, Next.js build
- Issue templates and PR template

[Unreleased]: https://github.com/Hovibby/REPORT-CARD/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hovibby/REPORT-CARD/releases/tag/v0.1.0
