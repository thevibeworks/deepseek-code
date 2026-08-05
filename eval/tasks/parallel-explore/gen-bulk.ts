#!/usr/bin/env bun
// Fixture bulk generator for parallel-explore. Run from the task dir:
//   bun gen-bulk.ts
//
// Why this exists: the answer-bearing files (the config-layering chains)
// are hand-written and live in git. But 3 files per service is not a
// realistic service — and fixture SIZE is the independent variable this
// task measures (bounded sub-contexts vs one giant context). Generated
// bulk gives each service a realistic file count and byte weight without
// hand-writing 100 KB of filler.
//
// Hard rule: generated modules must never mention the answer vocabulary
// (late fee / penalty, retry, batch, coalescing window, refresh token,
// sampling pct) or the answer numbers. They are unrelated infrastructure
// concerns — plumbing an explorer must read past, not evidence it must
// weigh. FORBIDDEN below is asserted after generation.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixture");

const FORBIDDEN =
  /latefee|late_fee|penalty|retry|retries|batch|coalesc|refresh|sampling|samplepct|4\.5|12\.5|\b256\b|\b25\b|\b21\b|\b7443\b/i;

type Svc = {
  name: string;
  entity: string; // domain noun, singular
  entities: string; // plural
  fields: string[];
};

const SERVICES: Svc[] = [
  { name: "billing", entity: "invoice", entities: "invoices", fields: ["id", "customerId", "currency", "issuedAt", "status"] },
  { name: "gateway", entity: "route", entities: "routes", fields: ["id", "upstream", "method", "pathPattern", "authMode"] },
  { name: "indexer", entity: "document", entities: "documents", fields: ["id", "shard", "checksum", "indexedAt", "version"] },
  { name: "notifier", entity: "message", entities: "messages", fields: ["id", "userId", "channel", "template", "createdAt"] },
  { name: "auth", entity: "session", entities: "sessions", fields: ["id", "subject", "issuer", "issuedAt", "deviceId"] },
  { name: "metrics", entity: "series", entities: "seriesSet", fields: ["id", "name", "unit", "resolution", "retention"] },
];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// --- module templates: ordinary infrastructure, deliberately answer-free ---

function validators(s: Svc): string {
  return `// ${cap(s.entity)} validation. Pure functions; no I/O. Every rule returns a
// problem string so callers can report all failures at once rather than
// failing on the first.
const REQUIRED_FIELDS = ${JSON.stringify(s.fields)};
const ID_PATTERN = /^${s.entity.slice(0, 3)}_[0-9a-f]{12}$/;
const MAX_FIELD_LEN = 512;

function missingFields(${s.entity}) {
  return REQUIRED_FIELDS.filter((f) => ${s.entity}[f] === undefined || ${s.entity}[f] === null);
}

function badlyTypedFields(${s.entity}) {
  const problems = [];
  for (const [key, value] of Object.entries(${s.entity})) {
    if (typeof value === "string" && value.length > MAX_FIELD_LEN) {
      problems.push(\`field \${key} exceeds \${MAX_FIELD_LEN} chars\`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      problems.push(\`field \${key} is not finite\`);
    }
  }
  return problems;
}

function validateId(id) {
  if (typeof id !== "string") return ["id must be a string"];
  if (!ID_PATTERN.test(id)) return [\`id \${id} does not match the ${s.entity} id format\`];
  return [];
}

function validate${cap(s.entity)}(${s.entity}) {
  const problems = [];
  for (const f of missingFields(${s.entity})) problems.push(\`missing required field \${f}\`);
  problems.push(...validateId(${s.entity}.id ?? ""));
  problems.push(...badlyTypedFields(${s.entity}));
  return problems;
}

function assertValid${cap(s.entity)}(${s.entity}) {
  const problems = validate${cap(s.entity)}(${s.entity});
  if (problems.length > 0) {
    throw new Error(\`invalid ${s.entity}: \${problems.join("; ")}\`);
  }
  return ${s.entity};
}

module.exports = { validate${cap(s.entity)}, assertValid${cap(s.entity)}, missingFields, validateId, REQUIRED_FIELDS };
`;
}

function serializer(s: Svc): string {
  return `// Wire serialization for ${s.entities}. The external representation is
// snake_case and frozen by the public API contract; the internal shape is
// camelCase. Keep the two mappings adjacent so they cannot drift.
const WIRE_KEYS = {
${s.fields.map((f) => `  ${f}: "${f.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())}",`).join("\n")}
};

const INTERNAL_KEYS = Object.fromEntries(
  Object.entries(WIRE_KEYS).map(([internal, wire]) => [wire, internal]),
);

function toWire(${s.entity}) {
  const out = {};
  for (const [internal, wire] of Object.entries(WIRE_KEYS)) {
    if (${s.entity}[internal] !== undefined) out[wire] = ${s.entity}[internal];
  }
  return out;
}

function fromWire(payload) {
  const out = {};
  for (const [wire, internal] of Object.entries(INTERNAL_KEYS)) {
    if (payload[wire] !== undefined) out[internal] = payload[wire];
  }
  return out;
}

function toWireCollection(items) {
  return { items: items.map(toWire), count: items.length };
}

function redactForLogs(${s.entity}) {
  const clone = { ...${s.entity} };
  for (const key of ["token", "secret", "authorization", "cookie"]) delete clone[key];
  return clone;
}

module.exports = { toWire, fromWire, toWireCollection, redactForLogs, WIRE_KEYS };
`;
}

function pagination(s: Svc): string {
  return `// Cursor pagination for ${s.entity} listings. Cursors are opaque base64
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
`;
}

function errors(s: Svc): string {
  return `// Error taxonomy for ${s.name}. Every thrown error carries a stable code
// so the API layer maps it to a status without string matching on
// messages (messages change; codes are contract).
class ${cap(s.name)}Error extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "${cap(s.name)}Error";
    this.code = code;
    this.details = details ?? null;
  }
}

const CODES = {
  NOT_FOUND: "${s.name}.not_found",
  INVALID: "${s.name}.invalid",
  CONFLICT: "${s.name}.conflict",
  UPSTREAM: "${s.name}.upstream_failed",
  FORBIDDEN: "${s.name}.forbidden",
  INTERNAL: "${s.name}.internal",
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
  return new ${cap(s.name)}Error(CODES.NOT_FOUND, \`${s.entity} \${id} not found\`, { id });
}

function invalid(problems) {
  return new ${cap(s.name)}Error(CODES.INVALID, \`invalid ${s.entity}\`, { problems });
}

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] ?? 500;
}

module.exports = { ${cap(s.name)}Error, CODES, statusFor, notFound, invalid };
`;
}

function repository(s: Svc): string {
  return `// In-memory ${s.entity} repository used by the local dev harness and the
// test suite. Production binds the same interface to Postgres; keeping
// the shapes identical is what lets the tests be meaningful.
const { assertValid${cap(s.entity)} } = require("./validators");
const { notFound } = require("./errors");

class ${cap(s.entity)}Repository {
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

  put(${s.entity}) {
    assertValid${cap(s.entity)}(${s.entity});
    this.rows.set(${s.entity}.id, { ...${s.entity} });
    return this.get(${s.entity}.id);
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

module.exports = { ${cap(s.entity)}Repository };
`;
}

function handlers(s: Svc): string {
  return `// HTTP handlers for ${s.entities}. Thin: parse, delegate, serialize.
// Business rules live in the domain modules, never here — a handler that
// makes decisions is a handler that gets bypassed by the next caller.
const { toWire, toWireCollection, fromWire } = require("../lib/serializer");
const { paginate } = require("../lib/pagination");
const { validate${cap(s.entity)} } = require("../lib/validators");
const { statusFor, invalid } = require("../lib/errors");

function makeHandlers(repo) {
  return {
    async get(req, res) {
      try {
        res.json(toWire(repo.get(req.params.id)));
      } catch (err) {
        res.status(statusFor(err)).json({ error: err.code, message: err.message });
      }
    },

    async list(req, res) {
      const page = paginate(repo.list(), {
        cursor: req.query.cursor,
        pageSize: req.query.page_size ? Number(req.query.page_size) : undefined,
      });
      res.json({ ...toWireCollection(page.items), next_cursor: page.nextCursor });
    },

    async put(req, res) {
      const ${s.entity} = fromWire(req.body ?? {});
      const problems = validate${cap(s.entity)}(${s.entity});
      if (problems.length > 0) {
        const err = invalid(problems);
        return res.status(statusFor(err)).json({ error: err.code, details: err.details });
      }
      res.json(toWire(repo.put(${s.entity})));
    },

    async remove(req, res) {
      try {
        repo.remove(req.params.id);
        res.status(204).end();
      } catch (err) {
        res.status(statusFor(err)).json({ error: err.code, message: err.message });
      }
    },
  };
}

function mount(app, basePath, repo) {
  const h = makeHandlers(repo);
  app.get(\`\${basePath}/:id\`, h.get);
  app.get(basePath, h.list);
  app.put(\`\${basePath}/:id\`, h.put);
  app.delete(\`\${basePath}/:id\`, h.remove);
  return app;
}

module.exports = { makeHandlers, mount };
`;
}

function migrations(s: Svc): string {
  const table = s.entities.toLowerCase();
  return `// Schema migrations for ${s.name}. Append-only: never edit a shipped
// migration, add a new one. The runner records applied ids in
// schema_migrations and refuses to run out of order.
const MIGRATIONS = [
  {
    id: "0001_create_${table}",
    up: \`CREATE TABLE ${table} (
${s.fields.map((f) => `      ${f.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} TEXT NOT NULL`).join(",\n")},
      PRIMARY KEY (id)
    )\`,
    down: "DROP TABLE ${table}",
  },
  {
    id: "0002_${table}_created_index",
    up: "CREATE INDEX ${table}_created_idx ON ${table} (id)",
    down: "DROP INDEX ${table}_created_idx",
  },
  {
    id: "0003_${table}_soft_delete",
    up: "ALTER TABLE ${table} ADD COLUMN deleted_at TIMESTAMPTZ NULL",
    down: "ALTER TABLE ${table} DROP COLUMN deleted_at",
  },
  {
    id: "0004_${table}_metadata_jsonb",
    up: "ALTER TABLE ${table} ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    down: "ALTER TABLE ${table} DROP COLUMN metadata",
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
`;
}

function health(s: Svc): string {
  return `// Liveness and readiness for ${s.name}. Liveness answers "is the process
// wedged"; readiness answers "should the load balancer send traffic".
// They are different questions and must not share an implementation.
const START_TIME = Date.now();
const DEPENDENCIES = ["postgres", "redis", "object-store"];

function uptimeSeconds() {
  return Math.floor((Date.now() - START_TIME) / 1000);
}

function liveness() {
  return { status: "ok", service: "${s.name}", uptime_seconds: uptimeSeconds() };
}

async function checkDependency(name, probe) {
  const started = Date.now();
  try {
    await probe();
    return { name, healthy: true, latency_ms: Date.now() - started };
  } catch (err) {
    return { name, healthy: false, latency_ms: Date.now() - started, error: String(err) };
  }
}

async function readiness(probes = {}) {
  const results = await Promise.all(
    DEPENDENCIES.map((name) => checkDependency(name, probes[name] ?? (async () => {}))),
  );
  const unhealthy = results.filter((r) => !r.healthy);
  return {
    status: unhealthy.length === 0 ? "ready" : "degraded",
    service: "${s.name}",
    dependencies: results,
  };
}

module.exports = { liveness, readiness, uptimeSeconds, DEPENDENCIES };
`;
}

const MODULES: Array<[string, (s: Svc) => string]> = [
  ["lib/validators.js", validators],
  ["lib/serializer.js", serializer],
  ["lib/pagination.js", pagination],
  ["lib/errors.js", errors],
  ["lib/repository.js", repository],
  ["api/handlers.js", handlers],
  ["db/migrations.js", migrations],
  ["ops/health.js", health],
];

let files = 0;
let bytes = 0;
for (const svc of SERVICES) {
  for (const [relPath, render] of MODULES) {
    const body = render(svc);
    const hit = body.match(FORBIDDEN);
    if (hit !== null) {
      throw new Error(
        `generated ${svc.name}/${relPath} mentions answer vocabulary "${hit[0]}" — ` +
          `bulk must never look like evidence`,
      );
    }
    const full = join(FIXTURE, "services", svc.name, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
    files++;
    bytes += body.length;
  }
}
console.log(`generated ${files} files, ${(bytes / 1024).toFixed(1)} KB`);
