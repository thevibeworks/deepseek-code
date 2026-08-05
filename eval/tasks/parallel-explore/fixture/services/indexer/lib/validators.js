// Document validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","shard","checksum","indexedAt","version"];
const ID_PATTERN = /^doc_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(document) {
  return REQUIRED_FIELDS.filter((f) => document[f] === undefined || document[f] === null);
}

function badlyTypedFields(document) {
  const problems = [];
  for (const [key, value] of Object.entries(document)) {
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
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the document id format`];
  return [];
}

function validateDocument(document) {
  const problems = [];
  for (const f of missingFields(document)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(document.id ?? ""));
  problems.push(...badlyTypedFields(document));
  return problems;
}

function assertValidDocument(document) {
  const problems = validateDocument(document);
  if (problems.length > 0) {
    throw new Error(`invalid document: ${problems.join("; ")}`);
  }
  return document;
}

module.exports = { validateDocument, assertValidDocument, missingFields, validateId, REQUIRED_FIELDS };
