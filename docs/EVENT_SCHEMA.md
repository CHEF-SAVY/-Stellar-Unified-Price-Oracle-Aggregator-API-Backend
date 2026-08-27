# On-Chain Event Schema

Reference for every event `contracts/price-oracle` emits via `env.events().publish((topics...), data)`.
Integrators (indexers, the aggregator service, alerting) should key off `topics[0]` (the event name)
and treat topics after it as filterable identifiers; `data` carries the payload.

All events below are emitted from `PriceOracleContract` (`contract.rs`) unless noted. `ProxyContract`
(`proxy.rs`) emits an equivalent `price_submitted` on its own delegated `submit_price`, since a
deployment may route live traffic through either contract depending on whether the upgradeable proxy
is in front.

## Price submission

| Event name | Topics (after name) | Data | Emitted from |
|---|---|---|---|
| `price_submitted` | `asset: String`, `source: Address` | `(price: i128, decimals: u32, timestamp: u64)` | `submit_price` (contract.rs, proxy.rs) |
| `batch_committed` | `source: Address`, `nonce: u64` | `root: Bytes` (32-byte Merkle root) | `submit_batch` |
| `batch_entry_applied` | `asset: String`, `source: Address` | `(batch_nonce: u64, price: i128, decimals: u32, timestamp: u64)` | `apply_batch_entry` |

## Governance (`GovernanceContract`, governance.rs)

| Event name | Topics (after name) | Data |
|---|---|---|
| `gov_proposed` | `proposal_id: u32`, `proposer: Address` | `()` |
| `gov_voted` | `proposal_id: u32`, `voter: Address` | `support: bool` |
| `gov_queued` | `proposal_id: u32` | `execution_time: u64` |
| `gov_executed` | `proposal_id: u32` | `()` |
| `gov_cancelled` | `proposal_id: u32`, `caller: Address` | `()` |
| `gov_emergency_executed` | `proposal_id: u32`, `guardian: Address` | `()` |

Read `GovernanceProposal.action` (via `get_proposal`) to see what a given proposal actually changes —
the event itself doesn't repeat the `ProposalAction` payload.

## Proxy upgrades (`ProxyContract`, proxy.rs — Issue #375)

| Event name | Topics (after name) | Data |
|---|---|---|
| `proxy_upgraded` | `admin: Address` | `(new_version: u32, new_wasm_hash: BytesN<32>)` |
| `canary_set` | `admin: Address` | `share_bps: u32` |

`propose_upgrade` / `approve_upgrade` / `cancel_upgrade` do not currently emit events — the pending
state is fully queryable via `get_pending_upgrade`, and a reconciler can diff that instead of relying
on an event stream for the proposal window. If off-chain tooling ends up wanting a push signal there
too, add `upgrade_proposed` / `upgrade_approved` following the same `(name, subject-topics, data)` shape.

## Existing staking/slashing events (contract.rs, pre-dating this doc)

| Event name | Topics (after name) | Data |
|---|---|---|
| `source_staked` | `source: Address` | `amount: i128` |
| `source_slashed` | `source: Address`, `reason: String` | `slashed: i128` |

## Indexer parity — status

An indexer that reconciles these events against on-chain state (`get_price`, `get_proposal`,
`get_pending_upgrade`, etc.) and alerts on divergence is **not implemented as part of this change**.
`services/aggregator` is the natural home for that reconciler; scaffolding it (poll interval, diff
strategy, alert routing) is tracked as follow-up work, not included here to keep this change scoped to
the contract-side event emission and its schema.
