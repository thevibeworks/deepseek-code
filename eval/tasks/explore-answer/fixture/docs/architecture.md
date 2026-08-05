# Architecture notes

gatekeeper fronts all backend services. TLS terminates at the shared load
balancer, not here.

Historical note: before the 3.x series the gateway listened on port 8443
with self-managed TLS. That path was removed; any 8443 reference in old
runbooks is stale.

Configuration is layered (see src/config.js for the authoritative
precedence): shipped defaults, then the per-environment overlay chain in
config/overlays (overlays may `extends` another overlay), then the
deployment env file in deploy/. Infra-assigned values always land in the
deploy env files.
