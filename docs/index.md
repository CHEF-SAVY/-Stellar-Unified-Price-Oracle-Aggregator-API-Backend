# Stellar Unified Price Oracle — Documentation

Welcome to the Stellar Unified Price Oracle Aggregator API documentation.

## Quick links

- [API Reference](./api-reference/) — auto-generated TypeDoc documentation
- [ADRs](./adr/) — Architecture Decision Records
- [Runbooks](./runbooks/) — operational runbooks
- [OpenAPI spec](../api/src/services/openapi.ts) — Swagger UI at `/api/v1/docs`
- [Contract Upgrade Governance](./CONTRACT_UPGRADE_GOVERNANCE.md) — proposal lifecycle, multi-sig, proxy upgrades
- [Performance Tuning Guide](./PERFORMANCE_TUNING.md) — pool sizing, cache TTLs, polling, batching, fees
- [Key Management](./KEY_MANAGEMENT.md) — admin/source signer key hierarchy and rotation
- [Security Policy](../SECURITY.md) — vulnerability disclosure and bug bounty program

## Architecture overview

The system is composed of three main services:

| Service | Purpose |
|---------|---------|
| `api/` | Express REST + WebSocket gateway, authentication, rate limiting |
| `services/aggregator/` | Price aggregation from multiple oracle sources |
| `services/vault_manager/` | Stellar vault / treasury management |

Key cross-cutting concerns: distributed tracing (OpenTelemetry), Prometheus
metrics, event sourcing (#118), feature flags (#117), and performance regression
detection in CI (#110).

## Getting started

```bash
# Install dependencies
cd api && npm ci

# Generate API reference docs
npm run docs:generate

# Start the development server
npm run dev
```
