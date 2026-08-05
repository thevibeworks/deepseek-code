// Error taxonomy for gateway. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class GatewayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "gateway.not_found",
  INVALID: "gateway.invalid",
  CONFLICT: "gateway.conflict",
  UPSTREAM: "gateway.upstream_failed",
  FORBIDDEN: "gateway.forbidden",
  INTERNAL: "gateway.internal",
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
  return new GatewayError(CODES.NOT_FOUND, `route ${id} not found`, { id });
}

function invalid(problems) {
  return new GatewayError(CODES.INVALID, `invalid route`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { GatewayError, CODES, statusFor, notFound, invalid };
