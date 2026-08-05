// Adapter: dsc (deepseek-code milestone 1) headless mode.
import { join, resolve } from "node:path";
import type { Adapter, AdapterResult } from "../run";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

const adapter: Adapter = {
  name: "dsc",
  async run({ prompt, model, workdir, timeoutMs, env }): Promise<AdapterResult> {
    const t0 = Date.now();
    const proc = Bun.spawn(
      ["bun", CLI, "-p", prompt, "--model", model, "--output-format", "json"],
      {
        cwd: workdir,
        env: { ...(process.env as Record<string, string>), ...(env ?? {}) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(killer);
    const wallMs = Date.now() - t0;

    let j: any = null;
    try {
      j = JSON.parse(stdout);
    } catch {
      // non-JSON output (crash) — keep raw tails for diagnosis
    }
    return {
      exitCode,
      timedOut,
      wallMs,
      apiMs: j?.duration_api_ms ?? null,
      turns: j?.num_turns ?? null,
      resultText: typeof j?.result === "string" ? j.result : stdout,
      usage: j?.usage
        ? {
            inputFresh: j.usage.input_tokens ?? 0,
            cacheRead: j.usage.cache_read_input_tokens ?? 0,
            output: j.usage.output_tokens ?? 0,
          }
        : null,
      raw: j ?? { stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000) },
    };
  },
};

export default adapter;
