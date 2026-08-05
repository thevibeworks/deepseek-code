#!/usr/bin/env bun
// runs.jsonl -> markdown matrix. Success rate and cost-given-success are
// separate columns — never averaged together (EVAL.md honesty rules).
import { join } from "node:path";

const RUNS_FILE = join(import.meta.dir, "runs.jsonl");
const text = await Bun.file(RUNS_FILE).text();
const rows = text
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const fmt = (x: number | null, digits = 1) => (x == null ? "—" : x.toFixed(digits));

const cells = new Map<string, any[]>();
for (const r of rows) {
  const key = `${r.task}|${r.adapter}|${r.model}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key)!.push(r);
}

console.log("| task | adapter | model | n | success | wall s (med) | turns | tokens/solve (med) | cache% | $/solve (med) | variance |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, rs] of [...cells.entries()].sort()) {
  const [task, adapter, model] = key.split("|");
  const ok = rs.filter((r) => r.success);
  const tokensOf = (r: any) =>
    r.tokens ? r.tokens.input_fresh + r.tokens.cache_read + r.tokens.output : null;
  const costs = ok.map((r) => r.cost_usd).filter((x: any) => x != null);
  // spread flag: max/min cost among successes > 1.3 -> raise N before concluding
  const variance =
    costs.length >= 2 && Math.min(...costs) > 0
      ? Math.max(...costs) / Math.min(...costs) > 1.3
        ? "HIGH"
        : "ok"
      : "—";
  console.log(
    `| ${task} | ${adapter} | ${model} | ${rs.length} ` +
      `| ${ok.length}/${rs.length} ` +
      `| ${fmt(median(ok.map((r) => r.wall_ms / 1000)))} ` +
      `| ${fmt(median(ok.map((r) => r.turns).filter((x: any) => x != null)), 0)} ` +
      `| ${fmt(median(ok.map(tokensOf).filter((x: any) => x != null)), 0)} ` +
      `| ${fmt(median(ok.map((r) => r.cache_hit_pct).filter((x: any) => x != null)), 0)} ` +
      `| ${fmt(median(costs), 4)} ` +
      `| ${variance} |`,
  );
}
