#![no_std]

pub mod contract;
mod errors;
mod governance;
mod merkle;
mod multisig;
mod proxy;
pub mod storage;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod governance_test;
#[cfg(test)]
mod gas_benchmarks;
// merkle_test.rs is not wired in: it exercises PriceOracleContract methods
// (get_batch_nonce, verify_batch_proof) that don't exist as public entry
// points yet. Pre-existing gap, tracked separately from this change.

pub use contract::PriceOracleContract;
pub use governance::GovernanceContract;
pub use multisig::MultiSigAdminContract;
pub use proxy::ProxyContract;
pub use types::{AssetPrice, HybridSignature, PostQuantumAdminKey, PostQuantumScheme, PriceDataPoint};
