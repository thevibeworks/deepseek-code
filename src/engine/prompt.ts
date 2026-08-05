// System prompt assembly. Byte-stability rules (pi-mono pattern):
// deterministic assembly, nothing time-varying (no date, no clock), the
// working directory is the ONLY per-session dynamic value and it goes
// LAST. The whole prompt is deliberately small — the stable prefix is
// the product (DESIGN.md pillar 4).

import type { ToolDefinition } from "../tools/index";
import type { WireTool } from "../provider/types";

const IDENTITY =
  "You are dsc, a coding agent operating non-interactively inside a " +
  "workspace directory. Work directly toward the user's task: " +
  "investigate, act, verify. There is no user available to answer " +
  "questions mid-run, so make reasonable assumptions and proceed.";

// Tool-specific guidelines live on the ToolDefinition (Round 4 delta #3)
// and are collected in registration order ahead of these generic lines.
const GENERIC_GUIDELINES = [
  "Fix bugs at the root cause: correct the faulty code itself, never add compensating code that masks it. If a regex or condition is wrong, fix that regex or condition rather than patching its output afterwards. Keep changes minimal and scoped to the task; do not refactor beyond it.",
  "Never modify files the task tells you not to touch.",
  "Verify your work by running the relevant command (tests, build, the script the task names) before finishing.",
  "Your final text message is the deliverable. Keep it brief. If the task asks a question, end with exactly the answer requested.",
];

export function buildSystemPrompt(tools: ToolDefinition[], cwd: string): string {
  const toolLines = tools.map(
    (t) => `- ${t.name}: ${t.promptSnippet ?? firstSentence(t.description)}`,
  );
  const guidelines = [
    ...tools.flatMap((t) => t.promptGuidelines ?? []),
    ...GENERIC_GUIDELINES,
  ];
  return [
    IDENTITY,
    "",
    "Available tools:",
    ...toolLines,
    "",
    "Guidelines:",
    ...guidelines.map((g) => `- ${g}`),
    "",
    `Current working directory: ${cwd}`,
  ].join("\n");
}

export function toWireTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function firstSentence(s: string): string {
  const i = s.indexOf(". ");
  return i >= 0 ? s.slice(0, i + 1) : s;
}
