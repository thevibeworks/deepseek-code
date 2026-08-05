// Read-only bash classification, ported from the Go sibling's
// classifyBash (deepseek-pi harness/permission.go; see
// docs/research/deepseek-pi-sibling.md). Purpose here: scheduled jobs
// run unattended, and the default job preset is read-only — this is what
// makes that preset mean something for bash. It is accident prevention
// against a model doing the obvious thing, not a sandbox, and the docs
// say so.
//
// The order is the security property:
// 1. Dangerous fragments are checked on the RAW string, before any
//    splitting, so chaining can't hide a redirect or substitution.
// 2. Then split on && || | ; and require EVERY segment to lead with an
//    allowlisted program. Unknown means unsafe.

/** Fragments that can write or execute regardless of the leading word.
 * `>` covers >> too; backtick and $( cover substitution; <( is process
 * substitution; newlines smuggle a second command past the split. */
const DANGEROUS_FRAGMENTS = [">", "`", "$(", "<(", "\n"];

/** Programs that only inspect. Deliberately absent: sed and awk (both
 * write files — sed -i, awk redirection — and auditing their scripts is
 * harder than saying no), xargs and env (both execute a program named in
 * their arguments, which would dodge the head check entirely). */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "find", "fd", "wc", "file",
  "stat", "du", "df", "pwd", "echo", "printf", "date", "which",
  "type", "sort", "uniq", "cut", "tr", "diff", "comm", "basename",
  "dirname", "realpath", "readlink", "tree", "jq", "true",
  "false", "test", "sleep",
]);

/** find flags that write or execute; a find carrying any of these is not
 * read-only no matter how it is spelled. */
const FIND_UNSAFE = /-(exec|execdir|ok|okdir|delete|fprintf?|fls|fprint0)\b/;

/** Read-only subcommands for programs whose verb decides the effect.
 * Absent on purpose: config (two positional args WRITES), branch/tag
 * (bare form lists, but one positional arg CREATES), remote (add/rm),
 * worktree (add), stash (push). Only verbs with no writing form. */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status", "log", "diff", "show", "rev-parse", "rev-list", "blame",
    "grep", "ls-files", "ls-tree", "describe", "shortlog", "cat-file",
  ]),
};

export type BashClass = { safe: true } | { safe: false; reason: string };

/** Classify a bash command as read-only-safe or not. Failing toward
 * "unsafe" costs a refusal the model can read; failing toward "safe"
 * costs an unattended write. */
export function classifyBash(command: string): BashClass {
  const raw = command.trim();
  if (raw === "") return { safe: false, reason: "empty command" };
  for (const frag of DANGEROUS_FRAGMENTS) {
    if (raw.includes(frag)) {
      const shown = frag === "\n" ? "a newline" : `"${frag}"`;
      return { safe: false, reason: `contains ${shown}` };
    }
  }
  for (const segment of splitPipeline(raw)) {
    const s = segment.trim();
    if (s === "") return { safe: false, reason: "empty pipeline segment" };
    if (s.includes("&")) return { safe: false, reason: "backgrounding (&) is not read-only-auditable" };
    const words = s.split(/\s+/);
    const head = words[0];
    if (head.includes("=")) return { safe: false, reason: `inline environment assignment in "${head}"` };
    if (head.includes("/")) return { safe: false, reason: `path-qualified program "${head}"` };
    if (head === "find" && FIND_UNSAFE.test(s)) {
      return { safe: false, reason: "find with an executing/writing flag (-exec/-delete/...)" };
    }
    if (SAFE_COMMANDS.has(head)) continue;
    const subs = SAFE_SUBCOMMANDS[head];
    if (subs !== undefined) {
      const verb = words[1];
      if (verb !== undefined && subs.has(verb)) continue;
      return { safe: false, reason: `"${head} ${verb ?? ""}"`.trim() + " is not in the read-only allowlist" };
    }
    return { safe: false, reason: `"${head}" is not in the read-only allowlist` };
  }
  return { safe: true };
}

/** Split on the shell chain operators: && || | ; — checked in this order
 * so || splits before | . The dangerous-fragment pass already ran on the
 * raw string, so nothing here needs to understand quoting: a quoted
 * operator merely over-splits, and over-splitting can only make the
 * verdict stricter. */
export function splitPipeline(command: string): string[] {
  return command.split(/&&|\|\||\||;/);
}
