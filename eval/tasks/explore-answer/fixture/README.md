# gatekeeper

Internal API gateway. Routes external traffic to backend services.

- `src/` — server, config loader, middleware
- `config/` — layered configuration (defaults + per-environment overlays)
- `deploy/` — per-environment deployment env files
- `docs/` — architecture notes

Start locally: `GATEKEEPER_ENV=staging node src/server.js`
