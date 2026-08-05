// Key resolution shared by the main CLI and `dsc serve`:
// $DEEPSEEK_API_KEY, else ~/.dsc/key.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveApiKey(): string | null {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const keyFile = join(homedir(), ".dsc", "key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  return null;
}
