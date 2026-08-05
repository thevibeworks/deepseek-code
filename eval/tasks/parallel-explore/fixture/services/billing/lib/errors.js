// Error taxonomy for billing. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class BillingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "billing.not_found",
  INVALID: "billing.invalid",
  CONFLICT: "billing.conflict",
  UPSTREAM: "billing.upstream_failed",
  FORBIDDEN: "billing.forbidden",
  INTERNAL: "billing.internal",
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
  return new BillingError(CODES.NOT_FOUND, `invoice ${id} not found`, { id });
}

function invalid(problems) {
  return new BillingError(CODES.INVALID, `invalid invoice`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { BillingError, CODES, statusFor, notFound, invalid };
