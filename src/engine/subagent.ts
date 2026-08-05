// Sub-agents (DESIGN.md pillar 3, minimum viable form). Roles are
// prompt+permission presets: the permission IS the tool subset (bash in a
// "read-only" role is advisory-only — real sandboxing is out of scope and
// documented as such). Role flavor rides in the child's USER prompt, not
// its system prompt, so every child with the same toolset shares one
// stable system prefix (prefix cache pays across children).
// Budget envelopes: max turns / max total tokens / max wall-clock. A
// looping child dies quietly; the parent gets a partial report.
// Children are model-pinned per role (Round 4 rule #1: one transcript,
// one model) — a pro reviewer is a fresh pro context, never a mid-
// transcript model switch.

import type { Message, Usage } from "../provider/types";
import { addUsage, zeroUsage } from "../provider/types";
import type { RunOptions, RunResult } from "./loop";
import { runLoop } from "./loop";
import type { ToolDefinition } from "../tools/index";
import { readTool } from "../tools/read";
import { bashTool } from "../tools/bash";
import { editTool } from "../tools/edit";
import { writeTool } from "../tools/write";
import { truncateHead } from "../tools/truncate";

export type RoleName = "explorer" | "implementer" | "reviewer" | "tester";

export type Budget = {
  maxTurns: number;
  /** Cap on summed per-turn usage (fresh + cached input + output). */
  maxTotalTokens: number;
  maxWallMs: number;
};

export type Role = {
  name: RoleName;
  description: string;
  tools: ToolDefinition[];
  model: string;
  preamble: string;
  budget: Budget;
};

const READ_ONLY_TOOLS = [readTool, bashTool];

export const ROLES: Record<RoleName, Role> = {
  explorer: {
    name: "explorer",
    description: "read-only investigation (fast model)",
    tools: READ_ONLY_TOOLS,
    model: "deepseek-v4-flash",
    preamble:
      "You are an explorer sub-agent: investigate the codebase to answer " +
      "the task below. Do not modify any files.",
    budget: { maxTurns: 12, maxTotalTokens: 150_000, maxWallMs: 120_000 },
  },
  implementer: {
    name: "implementer",
    description: "makes a code change and verifies it (fast model)",
    tools: [readTool, bashTool, editTool, writeTool],
    model: "deepseek-v4-flash",
    preamble:
      "You are an implementer sub-agent: make the change described in the " +
      "task below, verify it, and report exactly what you changed.",
    budget: { maxTurns: 24, maxTotalTokens: 300_000, maxWallMs: 240_000 },
  },
  reviewer: {
    name: "reviewer",
    description: "read-only code review (strong model)",
    tools: READ_ONLY_TOOLS,
    model: "deepseek-v4-pro",
    preamble:
      "You are a reviewer sub-agent: read the code relevant to the task " +
      "below and report concrete problems (bugs, missed edge cases, broken " +
      "invariants) with file:line references. Do not modify any files.",
    budget: { maxTurns: 12, maxTotalTokens: 200_000, maxWallMs: 180_000 },
  },
  tester: {
    name: "tester",
    description: "runs tests/commands and reports results (fast model)",
    tools: READ_ONLY_TOOLS,
    model: "deepseek-v4-flash",
    preamble:
      "You are a tester sub-agent: run the commands or tests named in the " +
      "task below and report the results. Do not edit source files.",
    budget: { maxTurns: 12, maxTotalTokens: 150_000, maxWallMs: 180_000 },
  },
};

const REPORT_SUFFIX =
  "\n\nEnd with a concise report (under ~30 lines). The report is the ONLY " +
  "thing the requesting agent sees — include every fact it needs and " +
  "nothing else.";

/** Total children per run. A guardrail against runaway spawning, far above
 * any sane fan-out. */
export const MAX_CHILDREN = 8;

export type TaskStatus = "running" | "done" | "partial" | "failed" | "cancelled";

export type TaskRecord = {
  id: string;
  role: RoleName;
  prompt: string;
  status: TaskStatus;
  /** Set when a budget limit killed the child. */
  killedBy?: "turns" | "tokens" | "wall";
  usage: Usage;
  turns: number;
  wallMs: number;
  resultText: string;
  sessionId?: string;
};

export type SubagentConfig = {
  apiKey: string;
  baseUrl: string;
  cwd: string;
  /** Parent context budget, passed through so long children autocompact. */
  contextBudget?: number;
  signal?: AbortSignal;
  /** Injectable loop runner (tests stub this). */
  runFn?: (opts: RunOptions) => Promise<RunResult>;
  /** When set, each child transcript persists as its own session on disk.
   * Returns a per-message hook (Session-store shaped, decoupled from it). */
  persist?: (childId: string, model: string) => {
    sessionId: string;
    onMessage: (m: Message) => void;
  };
  /** Lifecycle notifications for frontends (verbose stderr today). */
  onLifecycle?: (rec: TaskRecord, phase: "spawn" | "end") => void;
};

type Slot = {
  rec: TaskRecord;
  promise: Promise<void>;
  controller: AbortController;
  budgetHit?: "tokens" | "wall";
};

export class SubagentManager {
  private readonly slots = new Map<string, Slot>();
  private counter = 0;

  constructor(private readonly cfg: SubagentConfig) {}

  spawn(roleName: string, prompt: string): { ok: true; id: string } | { ok: false; error: string } {
    const role = ROLES[roleName as RoleName];
    if (!role) {
      return {
        ok: false,
        error: `unknown role "${roleName}" (one of: ${Object.keys(ROLES).join(", ")})`,
      };
    }
    if (this.counter >= MAX_CHILDREN) {
      return { ok: false, error: `sub-agent limit reached (${MAX_CHILDREN} per run)` };
    }
    this.counter++;
    const id = `t${this.counter}`;
    const controller = new AbortController();
    if (this.cfg.signal !== undefined) {
      this.cfg.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const persisted = this.cfg.persist?.(id, role.model);
    const rec: TaskRecord = {
      id,
      role: role.name,
      prompt,
      status: "running",
      usage: zeroUsage(),
      turns: 0,
      wallMs: 0,
      resultText: "",
      ...(persisted !== undefined ? { sessionId: persisted.sessionId } : {}),
    };
    const slot: Slot = { rec, controller, promise: Promise.resolve() };

    const wallTimer = setTimeout(() => {
      slot.budgetHit = "wall";
      controller.abort();
    }, role.budget.maxWallMs);
    let spent = 0;
    const runFn = this.cfg.runFn ?? runLoop;
    const t0 = Date.now();
    slot.promise = runFn({
      prompt: role.preamble + "\n\nTask: " + prompt + REPORT_SUFFIX,
      model: role.model,
      cwd: this.cfg.cwd,
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
      tools: role.tools,
      maxTurns: role.budget.maxTurns,
      signal: controller.signal,
      ...(this.cfg.contextBudget !== undefined ? { contextBudget: this.cfg.contextBudget } : {}),
      ...(persisted !== undefined ? { onMessage: persisted.onMessage } : {}),
      onEvent: (e) => {
        if (e.type !== "turn_end") return;
        spent += e.usage.inputFresh + e.usage.cacheRead + e.usage.output;
        if (spent > role.budget.maxTotalTokens && slot.budgetHit === undefined) {
          slot.budgetHit = "tokens";
          controller.abort();
        }
      },
    })
      .then((result) => {
        rec.usage = result.usage;
        rec.turns = result.turns;
        rec.resultText = result.resultText;
        rec.status =
          result.endReason === "completed"
            ? "done"
            : result.endReason === "max_turns"
              ? "partial"
              : result.endReason === "aborted"
                ? slot.budgetHit !== undefined
                  ? "partial"
                  : "cancelled"
                : "failed";
        if (result.endReason === "max_turns") rec.killedBy = "turns";
        else if (slot.budgetHit !== undefined) rec.killedBy = slot.budgetHit;
        if (result.endReason === "error" && result.errorMessage !== undefined) {
          rec.resultText = rec.resultText || `(error: ${result.errorMessage})`;
        }
      })
      .catch((err) => {
        rec.status = "failed";
        rec.resultText = `(sub-agent crashed: ${String(err)})`;
      })
      .finally(() => {
        clearTimeout(wallTimer);
        rec.wallMs = Date.now() - t0;
        this.cfg.onLifecycle?.(rec, "end");
      });

    this.slots.set(id, slot);
    this.cfg.onLifecycle?.(rec, "spawn");
    return { ok: true, id };
  }

  /** Block until the given tasks (default: all) settle. */
  async wait(ids?: string[]): Promise<TaskRecord[]> {
    const selected = this.select(ids);
    await Promise.all(selected.map((s) => s.promise));
    return selected.map((s) => s.rec);
  }

  get(id: string): TaskRecord | null {
    return this.slots.get(id)?.rec ?? null;
  }

  cancel(id: string): boolean {
    const slot = this.slots.get(id);
    if (!slot || slot.rec.status !== "running") return false;
    slot.controller.abort();
    return true;
  }

  /** Abort every still-running child (parent run is ending). */
  cancelAll(): void {
    for (const slot of this.slots.values()) {
      if (slot.rec.status === "running") slot.controller.abort();
    }
  }

  /** Summed usage across all children — the parent's reported totals must
   * include this or cost comparisons lie. */
  totalUsage(): Usage {
    let u = zeroUsage();
    for (const s of this.slots.values()) u = addUsage(u, s.rec.usage);
    return u;
  }

  count(): number {
    return this.counter;
  }

  private select(ids?: string[]): Slot[] {
    if (ids === undefined || ids.length === 0) return [...this.slots.values()];
    return ids
      .map((id) => this.slots.get(id))
      .filter((s): s is Slot => s !== undefined);
  }
}

/** Compressed report for the parent transcript: status header + the
 * child's final text, head-truncated (reports read top-down). */
export function renderReport(rec: TaskRecord): string {
  const tokens = rec.usage.inputFresh + rec.usage.cacheRead + rec.usage.output;
  const header =
    `[${rec.id} ${rec.role}] ${rec.status}` +
    (rec.killedBy !== undefined ? ` (budget: ${rec.killedBy})` : "") +
    ` — ${rec.turns} turns, ${Math.round(tokens / 1000)}k tokens, ${Math.round(rec.wallMs / 1000)}s`;
  const body = rec.resultText.trim() === "" ? "(no report text)" : rec.resultText.trim();
  const t = truncateHead(body, 120, 6_000);
  const note =
    rec.status === "partial"
      ? "\n[Partial: the sub-agent hit its budget before finishing; treat the report as incomplete.]"
      : "";
  return `${header}\n${t.truncated ? t.text + "\n" + t.notice : t.text}${note}`;
}
