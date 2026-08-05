// Error taxonomy for notifier. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class NotifierError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NotifierError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "notifier.not_found",
  INVALID: "notifier.invalid",
  CONFLICT: "notifier.conflict",
  UPSTREAM: "notifier.upstream_failed",
  FORBIDDEN: "notifier.forbidden",
  INTERNAL: "notifier.internal",
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
  return new NotifierError(CODES.NOT_FOUND, `message ${id} not found`, { id });
}

function invalid(problems) {
  return new NotifierError(CODES.INVALID, `invalid message`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { NotifierError, CODES, statusFor, notFound, invalid };
