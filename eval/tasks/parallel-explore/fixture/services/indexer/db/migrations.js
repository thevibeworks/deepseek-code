// Schema migrations for indexer. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_documents",
    up: `CREATE TABLE documents (
      id TEXT NOT NULL,
      shard TEXT NOT NULL,
      checksum TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      version TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE documents",
  },
  {
    id: "0002_documents_created_index",
    up: "CREATE INDEX documents_created_idx ON documents (id)",
    down: "DROP INDEX documents_created_idx",
  },
  {
    id: "0003_documents_soft_delete",
    up: "ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE documents DROP COLUMN deleted_at",
  },
  {
    id: "0004_documents_metadata_jsonb",
    up: "ALTER TABLE documents ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE documents DROP COLUMN metadata",
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
