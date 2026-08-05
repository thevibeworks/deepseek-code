// Killing a bash command must actually free the caller, not just kill the
// shell. Both cases below hung for the grandchild's FULL runtime before
// the command was spawned into its own process group.

import { describe, expect, test } from "bun:test";
import { bashTool } from "../src/tools/bash";

const ctx = { cwd: process.cwd() };

describe("bash cancellation", () => {
  test("timeout kills the whole tree, not just the shell", async () => {
    const t0 = Date.now();
    const r = await bashTool.execute(
      // The grandchild outlives `bash` and holds the stdout pipe. Killing
      // only bash leaves the drain blocked until `sleep` exits on its own.
      { command: "sleep 20 && echo done", timeout_seconds: 1 },
      ctx,
    );
    const elapsed = Date.now() - t0;
    expect(r.isError).toBe(true);
    expect(r.output).toContain("timed out");
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  test("abort signal kills the whole tree", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await bashTool.execute(
      { command: "sleep 20 && echo done" },
      { ...ctx, signal: ac.signal },
    );
    const elapsed = Date.now() - t0;
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Interrupted");
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  test("an already-aborted signal never starts real work", async () => {
    const r = await bashTool.execute(
      { command: "sleep 20" },
      { ...ctx, signal: AbortSignal.abort() },
    );
    expect(r.isError).toBe(true);
  }, 30_000);

  test("normal commands are unaffected", async () => {
    const r = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output.trim()).toBe("hello");
  });
});
