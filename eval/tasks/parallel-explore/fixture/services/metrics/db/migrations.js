// Schema migrations for metrics. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_seriesset",
    up: `CREATE TABLE seriesset (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      resolution TEXT NOT NULL,
      retention TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE seriesset",
  },
  {
    id: "0002_seriesset_created_index",
    up: "CREATE INDEX seriesset_created_idx ON seriesset (id)",
    down: "DROP INDEX seriesset_created_idx",
  },
  {
    id: "0003_seriesset_soft_delete",
    up: "ALTER TABLE seriesset ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE seriesset DROP COLUMN deleted_at",
  },
  {
    id: "0004_seriesset_metadata_jsonb",
    up: "ALTER TABLE seriesset ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE seriesset DROP COLUMN metadata",
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
