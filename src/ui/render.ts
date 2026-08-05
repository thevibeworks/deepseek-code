// Interactive rendering: projects the agent event stream onto a terminal.
//
// Line-based on purpose. A full-screen differential renderer (DESIGN.md
// named pi-tui) buys redraw fidelity and costs a dependency plus a second
// rendering model; the capability M5 was missing is a conversation, not a
// canvas. Everything here is a pure projection of engine/events.ts, so
// `-p` still runs with no renderer attached at all.
//
// ASCII only, and colour only when the stream is a TTY and NO_COLOR is
// unset — piped output must stay diffable.

import type { AgentEvent } from "../engine/events";
import type { Usage } from "../provider/types";
import { MODELS } from "../provider/catalog";

export type Style = (s: string) => string;

export type Palette = {
  dim: Style;
  bold: Style;
  red: Style;
  cyan: Style;
};

const identity: Style = (s) => s;

export function makePalette(color: boolean): Palette {
  if (!color) return { dim: identity, bold: identity, red: identity, cyan: identity };
  const wrap = (code: string): Style => (s) => `\x1b[${code}m${s}\x1b[0m`;
  return { dim: wrap("2"), bold: wrap("1"), red: wrap("31"), cyan: wrap("36") };
}

export function colorEnabled(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true && process.env.NO_COLOR === undefined;
}

/** First line of `s`, clipped to `n` columns, with whitespace collapsed —
 * a tool summary must never wrap or the transcript stops being scannable. */
export function oneLine(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length <= n ? line : line.slice(0, n - 3) + "...";
}

/** What a tool call is about, in one line. Falls back to the raw JSON for
 * tools this renderer does not know — an unknown tool must still show. */
export function callSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "bash":
      return oneLine(String(i.command ?? ""), 96);
    case "read": {
      const range =
        i.offset !== undefined || i.limit !== undefined
          ? ` (from line ${i.offset ?? 1}${i.limit !== undefined ? `, ${i.limit} lines` : ""})`
          : "";
      return oneLine(String(i.path ?? ""), 80) + range;
    }
    case "edit":
    case "write":
      return oneLine(String(i.path ?? ""), 80);
    case "task": {
      const action = String(i.action ?? "");
      if (action === "spawn") return `spawn ${i.role ?? "?"}: ${oneLine(String(i.prompt ?? ""), 60)}`;
      return oneLine(`${action} ${i.id ?? ""}`, 80);
    }
    default:
      return oneLine(JSON.stringify(i), 96);
  }
}

/** What came back, in one line. Errors show their actual text: "error" on
 * its own tells the user nothing they can act on. */
export function resultSummary(output: string, isError: boolean): string {
  if (isError) return oneLine(output, 96);
  const lines = output.split("\n");
  if (lines.length === 1) return oneLine(output, 96);
  const bytes = output.length;
  return `${lines.length} lines, ${formatBytes(bytes)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Cost in USD from the catalog's per-1M rates. The catalog is the single
 * pricing source; eval recomputes independently on purpose. */
export function costUsd(usage: Usage, model: string): number {
  const p = MODELS[model]?.pricing;
  if (p === undefined) return 0;
  return (
    (usage.inputFresh * p.inputMiss + usage.cacheRead * p.inputHit + usage.output * p.output) /
    1_000_000
  );
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** One-line turn footer: what it took. Cache hit rate is shown because it
 * is the number that actually moves cost on this provider (50x between a
 * hit and a miss), not as trivia. */
export function statsLine(usage: Usage, model: string, wallMs: number, turns: number): string {
  const input = usage.inputFresh + usage.cacheRead;
  const hitPct = input > 0 ? Math.round((usage.cacheRead / input) * 100) : 0;
  return [
    `${turns} turn${turns === 1 ? "" : "s"}`,
    `${(wallMs / 1000).toFixed(1)}s`,
    `${formatCount(input)} in (${hitPct}% cached)`,
    `${formatCount(usage.output)} out`,
    formatCost(costUsd(usage, model)),
  ].join("  ");
}

export type RendererOptions = {
  write: (s: string) => void;
  palette: Palette;
  /** Stream reasoning tokens. Off by default: v4 reasoning is long enough
   * to bury the answer, and it is not the work product. */
  thinking: boolean;
  /** Live elapsed-time ticker while a turn produces nothing yet. */
  ticker: boolean;
};

/** Stateful projection of one run's events onto the terminal. One instance
 * per run; `finish()` closes any open line. */
export class Renderer {
  private atLineStart = true;
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private tickerShown = false;
  private turnStartedAt = 0;
  private inThinking = false;

  constructor(private readonly opts: RendererOptions) {}

  private out(s: string): void {
    if (s === "") return;
    this.clearTicker();
    this.opts.write(s);
    this.atLineStart = s.endsWith("\n");
  }

  /** Close the current line if one is open, so the next block starts clean. */
  private newline(): void {
    if (!this.atLineStart) this.out("\n");
  }

  private startTicker(): void {
    if (!this.opts.ticker || this.tickerTimer !== null) return;
    this.turnStartedAt = Date.now();
    this.tickerTimer = setInterval(() => {
      const s = Math.round((Date.now() - this.turnStartedAt) / 1000);
      if (s < 1) return;
      this.opts.write(`\r\x1b[2K${this.opts.palette.dim(`  ... ${s}s`)}`);
      this.tickerShown = true;
    }, 1000);
  }

  private clearTicker(): void {
    if (this.tickerTimer !== null) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    if (this.tickerShown) {
      this.opts.write("\r\x1b[2K");
      this.tickerShown = false;
      this.atLineStart = true;
    }
  }

  handle(e: AgentEvent): void {
    const { dim, red, cyan } = this.opts.palette;
    switch (e.type) {
      case "turn_start":
        this.startTicker();
        return;
      case "thinking_delta":
        if (!this.opts.thinking) return;
        if (!this.inThinking) {
          this.newline();
          this.inThinking = true;
        }
        this.out(dim(e.text));
        return;
      case "text_delta":
        if (this.inThinking) {
          this.newline();
          this.inThinking = false;
        }
        this.out(e.text);
        return;
      case "tool_execution_start":
        this.inThinking = false;
        this.newline();
        this.out(`  ${cyan(e.name)}  ${dim(callSummary(e.name, e.input))}\n`);
        return;
      case "tool_execution_end": {
        const summary = resultSummary(e.output, e.isError);
        this.out(`  ${dim("->")} ${e.isError ? red(summary) : dim(summary)}\n`);
        return;
      }
      case "compaction":
        this.newline();
        this.out(
          dim(
            `  [compacted ${formatCount(e.contextTokensBefore)} -> ${formatCount(e.contextTokensAfter)} tokens, ${e.llm ? "llm" : "emergency"} summary]\n`,
          ),
        );
        return;
      case "turn_end":
        this.startTicker();
        return;
      default:
        return;
    }
  }

  finish(): void {
    this.clearTicker();
    this.newline();
    this.inThinking = false;
  }
}
