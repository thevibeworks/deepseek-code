// Error taxonomy for auth. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class AuthError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "auth.not_found",
  INVALID: "auth.invalid",
  CONFLICT: "auth.conflict",
  UPSTREAM: "auth.upstream_failed",
  FORBIDDEN: "auth.forbidden",
  INTERNAL: "auth.internal",
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
  return new AuthError(CODES.NOT_FOUND, `session ${id} not found`, { id });
}

function invalid(problems) {
  return new AuthError(CODES.INVALID, `invalid session`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { AuthError, CODES, statusFor, notFound, invalid };
