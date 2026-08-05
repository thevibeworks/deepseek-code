// Schema migrations for gateway. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_routes",
    up: `CREATE TABLE routes (
      id TEXT NOT NULL,
      upstream TEXT NOT NULL,
      method TEXT NOT NULL,
      path_pattern TEXT NOT NULL,
      auth_mode TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE routes",
  },
  {
    id: "0002_routes_created_index",
    up: "CREATE INDEX routes_created_idx ON routes (id)",
    down: "DROP INDEX routes_created_idx",
  },
  {
    id: "0003_routes_soft_delete",
    up: "ALTER TABLE routes ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE routes DROP COLUMN deleted_at",
  },
  {
    id: "0004_routes_metadata_jsonb",
    up: "ALTER TABLE routes ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE routes DROP COLUMN metadata",
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
