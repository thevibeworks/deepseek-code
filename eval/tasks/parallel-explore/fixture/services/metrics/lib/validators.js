// Series validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ["id","name","unit","resolution","retention"];
const ID_PATTERN = /^ser_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(series) {
  return REQUIRED_FIELDS.filter((f) => series[f] === undefined || series[f] === null);
}

function badlyTypedFields(series) {
  const problems = [];
  for (const [key, value] of Object.entries(series)) {
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
  if (!ID_PATTERN.test(id)) return [`id ${id} does not match the series id format`];
  return [];
}

function validateSeries(series) {
  const problems = [];
  for (const f of missingFields(series)) problems.push(`missing required field ${f}`);
  problems.push(...validateId(series.id ?? ""));
  problems.push(...badlyTypedFields(series));
  return problems;
}

function assertValidSeries(series) {
  const problems = validateSeries(series);
  if (problems.length > 0) {
    throw new Error(`invalid series: ${problems.join("; ")}`);
  }
  return series;
}

module.exports = { validateSeries, assertValidSeries, missingFields, validateId, REQUIRED_FIELDS };
