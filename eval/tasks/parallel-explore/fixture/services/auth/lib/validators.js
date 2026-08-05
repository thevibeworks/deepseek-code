// Session validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","subject","issuer","issuedAt","deviceId"];
const ID_PATTERN = /^ses_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(session) {
  return REQUIRED_FIELDS.filter((f) => session[f] === undefined || session[f] === null);
}

function badlyTypedFields(session) {
  const problems = [];
  for (const [key, value] of Object.entries(session)) {
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
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the session id format`];
  return [];
}

function validateSession(session) {
  const problems = [];
  for (const f of missingFields(session)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(session.id ?? ""));
  problems.push(...badlyTypedFields(session));
  return problems;
}

function assertValidSession(session) {
  const problems = validateSession(session);
  if (problems.length > 0) {
    throw new Error(`invalid session: ${problems.join("; ")}`);
  }
  return session;
}

module.exports = { validateSession, assertValidSession, missingFields, validateId, REQUIRED_FIELDS };
