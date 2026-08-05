// In-memory session repository used by the local dev harness and the
// test suite. Production binds the same interface to Postgres; keeping
// the shapes identical is what lets the tests be meaningful.
const { assertValidSession } = require("./validators");
const { notFound } = require("./errors");

class SessionRepository {
  constructor(seed = []) {
    this.rows = new Map();
    for (const row of seed) this.rows.set(row.id, row);
  }

  get(id) {
    const row = this.rows.get(id);
    if (!row) throw notFound(id);
    return { ...row };
  }

  has(id) {
    return this.rows.has(id);
  }

  put(session) {
    assertValidSession(session);
    this.rows.set(session.id, { ...session });
    return this.get(session.id);
  }

  remove(id) {
    if (!this.rows.has(id)) throw notFound(id);
    this.rows.delete(id);
  }

  list(predicate) {
    const all = [...this.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return predicate ? all.filter(predicate) : all;
  }

  count(predicate) {
    return this.list(predicate).length;
  }

  clear() {
    this.rows.clear();
  }
}

module.exports = { SessionRepository };
