// Schema migrations for billing. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_invoices",
    up: `CREATE TABLE invoices (
      id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (id)
    )`,
    down: "DROP TABLE invoices",
  },
  {
    id: "0002_invoices_created_index",
    up: "CREATE INDEX invoices_created_idx ON invoices (id)",
    down: "DROP INDEX invoices_created_idx",
  },
  {
    id: "0003_invoices_soft_delete",
    up: "ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE invoices DROP COLUMN deleted_at",
  },
  {
    id: "0004_invoices_metadata_jsonb",
    up: "ALTER TABLE invoices ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE invoices DROP COLUMN metadata",
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
