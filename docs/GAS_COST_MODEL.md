# Mainnet Gas Budget & Cost Model

Issue #378: quantify worst-case per-submission and per-batch instruction costs, and forecast the
monthly cost of the default 5-asset, 30-second-cadence deployment.

## Measured instruction counts (per entry point)

Captured from `contracts/price-oracle/src/gas_benchmarks.rs` (`cargo test bench_ --lib --
--nocapture`), which runs each entry point against a mainnet-limit budget
(`env.budget().reset_default()`) so the numbers reflect real network limits, not the unlimited
test-default budget. Two `gas_benchmarks.rs` bugs blocked these from ever running before this
change (wrong `testutils::Budget` import path, missing `std` imports under `#![no_std]`, missing
`env.mock_all_auths()`); fixing them was part of this change so the numbers below are real, not
estimated.

| Entry point | Scenario | CPU instructions | Memory bytes |
|---|---|---:|---:|
| `initialize` | — | 24,825 | 2,810 |
| `submit_price` | cold (new asset) | 154,577 | 19,378 |
| `submit_price` | warm (10 history entries) | 294,315 | 51,210 |
| `submit_price` | **steady state (100 history entries, cap trim)** | **1,364,505** | **328,807** |
| `submit_batch` | commit a Merkle root | 92,857 | 11,987 |
| `get_price` | found | 100,463 | 12,927 |
| `get_price` | not found | 40,424 | 5,395 |
| `get_price_history` | limit=10, 20 stored | 141,159 | 21,617 |
| `get_assets` | 5 assets | 154,163 | 25,049 |
| `add_oracle_source` | new | 105,025 | 12,026 |
| `add_oracle_source` | duplicate (no-op writes) | 77,205 | 10,497 |
| `remove_oracle_source` | — | 90,721 | 10,488 |
| `set_trusted_asset` | — | 138,553 | 22,589 |
| 3-source `submit_price` round | — | 762,445 | 109,800 |

**Worst case per submission** is the steady-state row: once `PriceHistory` for an asset has reached
`storage::MAX_HISTORY_LEN` (100 entries), every subsequent `submit_price` both appends and trims,
which is the cost that recurs indefinitely under continuous operation — use this row, not the cold
or warm numbers, for capacity/cost planning. `apply_batch_entry` (Merkle proof verification) isn't
in this table yet — its cost depends on proof depth (`siblings.len()`), and benchmarking it needs a
constructed batch + proof fixture that doesn't exist in the current test harness; tracked as
follow-up.

Regenerate this table after any change to `submit_price`, `PriceHistory` handling, or
`MAX_HISTORY_LEN` — the numbers are a snapshot, not a guarantee, and Soroban budget costs change
across protocol versions too.

## Monthly forecast — default 5-asset, 30s cadence

5 assets × 1 submission every 30s = 10 submissions/minute = 14,400 submissions/day =
**432,000 submissions/month** (30-day month), assuming each asset is already at steady state
(realistic after the first ~50 minutes of continuous operation at this cadence).

```
432,000 submissions × 1,364,505 instructions  = 589,466,160,000 instructions/month
432,000 submissions ×   328,807 memory bytes  = 142,044,624,000 memory-bytes/month (budget units, not storage)
```

This is the direct `submit_price` path. The Merkle-batch path (`submit_batch` +
`apply_batch_entry`) trades a much cheaper per-batch commit (92,857 instructions, independent of
batch size) for one `apply_batch_entry` call per price entry — cheaper in aggregate only once
`apply_batch_entry`'s real cost is measured (see gap above); do not assume it's cheaper without
that number.

## Converting to a mainnet fee estimate

Soroban resource fees are priced per instruction/byte at rates that change with network
conditions and protocol upgrades — hardcoding a per-instruction XLM/USD rate here would go stale
and, per this issue's own rationale ("the economic model depends on accurate numbers"), a wrong
number is worse than no number. To get a current estimate:

```bash
stellar contract invoke --id <ORACLE_CONTRACT_ID> --source-account <ACCOUNT> \
  --network mainnet --sim-only -- submit_price --source ... --asset XLM --price ... \
  --decimals 7 --timestamp ...
```

`--sim-only` (or the equivalent RPC `simulateTransaction` call) returns the resource fee for that
specific invocation against the *current* mainnet fee schedule. Multiply that fee by 432,000/month
for the submission-cost line of the budget; combine with `docs/COST_OPTIMIZATION.md`'s existing
fee-revenue accounting for the full economic picture.

## Cost dashboard

`monitoring/grafana-dashboard.json` gets a new panel (below) reading
`oracle_gas_instructions_total` / `oracle_gas_fee_stroops_total` counters, labeled by
`entry_point`. **Those metrics don't exist yet** — nothing currently exports per-call gas/fee data
from mainnet transactions into Prometheus. Wiring an exporter (parsing `simulateTransaction` /
transaction-result resource usage as submissions happen, likely from `services/aggregator` since
that's what submits prices) is follow-up work; the panel is added now so the dashboard is ready
the moment that exporter exists, and to make the current gap visible rather than silently absent.
