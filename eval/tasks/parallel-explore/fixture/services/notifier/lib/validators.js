// Message validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","userId","channel","template","createdAt"];
const ID_PATTERN = /^mes_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(message) {
  return REQUIRED_FIELDS.filter((f) => message[f] === undefined || message[f] === null);
}

function badlyTypedFields(message) {
  const problems = [];
  for (const [key, value] of Object.entries(message)) {
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
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the message id format`];
  return [];
}

function validateMessage(message) {
  const problems = [];
  for (const f of missingFields(message)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(message.id ?? ""));
  problems.push(...badlyTypedFields(message));
  return problems;
}

function assertValidMessage(message) {
  const problems = validateMessage(message);
  if (problems.length > 0) {
    throw new Error(`invalid message: ${problems.join("; ")}`);
  }
  return message;
}

module.exports = { validateMessage, assertValidMessage, missingFields, validateId, REQUIRED_FIELDS };
