#![no_std]

pub mod contract;
mod errors;
mod governance;
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

pub use contract::PriceOracleContract;
pub use governance::GovernanceContract;
pub use multisig::MultiSigAdminContract;
pub use proxy::ProxyContract;
pub use types::{AssetPrice, PriceDataPoint};
