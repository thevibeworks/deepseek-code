// /seek's planner. The guard rail is the point: fan-out on shallow work
// measured 2.49x wall-clock and 6.75x cost, so every ambiguous or
// malformed plan must fall back to answering inline. Failing OPEN here
// (fanning out when unsure) is the expensive direction.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, MIN_PIECES, toPlan, workspaceOutline } from "../src/ui/seek";
import { MAX_CHILDREN } from "../src/engine/subagent";

const piece = (n: number) => ({ label: `piece ${n}`, prompt: `investigate thing number ${n}` });

describe("extractJson", () => {
  test("plain JSON", () => {
    expect(extractJson('{"decomposable": false}')).toEqual({ decomposable: false });
  });

  test("fenced JSON, with and without a language tag", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  test("JSON buried in prose", () => {
    expect(extractJson('Sure! Here is the plan:\n{"a": 3}\nHope that helps.')).toEqual({ a: 3 });
  });

  test("nested braces survive", () => {
    expect(extractJson('{"pieces": [{"label": "x"}]}')).toEqual({ pieces: [{ label: "x" }] });
  });

  test("no JSON at all", () => {
    expect(extractJson("I think we should split this into four parts.")).toBeNull();
    expect(extractJson("")).toBeNull();
    expect(extractJson("{not valid json")).toBeNull();
  });
});

describe("toPlan", () => {
  test("an explicit refusal keeps its reason", () => {
    expect(toPlan({ decomposable: false, reason: "single file lookup" })).toEqual({
      decomposable: false,
      reason: "single file lookup",
    });
  });

  test("a valid split passes through", () => {
    const plan = toPlan({ decomposable: true, pieces: [piece(1), piece(2), piece(3)] });
    expect(plan.decomposable).toBe(true);
    if (plan.decomposable) expect(plan.pieces).toHaveLength(3);
  });

  test("one piece is not a split", () => {
    const plan = toPlan({ decomposable: true, pieces: [piece(1)] });
    expect(plan.decomposable).toBe(false);
  });

  test("pieces are capped at MAX_CHILDREN", () => {
    const many = Array.from({ length: MAX_CHILDREN + 5 }, (_, i) => piece(i));
    const plan = toPlan({ decomposable: true, pieces: many });
    expect(plan.decomposable).toBe(true);
    if (plan.decomposable) expect(plan.pieces).toHaveLength(MAX_CHILDREN);
  });

  test("pieces without a usable prompt are dropped, not fanned out", () => {
    const plan = toPlan({
      decomposable: true,
      pieces: [piece(1), { label: "empty", prompt: "   " }, { label: "no prompt" }],
    });
    // One survivor is below MIN_PIECES, so this must not fan out.
    expect(plan.decomposable).toBe(false);
  });

  test("a missing label falls back to the prompt", () => {
    const plan = toPlan({
      decomposable: true,
      pieces: [{ prompt: "trace the config loader" }, { prompt: "trace the env overrides" }],
    });
    expect(plan.decomposable).toBe(true);
    if (plan.decomposable) expect(plan.pieces[0].label).toContain("trace the config");
  });

  test("garbage fails CLOSED", () => {
    for (const bad of [null, undefined, "nope", 42, [], {}, { decomposable: true }, { decomposable: true, pieces: "x" }]) {
      expect(toPlan(bad).decomposable).toBe(false);
    }
  });

  test("decomposable must be exactly true, not merely truthy", () => {
    expect(toPlan({ decomposable: "yes", pieces: [piece(1), piece(2)] }).decomposable).toBe(false);
    expect(toPlan({ decomposable: 1, pieces: [piece(1), piece(2)] }).decomposable).toBe(false);
  });

  test("MIN_PIECES is the documented floor", () => {
    expect(MIN_PIECES).toBe(2);
    const exact = Array.from({ length: MIN_PIECES }, (_, i) => piece(i));
    expect(toPlan({ decomposable: true, pieces: exact }).decomposable).toBe(true);
  });
});

describe("workspaceOutline", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsc-outline-"));
  mkdirSync(join(dir, "services", "auth"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "hi");
  writeFileSync(join(dir, "services", "auth", "policy.js"), "x");
  writeFileSync(join(dir, "node_modules", "junk", "index.js"), "x");
  writeFileSync(join(dir, ".git", "config"), "x");

  test("lists real files with paths relative to cwd", () => {
    const out = workspaceOutline(dir);
    expect(out).toContain("README.md");
    expect(out).toContain("services/auth/policy.js");
  });

  test("skips dependency and VCS directories", () => {
    const out = workspaceOutline(dir);
    // The planner's whole job is naming real source paths; node_modules
    // would bury them and blow the prompt.
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");
  });

  test("respects the entry cap", () => {
    const big = mkdtempSync(join(tmpdir(), "dsc-outline-big-"));
    for (let i = 0; i < 50; i++) writeFileSync(join(big, `f${i}.txt`), "x");
    const out = workspaceOutline(big, 3, 10);
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
    rmSync(big, { recursive: true, force: true });
  });

  test("an unreadable or empty directory is reported, not thrown", () => {
    const empty = mkdtempSync(join(tmpdir(), "dsc-outline-empty-"));
    expect(workspaceOutline(empty)).toContain("empty");
    rmSync(empty, { recursive: true, force: true });
    expect(() => workspaceOutline("/nonexistent-path-xyz")).not.toThrow();
  });
});
