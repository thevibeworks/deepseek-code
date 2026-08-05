# meridian

Internal services monorepo.

- `services/billing` — invoicing and fee policies
- `services/gateway` — upstream API gateway
- `services/indexer` — search index maintenance jobs
- `services/notifier` — notification digests and delivery
- `services/auth` — token issuance and client policies
- `services/metrics` — tracing and sampling pipeline

Each service is independently deployed; see each service's own files for
its configuration layering.
