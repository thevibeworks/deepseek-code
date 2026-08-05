// Session storage (DESIGN.md "Sessions, memory, observability"): SQLite
// via bun:sqlite, zero deps. Append-only rows; compaction is stored as
// its own row kind so the transcript keeps everything and the context
// VIEW is a projection (rebuildView). Fork/resume read the same rows.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message } from "../provider/types";
import { buildCompactionText } from "../engine/compact";

/** The retained tail is stored verbatim: seq arithmetic cannot describe a
 * tail that re-retains messages from before an earlier compaction. `task`
 * is the run prompt pinned verbatim in the compacted view. */
export type CompactionRecord = { summary: string; llm: boolean; tail: Message[]; task?: string };

export type SessionMeta = {
  id: string;
  createdAt: string;
  model: string;
  cwd: string;
};

export function defaultDbPath(): string {
  return process.env.DSC_DATA_DIR !== undefined
    ? join(process.env.DSC_DATA_DIR, "sessions.db")
    : join(homedir(), ".dsc", "sessions.db");
}

export class SessionStore {
  private db: Database;

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      model TEXT NOT NULL,
      cwd TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS session_message (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(session_id, seq)
    )`);
  }

  create(model: string, cwd: string, id?: string): SessionMeta {
    const meta: SessionMeta = {
      id: id ?? crypto.randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      model,
      cwd,
    };
    this.db.run(
      "INSERT INTO session (id, created_at, model, cwd) VALUES (?, ?, ?, ?)",
      [meta.id, meta.createdAt, meta.model, meta.cwd],
    );
    return meta;
  }

  get(id: string): SessionMeta | null {
    const row = this.db
      .query("SELECT id, created_at, model, cwd FROM session WHERE id = ?")
      .get(id) as any;
    return row
      ? { id: row.id, createdAt: row.created_at, model: row.model, cwd: row.cwd }
      : null;
  }

  /** Most recent sessions first. Sub-agent children (id `parent.childId`)
   * are excluded — they are an implementation detail of one parent run,
   * never something a user resumes. */
  list(opts: { cwd?: string; limit?: number } = {}): (SessionMeta & { messages: number })[] {
    const where = opts.cwd !== undefined ? "WHERE s.cwd = ?" : "";
    const rows = this.db
      .query(
        `SELECT s.id, s.created_at, s.model, s.cwd,
                (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS n
         FROM session s ${where} ORDER BY s.created_at DESC`,
      )
      .all(...(opts.cwd !== undefined ? [opts.cwd] : [])) as any[];
    return rows
      .filter((r) => !r.id.includes("."))
      .slice(0, opts.limit ?? 20)
      .map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        model: r.model,
        cwd: r.cwd,
        messages: r.n,
      }));
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS m FROM session_message WHERE session_id = ?")
      .get(sessionId) as any;
    return (row?.m ?? 0) + 1;
  }

  appendMessage(sessionId: string, message: Message): number {
    const seq = this.nextSeq(sessionId);
    this.db.run(
      "INSERT INTO session_message (session_id, seq, kind, payload) VALUES (?, ?, 'message', ?)",
      [sessionId, seq, JSON.stringify(message)],
    );
    return seq;
  }

  appendCompaction(sessionId: string, rec: CompactionRecord): number {
    const seq = this.nextSeq(sessionId);
    this.db.run(
      "INSERT INTO session_message (session_id, seq, kind, payload) VALUES (?, ?, 'compaction', ?)",
      [sessionId, seq, JSON.stringify(rec)],
    );
    return seq;
  }

  /** Rebuild the current context view: the last compaction row (if any)
   * yields its summary message + stored tail; message rows appended after
   * it follow. Resume trap (observed in mainstream harnesses): usage on preserved
   * assistant messages is ZEROED so a stale anchor can't trigger an
   * instant autocompact spiral. */
  rebuildView(sessionId: string): { view: Message[]; summary?: string } {
    const rows = this.db
      .query(
        "SELECT seq, kind, payload FROM session_message WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as any[];
    let lastCompaction: { rec: CompactionRecord; seq: number } | null = null;
    for (const r of rows) {
      if (r.kind === "compaction") lastCompaction = { rec: JSON.parse(r.payload), seq: r.seq };
    }
    const view: Message[] = [];
    let summary: string | undefined;
    if (lastCompaction !== null) {
      summary = lastCompaction.rec.summary;
      view.push({
        role: "user",
        content: [
          { type: "text", text: buildCompactionText(lastCompaction.rec.summary, lastCompaction.rec.task) },
        ],
      });
      for (const m of lastCompaction.rec.tail) view.push(zeroed(m));
    }
    for (const r of rows) {
      if (r.kind !== "message") continue;
      if (lastCompaction !== null && r.seq < lastCompaction.seq) continue;
      view.push(zeroed(JSON.parse(r.payload) as Message));
    }
    return summary !== undefined ? { view, summary } : { view };
  }

  close(): void {
    this.db.close();
  }
}

function zeroed(m: Message): Message {
  if (m.role !== "assistant") return m;
  return { ...m, usage: { inputFresh: 0, cacheRead: 0, output: 0 } };
}
