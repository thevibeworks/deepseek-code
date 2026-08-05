// Invoice validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","customerId","currency","issuedAt","status"];
const ID_PATTERN = /^inv_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(invoice) {
  return REQUIRED_FIELDS.filter((f) => invoice[f] === undefined || invoice[f] === null);
}

function badlyTypedFields(invoice) {
  const problems = [];
  for (const [key, value] of Object.entries(invoice)) {
    if (typeof value === "string" && value.length > MAX_FIELD_LEN) {
      problems.push(`field ${key} exceeds ${MAX_FIELD_LEN} chars`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      problems.push(`field ${key} is not finite`);
    }
  }
  return problems;
}

function validateId(id) {
  if (typeof id !== "string") return ["id must be a string"];
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the invoice id format`];
  return [];
}

function validateInvoice(invoice) {
  const problems = [];
  for (const f of missingFields(invoice)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(invoice.id ?? ""));
  problems.push(...badlyTypedFields(invoice));
  return problems;
}

function assertValidInvoice(invoice) {
  const problems = validateInvoice(invoice);
  if (problems.length > 0) {
    throw new Error(`invalid invoice: ${problems.join("; ")}`);
  }
  return invoice;
}

module.exports = { validateInvoice, assertValidInvoice, missingFields, validateId, REQUIRED_FIELDS };
