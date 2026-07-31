#!/usr/bin/env bash
# deploy.sh — Build, optimise, deploy, and initialise the Report Card
#             registry contract on Stellar Testnet.
#
# Prerequisites:
#   rustup target add wasm32-unknown-unknown
#   cargo install --locked stellar-cli
#   stellar keys generate me --network testnet
#   stellar keys fund me --network testnet
#
# Usage:
#   bash scripts/deploy.sh
#   STELLAR_NETWORK=testnet ADMIN_KEY=me bash scripts/deploy.sh

set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────

NETWORK="${STELLAR_NETWORK:-testnet}"
SOURCE_ACCOUNT="${ADMIN_KEY:-me}"
CONTRACTS_DIR="contracts/report_card"
WASM_PATH="contracts/report_card/target/wasm32-unknown-unknown/release/report_card.wasm"
OPT_WASM_PATH="contracts/report_card/target/wasm32-unknown-unknown/release/report_card.optimized.wasm"
DEPLOY_LOG="deploy_${NETWORK}.log"

echo "========================================="
echo " Report Card — Testnet Deploy"
echo " network : $NETWORK"
echo " source  : $SOURCE_ACCOUNT"
echo "========================================="

# ── 1. build ──────────────────────────────────────────────────────────────────

echo ""
echo "[ 1/5 ] Building contract …"
(cd "$CONTRACTS_DIR" && stellar contract build)
echo "       WASM built: $WASM_PATH"

# ── 2. optimise ───────────────────────────────────────────────────────────────

echo ""
echo "[ 2/5 ] Optimising WASM …"
stellar contract optimize --wasm "$WASM_PATH"
echo "       Optimised: $OPT_WASM_PATH"

# ── 3. deploy ─────────────────────────────────────────────────────────────────

echo ""
echo "[ 3/5 ] Deploying to $NETWORK …"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$OPT_WASM_PATH" \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  2>&1 | tee /dev/stderr | tail -1)

echo ""
echo "       CONTRACT_ID = $CONTRACT_ID"

# ── 4. initialise ─────────────────────────────────────────────────────────────

echo ""
echo "[ 4/5 ] Initialising registry …"

ADMIN_ADDRESS=$(stellar keys address "$SOURCE_ACCOUNT")
# Use the same key as relayer for initial setup; rotate later.
RELAYER_ADDRESS="$ADMIN_ADDRESS"

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --relayer "$RELAYER_ADDRESS"

echo "       Registry initialised. Admin/Relayer = $ADMIN_ADDRESS"

# ── 5. smoke test ─────────────────────────────────────────────────────────────

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
echo "Add to your .env.local:"
echo "  NEXT_PUBLIC_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo "  NEXT_PUBLIC_NETWORK=$NETWORK"
echo ""
echo "Add to engine/.env:"
echo "  REGISTRY_CONTRACT_ID=$CONTRACT_ID"
echo "  STELLAR_NETWORK=$NETWORK"
echo "  RELAYER_SECRET=<your relayer secret key>"

# Write a log for CI / reference.
echo "$CONTRACT_ID" > "$DEPLOY_LOG"
echo "Written contract ID to $DEPLOY_LOG"
