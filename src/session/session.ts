// Session driver: owns the context view across runs, persists every
// message, and computes run boundaries — the ONE sanctioned place where
// reclaim happens (DESIGN.md context engine #3). When a new user prompt
// starts a run, tool results from all finished runs are reclaimed in the
// wire projection (losslessly: storage and view keep the originals).

import type { Message } from "../provider/types";
import type { RunOptions, RunResult } from "../engine/loop";
import { runLoop } from "../engine/loop";
import type { SessionMeta, SessionStore } from "./store";

export type SessionRunOptions = Omit<
  RunOptions,
  "prompt" | "messages" | "previousSummary" | "reclaimIds" | "onMessage" | "onCompaction"
>;

export class Session {
  private view: Message[];
  private summary: string | undefined;
  private readonly reclaimIds = new Set<string>();

  private constructor(
    private readonly store: SessionStore,
    readonly meta: SessionMeta,
    view: Message[],
    summary?: string,
  ) {
    this.view = view;
    this.summary = summary;
  }

  static create(store: SessionStore, model: string, cwd: string): Session {
    return new Session(store, store.create(model, cwd), []);
  }

  static resume(store: SessionStore, id: string): Session | null {
    const meta = store.get(id);
    if (meta === null) return null;
    const { view, summary } = store.rebuildView(id);
    const s = new Session(store, meta, view, summary);
    s.reclaimFinishedRuns();
    return s;
  }

  /** Mark every tool result currently in the view as belonging to a
   * finished run. Called at run boundaries only — mid-run reclaim would
   * break the prefix cache every turn. */
  private reclaimFinishedRuns(): void {
    for (const m of this.view) {
      if (m.role !== "user") continue;
      for (const b of m.content) {
        if (b.type === "tool_result") this.reclaimIds.add(b.tool_use_id);
      }
    }
  }

  async run(prompt: string, opts: SessionRunOptions): Promise<RunResult> {
    this.reclaimFinishedRuns();
    const result = await runLoop({
      ...opts,
      prompt,
      messages: this.view,
      ...(this.summary !== undefined ? { previousSummary: this.summary } : {}),
      reclaimIds: this.reclaimIds,
      onMessage: (m) => this.store.appendMessage(this.meta.id, m),
      onCompaction: (info) => {
        this.summary = info.summary;
        // After compaction the loop's view is [summary message, ...tail].
        this.store.appendCompaction(this.meta.id, {
          summary: info.summary,
          llm: info.llm,
          tail: this.view.slice(1),
          task: info.task,
        });
      },
    });
    return result;
  }
}
