// Error taxonomy for indexer. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class IndexerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "IndexerError";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "indexer.not_found",
  INVALID: "indexer.invalid",
  CONFLICT: "indexer.conflict",
  UPSTREAM: "indexer.upstream_failed",
  FORBIDDEN: "indexer.forbidden",
  INTERNAL: "indexer.internal",
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
  return new IndexerError(CODES.NOT_FOUND, `document ${id} not found`, { id });
}

function invalid(problems) {
  return new IndexerError(CODES.INVALID, `invalid document`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { IndexerError, CODES, statusFor, notFound, invalid };
