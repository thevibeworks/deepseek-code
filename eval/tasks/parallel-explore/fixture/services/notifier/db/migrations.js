// Schema migrations for notifier. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_messages",
    up: `CREATE TABLE messages (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      template TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE messages",
  },
  {
    id: "0002_messages_created_index",
    up: "CREATE INDEX messages_created_idx ON messages (id)",
    down: "DROP INDEX messages_created_idx",
  },
  {
    id: "0003_messages_soft_delete",
    up: "ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE messages DROP COLUMN deleted_at",
  },
  {
    id: "0004_messages_metadata_jsonb",
    up: "ALTER TABLE messages ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE messages DROP COLUMN metadata",
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
