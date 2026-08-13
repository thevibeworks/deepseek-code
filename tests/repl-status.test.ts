// Regression: /status crashed the whole REPL with a TypeError because it
// read `this.opts.tools`, a field ReplOptions never had (the real field
// is makeTools). No typecheck runs in this repo, so the only guard is a
// test that actually executes the command path.

import { afterEach, describe, expect, test } from "bun:test";
import { SubagentManager } from "../src/engine/subagent";
import { Session } from "../src/session/session";
import { SessionStore } from "../src/session/store";
import { bashTool } from "../src/tools/bash";
import { readTool } from "../src/tools/read";
import { Repl } from "../src/ui/repl";

function makeRepl(): { repl: Repl; output: () => string; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const chunks: string[] = [];
  const repl = new Repl({
    store,
    session: Session.create(store, "deepseek-v4-flash", "/work"),
    makeManager: () => new SubagentManager({ apiKey: "k", baseUrl: "http://x", cwd: "/work" }),
    makeTools: () => [readTool, bashTool],
    skills: [{ name: "release-notes", description: "Draft release notes." }],
    model: "deepseek-v4-flash",
    cwd: "/work",
    apiKey: "k",
    baseUrl: "http://x",
    maxTurns: 10,
    contextBudget: 100_000,
    thinking: false,
  });
  // The Repl writes straight to process.stdout; capture it.
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  };
  restore = () => {
    (process.stdout as any).write = original;
    store.close();
  };
  return { repl, output: () => chunks.join(""), store };
}

let restore: () => void = () => {};
afterEach(() => restore());

describe("/status", () => {
  test("renders without throwing and lists the tool names", async () => {
    const { repl, output } = makeRepl();
    const leave = await (repl as any).command("/status");
    expect(leave).toBe(false);
    const out = output();
    expect(out).toContain("read, bash");
    expect(out).toContain("deepseek-v4-flash");
    expect(out).toContain("context");
    expect(out).toContain("release-notes");
  });
});
