// Error taxonomy for metrics. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class MetricsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MetricsError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "metrics.not_found",
  INVALID: "metrics.invalid",
  CONFLICT: "metrics.conflict",
  UPSTREAM: "metrics.upstream_failed",
  FORBIDDEN: "metrics.forbidden",
  INTERNAL: "metrics.internal",
};

const STATUS_BY_CODE = {
  [CODES.NOT_FOUND]: 404,
  [CODES.INVALID]: 422,
  [CODES.CONFLICT]: 409,
  [CODES.UPSTREAM]: 502,
  [CODES.FORBIDDEN]: 403,
  [CODES.INTERNAL]: 500,
};

function notFound(id) {
  return new MetricsError(CODES.NOT_FOUND, `series ${id} not found`, { id });
}

function invalid(problems) {
  return new MetricsError(CODES.INVALID, `invalid series`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { MetricsError, CODES, statusFor, notFound, invalid };
