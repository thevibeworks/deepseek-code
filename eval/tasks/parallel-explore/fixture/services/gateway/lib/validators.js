// Route validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","upstream","method","pathPattern","authMode"];
const ID_PATTERN = /^rou_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(route) {
  return REQUIRED_FIELDS.filter((f) => route[f] === undefined || route[f] === null);
}

function badlyTypedFields(route) {
  const problems = [];
  for (const [key, value] of Object.entries(route)) {
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
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the route id format`];
  return [];
}

function validateRoute(route) {
  const problems = [];
  for (const f of missingFields(route)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(route.id ?? ""));
  problems.push(...badlyTypedFields(route));
  return problems;
}

function assertValidRoute(route) {
  const problems = validateRoute(route);
  if (problems.length > 0) {
    throw new Error(`invalid route: ${problems.join("; ")}`);
  }
  return route;
}

module.exports = { validateRoute, assertValidRoute, missingFields, validateId, REQUIRED_FIELDS };
