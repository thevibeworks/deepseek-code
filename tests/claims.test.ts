// Published claims about models and prices, asserted against the code
// they describe, so a stale README or eval card turns CI red in the run
// that caused the drift. Every occurrence is collected and checked, not
// just the first: a fresh first copy must not hide a stale second one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARDS, CURRENT_MODELS, DEFAULT_MODEL, MODELS } from "../src/provider/catalog";
import { ROLES } from "../src/engine/subagent";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const README = read("README.md");
const newest = CARDS[CARDS.length - 1];

function all(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

describe("default model claims", () => {
  test("every 'default' model named in the README is DEFAULT_MODEL", () => {
    const named = [
      ...all(README, /`(deepseek-[\w.-]+)` \(default\)/g),
      ...all(README, /\(default (deepseek-[\w.-]+)\)/g),
    ];
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const m of named) expect(m).toBe(DEFAULT_MODEL);
  });

  test("every eval command in the docs, and the runner's own default, uses DEFAULT_MODEL", () => {
    const named = [
      ...all(README, /--models (\S+)/g),
      ...all(read("EVAL.md"), /--models (\S+)/g),
      ...all(read("eval/run.ts"), /--models (\S+)/g),
      ...all(read("eval/run.ts"), /arg\("models", "([^"]+)"\)/g),
    ];
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const m of named) expect(m).toBe(DEFAULT_MODEL);
  });

  test("the --model line in the README offers exactly the current models", () => {
    const line = all(README, /^--model (\S+)/gm);
    expect(line).toEqual([CURRENT_MODELS.join("|")]);
  });

  test("no built-in sub-agent role runs on a retired name", () => {
    for (const role of Object.values(ROLES)) {
      expect(MODELS[role.model]).toBeDefined();
      expect(MODELS[role.model].retired).toBeUndefined();
    }
  });
});

describe("price claims", () => {
  test("the README models table matches the newest card, row for row", () => {
    const rows = [...README.matchAll(/^\| `(deepseek-[\w.-]+)`[^|]*\|[^|]*\| ([\d.]+) \/ ([\d.]+) \/ ([\d.]+) \|$/gm)];
    expect(rows.map((r) => r[1])).toEqual(CURRENT_MODELS);
    for (const [, model, hit, miss, out] of rows) {
      const r = newest.rates[MODELS[model].tier];
      expect([Number(hit), Number(miss), Number(out)]).toEqual([r.inputHit, r.inputMiss, r.output]);
    }
  });

  test("eval/pricing.json carries the same dated cards as the catalog", () => {
    const evalPricing = JSON.parse(read("eval/pricing.json"));
    expect(evalPricing.cards.map((c: { since: string }) => Date.parse(c.since))).toEqual(
      CARDS.map((c) => c.since.getTime()),
    );
    evalPricing.cards.forEach((c: any, i: number) => {
      for (const tier of ["flash", "pro"] as const) {
        const r = CARDS[i].rates[tier];
        expect(c.rates[tier]).toEqual({ input_hit: r.inputHit, input_miss: r.inputMiss, output: r.output });
      }
    });
    for (const [model, info] of Object.entries(MODELS)) expect(evalPricing.tiers[model]).toBe(info.tier);
  });
});
