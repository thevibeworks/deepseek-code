// Cursor pagination for series listings. Cursors are opaque base64
// of {lastId, lastSort}: offset pagination drifts when rows are written
// between pages, and every listing here is written concurrently.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function clampPageSize(requested) {
  if (typeof requested !== "number" || Number.isNaN(requested)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requested)));
}

function paginate(rows, { cursor, pageSize } = {}) {
  const size = clampPageSize(pageSize);
  const state = decodeCursor(cursor);
  const start = state === null ? 0 : rows.findIndex((r) => r.id === state.lastId) + 1;
  const page = rows.slice(start, start + size);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: page.length === size && last ? encodeCursor({ lastId: last.id }) : null,
  };
}

module.exports = { paginate, encodeCursor, decodeCursor, clampPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
