# data/

Open seed dataset for the Report Card registry.

**License: CC-BY-4.0** — free to use, share, and adapt with attribution.

## contracts.json

List of Soroban contracts the engine analyses. Fields:

| Field | Required | Description |
|---|---|---|
| `contractId` | yes | Stellar contract ID (C… StrKey, 56 chars) |
| `repoUrl` | no | Public Git repo for source verification |
| `commitSha` | no | Exact commit or tag to reproducibly build |
| `contractPath` | no | Path inside the repo to the contract crate |
| `crateName` | no | Cargo crate name (used to find the built WASM) |

Add your contract by opening a PR against this file.
