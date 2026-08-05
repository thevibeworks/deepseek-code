import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editTool } from "../src/tools/edit";

function withFile(content: string, fn: (dir: string, path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsc-edit-test-"));
  const path = join(dir, "f.txt");
  writeFileSync(path, content);
  return fn(dir, path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function run(dir: string, input: Record<string, unknown>) {
  const coerced = editTool.coerce ? editTool.coerce(input) : input;
  return editTool.execute(coerced, { cwd: dir });
}

describe("edit tool", () => {
  test("exact single edit", () =>
    withFile("const a = 1;\nconst b = 2;\n", async (dir, path) => {
      const r = await run(dir, {
        path,
        edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
      });
      expect(r.isError).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
    }));

  test("ambiguous match is a pedagogical error", () =>
    withFile("x\nx\n", async (dir, path) => {
      const r = await run(dir, { path, edits: [{ oldText: "x", newText: "y" }] });
      expect(r.isError).toBe(true);
      expect(r.output).toContain("matches 2 locations");
    }));

  test("fuzzy match survives trailing whitespace and smart quotes", () =>
    withFile("if (a) {  \n  say(‘hi’);\n}\n", async (dir, path) => {
      const r = await run(dir, {
        path,
        edits: [{ oldText: "if (a) {\n  say('hi');\n}", newText: "say('hi');" }],
      });
      expect(r.isError).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("say('hi');\n");
    }));

  test("legacy single-edit shape heals", () =>
    withFile("hello world\n", async (dir, path) => {
      const r = await run(dir, {
        file_path: path,
        old_string: "hello",
        new_string: "goodbye",
      });
      expect(r.isError).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("goodbye world\n");
    }));

  test("multiple edits apply against original content", () =>
    withFile("one\ntwo\nthree\n", async (dir, path) => {
      const r = await run(dir, {
        path,
        edits: [
          { oldText: "one", newText: "1" },
          { oldText: "three", newText: "3" },
        ],
      });
      expect(r.isError).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("1\ntwo\n3\n");
    }));

  test("not-found reports how to fix", () =>
    withFile("abc\n", async (dir, path) => {
      const r = await run(dir, { path, edits: [{ oldText: "zzz", newText: "y" }] });
      expect(r.isError).toBe(true);
      expect(r.output).toContain("not found");
    }));

  test("CRLF file round-trips", () =>
    withFile("a\r\nb\r\n", async (dir, path) => {
      const r = await run(dir, { path, edits: [{ oldText: "b", newText: "c" }] });
      expect(r.isError).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("a\r\nc\r\n");
    }));
});
