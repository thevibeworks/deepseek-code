// Schema migrations for auth. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_sessions",
    up: `CREATE TABLE sessions (
      id TEXT NOT NULL,
      subject TEXT NOT NULL,
      issuer TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE sessions",
  },
  {
    id: "0002_sessions_created_index",
    up: "CREATE INDEX sessions_created_idx ON sessions (id)",
    down: "DROP INDEX sessions_created_idx",
  },
  {
    id: "0003_sessions_soft_delete",
    up: "ALTER TABLE sessions ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE sessions DROP COLUMN deleted_at",
  },
  {
    id: "0004_sessions_metadata_jsonb",
    up: "ALTER TABLE sessions ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE sessions DROP COLUMN metadata",
  },
];

function pending(applied) {
  const done = new Set(applied);
  return MIGRATIONS.filter((m) => !done.has(m.id));
}

function planUp(applied) {
  return pending(applied).map((m) => ({ id: m.id, sql: m.up }));
}

function planDown(applied, toId) {
  const done = MIGRATIONS.filter((m) => applied.includes(m.id));
  const idx = done.findIndex((m) => m.id === toId);
  return done.slice(idx >= 0 ? idx : done.length).reverse().map((m) => ({ id: m.id, sql: m.down }));
}

module.exports = { MIGRATIONS, pending, planUp, planDown };
