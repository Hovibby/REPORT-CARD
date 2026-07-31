# Contributing to Report Card

Thank you for taking the time to contribute. Report Card is public infrastructure — every improvement benefits the whole Stellar ecosystem.

## Before you start

- Check the [open issues](https://github.com/Hovibby/REPORT-CARD/issues) to avoid duplicating work.
- For large changes, open an issue first to discuss the approach before writing code.
- All contributions are released under Apache-2.0 (code) or CC-BY-4.0 (data).

---

## Development setup

### Prerequisites

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli
# Node.js 20+ and npm
```

### Install dependencies

```bash
npm install --legacy-peer-deps   # installs all workspaces
```

### Run the dashboard locally

```bash
cp web/.env.local.example web/.env.local
npm run dev:web
# → http://localhost:3000
```

### Run contract tests

```bash
cd contracts/report_card
cargo test
```

---

## How to contribute

### Reporting a bug

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment (OS, Node version, browser if relevant)

### Suggesting a feature

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Describe the problem you are solving, not just the solution.

### Submitting a pull request

1. Fork the repo and create a branch off `main`:
   ```bash
   git checkout -b fix/your-description
   ```
2. Make your changes. Keep commits focused — one logical change per commit.
3. Run tests before pushing:
   ```bash
   # Contract tests
   cd contracts/report_card && cargo test

   # Dashboard lint
   npm run lint --workspace=web
   ```
4. Push and open a PR against `main`.
5. Fill in the PR template — describe what changed and what you tested.
6. A maintainer will review within a few days.

### Adding a contract to the seed dataset

Edit `data/contracts.json` following the schema in `data/README.md` and open a PR. Only add contracts you have permission to include.

---

## Code style

- **Rust** — `rustfmt` defaults. Run `cargo fmt` before committing.
- **TypeScript** — the project uses `strict: true`. No `any` without a comment explaining why.
- **React** — server components by default; only add `"use client"` when you need browser APIs or React state.
- **Commits** — use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.

---

## Questions?

Open a [discussion](https://github.com/Hovibby/REPORT-CARD/discussions) or an issue tagged `question`.
