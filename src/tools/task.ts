// The task tool: sub-agent lifecycle as ONE tool with an action enum
// (DeepSeek-TUI's tasks-tool shape, reduced to spawn/wait/result/cancel).
// One tool = one line in the prompt's tool index; the lifecycle verbs are
// arguments, not prompt-visible surface. Built by factory because it
// closes over a per-run SubagentManager — the only tool with run state.

import type { ToolDefinition } from "./index";
import { normalizeAliases } from "./index";
import type { SubagentManager } from "../engine/subagent";
import { renderReport, ROLES } from "../engine/subagent";

const ROLE_LINES = Object.values(ROLES)
  .map((r) => `${r.name} (${r.description})`)
  .join(", ");

export function makeTaskTool(mgr: SubagentManager): ToolDefinition {
  return {
    name: "task",
    description:
      "Delegate work to parallel sub-agents. Actions: spawn (start a " +
      "sub-agent; returns its id immediately), wait (block until the given " +
      "ids — or all — finish; returns their reports), result (report of " +
      "one finished sub-agent), cancel (stop one). Roles: " +
      ROLE_LINES +
      ". Each sub-agent works in the same directory but has its own " +
      "context and budget; only its final report comes back.",
    promptSnippet:
      "Delegate work to parallel sub-agents (spawn several, then wait).",
    promptGuidelines: [
      // Delegation TIMING is the whole game (measured, BASELINE.md
      // parallel-fix): delegating early beats solo on wall-clock, while
      // delegating after you have already read the material loses on both
      // wall-clock and cost — the context gets paid for twice, once by you
      // and once by the child that re-reads it.
      "When a task splits into several independent pieces of real work, delegate BEFORE you investigate: spawn one task sub-agent per piece in a single turn, as an early action, and let each sub-agent do its own reading. Do not explore the material first and then hand it off — that pays for the same context twice and is slower than just doing the work yourself. Give each a self-contained prompt naming its piece; sub-agents see none of your context. Then wait for all of them at once.",
    ],
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["spawn", "wait", "result", "cancel"],
          description: "Lifecycle action.",
        },
        role: {
          type: "string",
          enum: Object.keys(ROLES),
          description: "Sub-agent role (action=spawn).",
        },
        prompt: {
          type: "string",
          description:
            "Self-contained task for the sub-agent, including any context it needs (action=spawn).",
        },
        id: { type: "string", description: "Task id (action=result/cancel)." },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Task ids to wait for; omit to wait for all (action=wait).",
        },
      },
      required: ["action"],
    },
    coerce: (input) =>
      normalizeAliases(input, {
        prompt: ["task", "instructions"],
        id: ["task_id"],
        ids: ["task_ids"],
      }),
    async execute(input) {
      switch (input.action) {
        case "spawn": {
          if (typeof input.role !== "string" || typeof input.prompt !== "string") {
            return {
              output: 'spawn requires "role" and "prompt".',
              isError: true,
            };
          }
          const r = mgr.spawn(input.role, input.prompt);
          if (!r.ok) return { output: r.error, isError: true };
          return {
            output: `Spawned ${r.id} (${input.role}). It runs in parallel; spawn any other sub-agents you need, then use action "wait" to collect reports.`,
          };
        }
        case "wait": {
          const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined;
          const recs = await mgr.wait(ids);
          if (recs.length === 0) {
            return { output: "No sub-agents to wait for.", isError: true };
          }
          return { output: recs.map(renderReport).join("\n\n") };
        }
        case "result": {
          const rec = mgr.get(String(input.id ?? ""));
          if (rec === null) {
            return { output: `No such task "${input.id}".`, isError: true };
          }
          if (rec.status === "running") {
            return {
              output: `${rec.id} is still running — use action "wait" to block until it finishes.`,
              isError: true,
            };
          }
          return { output: renderReport(rec) };
        }
        case "cancel": {
          const id = String(input.id ?? "");
          if (!mgr.cancel(id)) {
            return { output: `No running task "${id}" to cancel.`, isError: true };
          }
          return { output: `Cancelled ${id}.` };
        }
        default:
          return {
            output: `Unknown action "${input.action}" (one of: spawn, wait, result, cancel).`,
            isError: true,
          };
      }
    },
  };
}
