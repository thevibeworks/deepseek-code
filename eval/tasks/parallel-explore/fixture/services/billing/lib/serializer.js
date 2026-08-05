// Wire serialization for invoices. The external representation is
// snake_case and frozen by the public API contract; the internal shape is
// camelCase. Keep the two mappings adjacent so they cannot drift.
const WIRE_KEYS = {
  id: "id",
  customerId: "customer_id",
  currency: "currency",
  issuedAt: "issued_at",
  status: "status",
};

const INTERNAL_KEYS = Object.fromEntries(
  Object.entries(WIRE_KEYS).map(([internal, wire]) => [wire, internal]),
);

function toWire(invoice) {
  const out = {};
  for (const [internal, wire] of Object.entries(WIRE_KEYS)) {
    if (invoice[internal] !== undefined) out[wire] = invoice[internal];
  }
  return out;
}

function fromWire(payload) {
  const out = {};
  for (const [wire, internal] of Object.entries(INTERNAL_KEYS)) {
    if (payload[wire] !== undefined) out[internal] = payload[wire];
  }
  return out;
}

function toWireCollection(items) {
  return { items: items.map(toWire), count: items.length };
}

function redactForLogs(invoice) {
  const clone = { ...invoice };
  for (const key of ["token", "secret", "authorization", "cookie"]) delete clone[key];
  return clone;
}

module.exports = { toWire, fromWire, toWireCollection, redactForLogs, WIRE_KEYS };
