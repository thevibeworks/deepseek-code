// Interactive mode — the M5 frontend. `dsc` with no -p lands here.
//
// What this adds is a CONVERSATION. It is explicitly NOT a token-cost
// win: the provider's prefix cache is server-side and cross-process
// (measured — a second process sending identical bytes read 3840/3945
// tokens from cache), so `-p --resume` already reuses the same prefix.
// The gains are latency (no process start, no view rebuilt from SQLite
// per prompt) and control (interrupts, slash commands, live rendering).
//
// Sessions are ON by default here (DESIGN.md M5). An interactive session
// you cannot resume is one you lose to a closed terminal, and the storage
// cost is a few KB.
//
// Input handling is the fiddly part, and both obvious approaches are
// wrong. Measured on this Bun/readline:
//   - rl.pause() during a turn: Ctrl-C reaches NOBODY. Raw mode means no
//     OS SIGINT, and a paused readline never decodes the 0x03 byte, so the
//     turn becomes uninterruptible.
//   - readline left active during a turn: keystrokes echo into the middle
//     of streaming output AND survive into the next prompt — typing while
//     the agent works silently prepends garbage to your next message.
// So the interface is closed for the duration of each turn and stdin is
// owned directly (raw mode, 0x03 watched, everything else discarded).
// History is carried across interfaces by hand.

import { createInterface, type Interface } from "node:readline";
import { addUsage, zeroUsage, type Usage } from "../provider/types";
import { compactThreshold } from "../engine/compact";
import { MODELS } from "../provider/catalog";
import type { SubagentManager } from "../engine/subagent";
import type { ToolDefinition } from "../tools/index";
import { Session } from "../session/session";
import type { SessionStore } from "../session/store";
import {
  colorEnabled,
  costUsd,
  formatCost,
  formatCount,
  makePalette,
  Renderer,
  statsLine,
  type Palette,
} from "./render";

export type ReplOptions = {
  store: SessionStore;
  session: Session;
  manager: SubagentManager;
  tools: ToolDefinition[];
  model: string;
  cwd: string;
  apiKey: string;
  baseUrl: string;
  maxTurns: number;
  contextBudget: number;
  /** Stream reasoning tokens. */
  thinking: boolean;
};

const COMMANDS: [string, string][] = [
  ["/help", "show this list"],
  ["/status", "model, session, context use, cost"],
  ["/cost", "usage and cost so far"],
  ["/model [name]", "show or switch model"],
  ["/compact", "summarize the context now"],
  ["/clear", "start a fresh session, same terminal"],
  ["/sessions", "recent sessions in this directory"],
  ["/resume <id>", "continue a previous session"],
  ["/thinking", "toggle streaming of reasoning"],
  ["/exit", "leave (or Ctrl-D)"],
];

export class Repl {
  private readonly tty = process.stdin.isTTY === true;
  private readonly palette: Palette;
  private readonly history: string[] = [];
  private session: Session;
  private model: string;
  private thinking: boolean;
  private usage: Usage = zeroUsage();
  private idleInterrupts = 0;
  /** Remaining lines of piped stdin; null until first read. */
  private piped: string[] | null = null;

  constructor(private readonly opts: ReplOptions) {
    this.palette = makePalette(colorEnabled(process.stdout));
    this.session = opts.session;
    this.model = opts.model;
    this.thinking = opts.thinking;
  }

  private write(s: string): void {
    process.stdout.write(s);
  }

  async run(): Promise<number> {
    const { dim, bold, cyan } = this.palette;
    this.write(
      `${bold("dsc")}  ${cyan(this.model)}  ${dim(this.opts.cwd)}\n` +
        dim(`session ${this.session.meta.id}   /help for commands, ^C interrupt, ^D exit\n\n`),
    );

    for (;;) {
      const line = await this.ask();
      if (line === null) break;
      const text = line.trim();
      if (text === "") continue;
      this.history.unshift(line);
      if (text.startsWith("/")) {
        if (await this.command(text)) break;
        continue;
      }
      await this.turn(line);
    }

    this.write(dim(`\nsession ${this.session.meta.id}   ${this.totalsLine()}\n`));
    return 0;
  }

  /** Read one line. Null means "leave": end of input, or a second
   * consecutive Ctrl-C at an idle prompt. */
  private async ask(): Promise<string | null> {
    if (!this.tty) return this.askPiped();
    return this.askTty();
  }

  /** Piped stdin (`printf '...' | dsc`) is read once, up front. Creating a
   * readline interface per line works on a TTY but silently eats a pipe:
   * the first interface buffers the whole stream and the rest is lost when
   * it closes, so only the first line ever runs. */
  private async askPiped(): Promise<string | null> {
    if (this.piped === null) {
      const text = await Bun.stdin.text();
      this.piped = text.split("\n");
      if (this.piped.at(-1) === "") this.piped.pop();
    }
    const next = this.piped.shift();
    if (next === undefined) return null;
    this.write(`${this.palette.bold("> ")}${next}\n`);
    return next;
  }

  /** The interface is created per line and closed before returning, so
   * none of readline's listeners are attached to stdin while a turn runs. */
  private askTty(): Promise<string | null> {
    return new Promise((resolve) => {
      const iface: Interface = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: this.tty,
        history: [...this.history],
        historySize: 200,
      } as never);
      let done = false;
      const settle = (v: string | null): void => {
        if (done) return;
        done = true;
        iface.close();
        resolve(v);
      };
      iface.once("close", () => settle(null));
      iface.on("SIGINT", () => {
        this.idleInterrupts++;
        if (this.idleInterrupts >= 2) {
          this.write("\n");
          settle(null);
          return;
        }
        this.write(`\n${this.palette.dim("(^C again to exit)")}\n`);
        iface.write(null, { ctrl: true, name: "u" });
        iface.prompt();
      });
      iface.question(this.palette.bold("> "), (answer) => {
        this.idleInterrupts = 0;
        settle(answer);
      });
    });
  }

  /** Own stdin for the duration of a turn: watch for Ctrl-C, discard every
   * other keystroke so type-ahead cannot leak into the next prompt. */
  private watchInterrupt(onInterrupt: () => void): () => void {
    if (!this.tty) return () => {};
    const stdin = process.stdin;
    const onData = (b: Buffer): void => {
      if (b.includes(0x03)) onInterrupt();
    };
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    return () => {
      stdin.off("data", onData);
      stdin.pause();
      stdin.setRawMode(false);
    };
  }

  private async turn(prompt: string): Promise<void> {
    const { dim, red } = this.palette;
    const ac = new AbortController();
    let interrupted = false;
    const stopWatch = this.watchInterrupt(() => {
      if (interrupted) return;
      interrupted = true;
      this.write(dim("\n  (interrupting...)\n"));
      ac.abort();
    });
    const renderer = new Renderer({
      write: (s) => this.write(s),
      palette: this.palette,
      thinking: this.thinking,
      ticker: this.tty,
    });
    const childrenBefore = this.opts.manager.totalUsage();
    const t0 = Date.now();

    try {
      const result = await this.session.run(prompt, {
        model: this.model,
        cwd: this.opts.cwd,
        apiKey: this.opts.apiKey,
        baseUrl: this.opts.baseUrl,
        tools: this.opts.tools,
        maxTurns: this.opts.maxTurns,
        contextBudget: this.opts.contextBudget,
        signal: ac.signal,
        onEvent: (e) => renderer.handle(e),
      });
      renderer.finish();

      // Children never outlive the run that spawned them; their usage is
      // still counted, or the cost line understates what the turn cost.
      this.opts.manager.cancelAll();
      await this.opts.manager.wait();
      const childDelta = subUsage(this.opts.manager.totalUsage(), childrenBefore);
      const turnUsage = addUsage(result.usage, childDelta);
      this.usage = addUsage(this.usage, turnUsage);

      if (result.endReason === "aborted") {
        this.write(dim("  interrupted\n"));
      } else if (result.endReason === "error") {
        this.write(`  ${red(`error: ${result.errorMessage ?? "unknown"}`)}\n`);
      } else if (result.endReason === "max_turns") {
        this.write(dim(`  stopped at the ${this.opts.maxTurns}-turn limit\n`));
      }
      this.write(dim(`  ${statsLine(turnUsage, this.model, Date.now() - t0, result.turns)}\n\n`));
    } finally {
      stopWatch();
    }
  }

  private totalsLine(): string {
    const input = this.usage.inputFresh + this.usage.cacheRead;
    return `${formatCount(input)} in  ${formatCount(this.usage.output)} out  ${formatCost(
      costUsd(this.usage, this.model),
    )}`;
  }

  /** Returns true when the command means "leave". */
  private async command(text: string): Promise<boolean> {
    const { dim, bold, red, cyan } = this.palette;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "/exit":
      case "/quit":
        return true;

      case "/help":
        for (const [name, desc] of COMMANDS) {
          this.write(`  ${bold(name.padEnd(15))} ${dim(desc)}\n`);
        }
        this.write("\n");
        return false;

      case "/status": {
        const used = this.session.contextTokens();
        const threshold = compactThreshold(this.opts.contextBudget);
        const pct = Math.round((used / threshold) * 100);
        const { turns } = this.session.totals();
        this.write(
          `  ${dim("model   ")} ${cyan(this.model)}\n` +
            `  ${dim("cwd     ")} ${this.opts.cwd}\n` +
            `  ${dim("session ")} ${this.session.meta.id}\n` +
            `  ${dim("context ")} ${formatCount(used)} / ${formatCount(threshold)} tokens (${pct}%)\n` +
            `  ${dim("turns   ")} ${turns}\n` +
            `  ${dim("cost    ")} ${this.totalsLine()}\n` +
            `  ${dim("tools   ")} ${this.opts.tools.map((t) => t.name).join(", ")}\n\n`,
        );
        return false;
      }

      case "/cost":
        this.write(`  ${this.totalsLine()}\n\n`);
        return false;

      case "/model": {
        if (arg === "") {
          this.write(`  ${cyan(this.model)}  ${dim(`(known: ${Object.keys(MODELS).join(", ")})`)}\n\n`);
          return false;
        }
        if (MODELS[arg] === undefined) {
          this.write(`  ${red(`unknown model "${arg}"`)} ${dim(`(known: ${Object.keys(MODELS).join(", ")})`)}\n\n`);
          return false;
        }
        this.model = arg;
        this.write(`  model is now ${cyan(arg)}\n\n`);
        return false;
      }

      case "/thinking":
        this.thinking = !this.thinking;
        this.write(dim(`  reasoning ${this.thinking ? "shown" : "hidden"}\n\n`));
        return false;

      case "/compact": {
        const before = this.session.contextTokens();
        if (before === 0) {
          this.write(dim("  nothing to compact\n\n"));
          return false;
        }
        this.write(dim("  compacting...\n"));
        const r = await this.session.compact({
          apiKey: this.opts.apiKey,
          baseUrl: this.opts.baseUrl,
          model: this.model,
        });
        if (r === null) {
          this.write(dim("  nothing to compact\n\n"));
          return false;
        }
        this.write(
          dim(
            `  ${formatCount(r.before)} -> ${formatCount(r.after)} tokens (${r.llm ? "llm" : "emergency"} summary)\n\n`,
          ),
        );
        return false;
      }

      case "/clear": {
        this.session = Session.create(this.opts.store, this.model, this.opts.cwd);
        this.usage = zeroUsage();
        this.write(dim(`  new session ${this.session.meta.id}\n\n`));
        return false;
      }

      case "/sessions": {
        const rows = this.opts.store.list({ cwd: this.opts.cwd, limit: 10 });
        if (rows.length === 0) {
          this.write(dim("  no sessions in this directory\n\n"));
          return false;
        }
        for (const r of rows) {
          const mark = r.id === this.session.meta.id ? "*" : " ";
          this.write(
            `  ${mark} ${bold(r.id)}  ${dim(`${r.createdAt.slice(0, 16).replace("T", " ")}  ${r.model}  ${r.messages} msgs`)}\n`,
          );
        }
        this.write("\n");
        return false;
      }

      case "/resume": {
        if (arg === "") {
          this.write(dim("  usage: /resume <id>   (/sessions to list)\n\n"));
          return false;
        }
        const s = Session.resume(this.opts.store, arg);
        if (s === null) {
          this.write(`  ${red(`no session "${arg}"`)}\n\n`);
          return false;
        }
        this.session = s;
        this.usage = zeroUsage();
        this.write(
          dim(`  resumed ${s.meta.id}  ${formatCount(s.contextTokens())} tokens of context\n\n`),
        );
        return false;
      }

      default:
        this.write(`  ${red(`unknown command "${cmd}"`)} ${dim("(/help)")}\n\n`);
        return false;
    }
  }
}

/** Per-turn child usage: the manager's totals are cumulative for the
 * process, so a turn's share is the delta across it. */
function subUsage(after: Usage, before: Usage): Usage {
  return {
    inputFresh: after.inputFresh - before.inputFresh,
    cacheRead: after.cacheRead - before.cacheRead,
    output: after.output - before.output,
  };
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  return new Repl(opts).run();
}
