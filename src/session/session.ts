// Session driver: owns the context view across runs, persists every
// message, and computes run boundaries — the ONE sanctioned place where
// reclaim happens (DESIGN.md context engine #3). When a new user prompt
// starts a run, tool results from all finished runs are reclaimed in the
// wire projection (losslessly: storage and view keep the originals).

import type { Message, Usage } from "../provider/types";
import { addUsage, zeroUsage } from "../provider/types";
import type { RunOptions, RunResult } from "../engine/loop";
import { runLoop } from "../engine/loop";
import { compactedView, POST_COMPACT_ENVELOPE_TOKENS, retainedTail, summarize } from "../engine/compact";
import { estimateTokens } from "../engine/context";
import type { SessionMeta, SessionStore } from "./store";

export type SessionRunOptions = Omit<
  RunOptions,
  "prompt" | "messages" | "previousSummary" | "reclaimIds" | "onMessage" | "onCompaction"
>;

export class Session {
  private view: Message[];
  private summary: string | undefined;
  private readonly reclaimIds = new Set<string>();
  /** Last user prompt, pinned as the task on a manual compaction. */
  private lastPrompt: string | undefined;
  private usage: Usage = zeroUsage();
  private turns = 0;

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

  /** Estimated size of the current context view, in tokens. */
  contextTokens(): number {
    return this.view.length === 0 ? 0 : estimateTokens(JSON.stringify(this.view));
  }

  /** Usage and turns accumulated over every run on this session object.
   * Resumed history is NOT included: those tokens were paid in another
   * process, and counting them again would double-bill the display. */
  totals(): { usage: Usage; turns: number } {
    return { usage: this.usage, turns: this.turns };
  }

  /** Compact on demand (the interactive `/compact`). Same pipeline as the
   * automatic path, minus the threshold check: summarize, keep a tail at a
   * wire-valid boundary, pin the last prompt. Returns null when there is
   * nothing to compact. */
  async compact(opts: {
    apiKey: string;
    baseUrl: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<{ before: number; after: number; llm: boolean } | null> {
    if (this.view.length === 0) return null;
    const before = this.contextTokens();
    const { summary, llm } = await summarize(this.view, this.summary, opts);
    const tail = retainedTail(this.view, POST_COMPACT_ENVELOPE_TOKENS);
    const next = compactedView(summary, this.lastPrompt, tail);
    this.view.length = 0;
    this.view.push(...next);
    this.summary = summary;
    this.store.appendCompaction(this.meta.id, {
      summary,
      llm,
      tail,
      ...(this.lastPrompt !== undefined ? { task: this.lastPrompt } : {}),
    });
    return { before, after: this.contextTokens(), llm };
  }

  async run(prompt: string, opts: SessionRunOptions): Promise<RunResult> {
    this.lastPrompt = prompt;
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
    this.usage = addUsage(this.usage, result.usage);
    this.turns += result.turns;
    return result;
  }
}
