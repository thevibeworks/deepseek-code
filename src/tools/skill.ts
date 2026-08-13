// The skill tool: on-demand loading for discovered SKILL.md skills.
// Progressive disclosure (DESIGN.md "Skills"): the system prompt carries
// one index line per skill, the body enters context only when the model
// asks for it — skill bodies never sit in the stable prefix. Built by
// factory because it closes over the discovery result; the schema itself
// is static (no name enum), so the tool's prefix bytes do not change when
// skills are added or removed.

import type { ToolDefinition } from "./index";
import { normalizeAliases } from "./index";
import type { Skill } from "../skills/discover";
import { stripFrontmatter } from "../skills/discover";
import { truncateHead } from "./truncate";

export function makeSkillTool(skills: Skill[]): ToolDefinition {
  return {
    name: "skill",
    description:
      "Load a skill: reusable instructions for a specific kind of task. " +
      "The available skills are indexed in the system prompt; pass a name " +
      "from that index to get the skill's full instructions.",
    promptSnippet: "Load a skill's full instructions by name.",
    promptGuidelines: [
      "When the task matches a skill's description in the Skills index, load that skill first and follow its instructions instead of improvising the workflow it covers.",
    ],
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name, exactly as it appears in the Skills index.",
        },
      },
      required: ["name"],
    },
    coerce: (input) => normalizeAliases(input, { name: ["skill", "skill_name"] }),
    async execute(input) {
      const name = String(input.name);
      const skill = skills.find((s) => s.name === name);
      if (skill === undefined) {
        return {
          output: `Unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(", ")}.`,
          isError: true,
        };
      }
      // Read fresh on every invoke: the file can change between discovery
      // and use, and stale instructions are worse than a re-read.
      const file = Bun.file(skill.path);
      if (!(await file.exists())) {
        return { output: `Skill file no longer exists: ${skill.path}`, isError: true };
      }
      const body = stripFrontmatter(await file.text()).trim();
      if (body === "") {
        return { output: `Skill "${name}" has no instructions beyond its description.` };
      }
      const r = truncateHead(body);
      // The path lets the model read files the skill references relative
      // to its own directory (the resource-base convention).
      return {
        output:
          `Skill "${name}" (from ${skill.path}):\n\n` +
          r.text +
          (r.truncated ? `\n${r.notice}` : ""),
      };
    },
  };
}
