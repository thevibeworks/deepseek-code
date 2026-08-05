import type { ToolDefinition } from "./index";
import { normalizeAliases } from "./index";
import { truncateTail } from "./truncate";
import { drainStream, OutputAccumulator } from "./accumulator";
import type { AccumulatedOutput } from "./accumulator";

const DEFAULT_TIMEOUT_S = 120;

/** Render one stream's accumulated output for the tool result. */
function render(a: AccumulatedOutput): string {
  if (!a.spilled) return a.text;
  return (
    `[Output is ${a.bytes} bytes — full output saved to ${a.path}. ` +
    `Use read with offset/limit (or grep the file) to inspect it. ` +
    `Preview of the first and last lines:]\n` +
    a.text
  );
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a bash command in the working directory. Use this for searching " +
    "(grep -rn, find), listing (ls), running tests, and everything else a " +
    "shell does. Output is capped at the last 2000 lines / 50 KB; larger " +
    "output is saved to a file you can page through with read.",
  promptGuidelines: [
    "bash covers search and inspection: grep -rn, find, ls, cat, head. There are no separate search tools.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout_seconds: {
        type: "number",
        description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S})`,
      },
    },
    required: ["command"],
  },
  coerce: (input) => normalizeAliases(input, { command: ["cmd", "script"] }),
  async execute(input, ctx) {
    const timeoutS = Number(input.timeout_seconds ?? DEFAULT_TIMEOUT_S);
    const proc = Bun.spawn(["bash", "-c", String(input.command)], {
      cwd: ctx.cwd,
      env: process.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutS * 1000);
    // Spill, don't truncate (DESIGN.md context engine #4, pi accumulator
    // shape): each stream spills to disk the moment it exceeds the limit;
    // memory holds only a rolling tail. stderr gets its own accumulator so
    // a flooding stream cannot evict the other's content.
    const outAcc = new OutputAccumulator(ctx.spillDir, "bash");
    const errAcc = new OutputAccumulator(ctx.spillDir, "bash-err");
    await Promise.all([
      drainStream(proc.stdout, outAcc),
      drainStream(proc.stderr, errAcc),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(killer);

    const out = outAcc.finalize();
    const err = errAcc.finalize();
    let combined = render(out);
    const errText = render(err);
    if (errText.trim() !== "") combined += (combined !== "" ? "\n" : "") + errText;

    let output: string;
    if (out.spilled || err.spilled) {
      output = combined;
    } else {
      const r = truncateTail(combined);
      output = r.truncated ? `${r.notice}\n${r.text}` : r.text;
    }
    if (timedOut) {
      output += `\n[Command timed out after ${timeoutS}s and was killed.]`;
      return { output, isError: true };
    }
    if (exitCode !== 0) {
      output += `\n[Exit code: ${exitCode}]`;
      return { output, isError: true };
    }
    if (output.trim() === "") output = "(no output)";
    return { output };
  },
};
