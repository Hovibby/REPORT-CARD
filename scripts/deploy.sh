#!/usr/bin/env bash
# deploy.sh — Build, optimise, deploy, and initialise the Report Card
#             registry contract on Stellar Testnet.
#
# DECENTRALISATION:
#   - initialize() takes a governance council (Vec<Address> + threshold).
#   - There is NO privileged relayer key.  Any funded account submits flags.
#   - The contract verifies WASM hashes against ledger state on-chain.
#
# Prerequisites:
#   rustup target add wasm32-unknown-unknown
#   cargo install --locked stellar-cli
#   stellar keys generate council0 --network testnet && stellar keys fund council0 --network testnet
#   stellar keys generate council1 --network testnet && stellar keys fund council1 --network testnet
#
# Usage:
#   bash scripts/deploy.sh
#   STELLAR_NETWORK=testnet bash scripts/deploy.sh

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
SOURCE_ACCOUNT="${ADMIN_KEY:-council0}"
CONTRACTS_DIR="contracts/report_card"
WASM_PATH="contracts/report_card/target/wasm32-unknown-unknown/release/report_card.wasm"
OPT_WASM_PATH="contracts/report_card/target/wasm32-unknown-unknown/release/report_card.optimized.wasm"
DEPLOY_LOG="deploy_${NETWORK}.log"

# Governance council: add as many addresses as needed.
# Threshold = minimum votes to pass a proposal.
COUNCIL_MEMBER_0=$(stellar keys address council0 2>/dev/null || echo "")
COUNCIL_MEMBER_1=$(stellar keys address council1 2>/dev/null || echo "")
THRESHOLD=1  # set to 2 for 2-of-2, etc.

echo "========================================="
echo " Report Card — Decentralised Deploy"
echo " network   : $NETWORK"
echo " source    : $SOURCE_ACCOUNT"
echo " council   : $COUNCIL_MEMBER_0  $COUNCIL_MEMBER_1"
echo " threshold : $THRESHOLD"
echo "========================================="

# ── 1. Build ──────────────────────────────────────────────────────────────────

echo ""
echo "[ 1/5 ] Building contract …"
(cd "$CONTRACTS_DIR" && stellar contract build)
echo "        WASM built: $WASM_PATH"

# ── 2. Optimise ───────────────────────────────────────────────────────────────

echo ""
echo "[ 2/5 ] Optimising WASM …"
stellar contract optimize --wasm "$WASM_PATH"
echo "        Optimised: $OPT_WASM_PATH"

# ── 3. Deploy ─────────────────────────────────────────────────────────────────

echo ""
echo "[ 3/5 ] Deploying to $NETWORK …"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$OPT_WASM_PATH" \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK" 2>&1 | tee /dev/stderr | tail -1)

echo ""
echo "        CONTRACT_ID = $CONTRACT_ID"

# ── 4. Initialise governance council ─────────────────────────────────────────

echo ""
echo "[ 4/5 ] Initialising governance council …"

# Build the members Vec for the CLI.
# Each member must sign (--source handles auth for council0; council1 adds their auth).
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --members "[\"$COUNCIL_MEMBER_0\",\"$COUNCIL_MEMBER_1\"]" \
  --threshold "$THRESHOLD"

echo "        Council initialised."
echo "        Members   : $COUNCIL_MEMBER_0 / $COUNCIL_MEMBER_1"
echo "        Threshold : $THRESHOLD"

# ── 5. Smoke test ─────────────────────────────────────────────────────────────

echo ""
echo "[ 5/5 ] Smoke-testing is_safe() …"
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  -- is_safe \
  --contract_id "$CONTRACT_ID"

echo ""
echo "========================================="
echo " Deploy complete."
echo " CONTRACT_ID : $CONTRACT_ID"
echo " Network     : $NETWORK"
echo "========================================="
echo ""
echo "Add to web/.env.local:"
echo "  NEXT_PUBLIC_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo "  NEXT_PUBLIC_NETWORK=$NETWORK"
echo ""
echo "Add to engine/.env:"
echo "  REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo "  STELLAR_NETWORK=$NETWORK"
echo "  SUBMITTER_SECRET=<any funded Stellar account secret — not a privileged key>"

echo "$CONTRACT_ID" > "$DEPLOY_LOG"
echo "Written to $DEPLOY_LOG"
