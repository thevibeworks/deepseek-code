// SKILL.md discovery (DESIGN.md "Skills", milestone 8). A skill is a
// directory holding a SKILL.md: YAML frontmatter with `name` and
// `description`, body = instructions. Discovery reads the SAME roots dsh
// reads (verified against dsh's skill-filesystem package at launch), so
// one skills directory serves both harnesses:
//
//   <project>/.dsc/skills      (dsh reads .dsh/skills at the same rank)
//   <project>/.agents/skills   (cross-harness convention)
//   ~/.dsc/skills
//   ~/.agents/skills
//
// Precedence on a name collision is that order — project beats home,
// harness-native beats shared — matching dsh's root ranks, so the two
// harnesses resolve a collision the same way. The project root is found
// by walking up from cwd to the nearest .git (else cwd itself), also the
// dsh rule; a skills dir in a repo works from any subdirectory.
//
// Only name + description are read at discovery (they go into the system
// prompt index); the body is loaded on demand by the skill tool. A file
// that cannot be parsed — malformed frontmatter, missing fields, a name
// dsh would also reject — is skipped with a warning, never a crash: one
// broken skill must not take down every session in the directory.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SkillSource = "project-dsc" | "project-agents" | "user-dsc" | "user-agents";

export type Skill = {
  /** Frontmatter `name` — the identity the model invokes, per dsh. */
  name: string;
  description: string;
  /** Path to the SKILL.md file (its directory is the resource base). */
  path: string;
  source: SkillSource;
};

export type SkillDiscovery = { skills: Skill[]; warnings: string[] };

/** Same rule dsh enforces; a name failing it is invisible to both harnesses. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function discoverSkills(cwd: string, home = homedir()): SkillDiscovery {
  const project = findProjectRoot(resolve(cwd));
  const roots: { dir: string; source: SkillSource }[] = [
    { dir: join(project, ".dsc", "skills"), source: "project-dsc" },
    { dir: join(project, ".agents", "skills"), source: "project-agents" },
    { dir: join(home, ".dsc", "skills"), source: "user-dsc" },
    { dir: join(home, ".agents", "skills"), source: "user-agents" },
  ];
  const seen = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const root of roots) {
    for (const entry of listSkillDirs(root.dir)) {
      const path = join(root.dir, entry, "SKILL.md");
      if (!existsSync(path)) continue; // a dir without SKILL.md is not a skill
      const parsed = parseSkillFile(path);
      if ("problem" in parsed) {
        warnings.push(`${path} skipped: ${parsed.problem}`);
        continue;
      }
      const prior = seen.get(parsed.name);
      if (prior !== undefined) {
        warnings.push(`${path} shadowed: "${parsed.name}" already provided by ${prior.path}`);
        continue;
      }
      seen.set(parsed.name, { ...parsed, path, source: root.source });
    }
  }
  return { skills: [...seen.values()], warnings };
}

/** Directory entries of a skills root, sorted for deterministic prompts.
 * A missing root is the normal case, not an error. */
function listSkillDirs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Nearest ancestor holding a .git, else cwd — the dsh project-root rule. */
function findProjectRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function parseSkillFile(
  path: string,
): { name: string; description: string } | { problem: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { problem: `unreadable (${String(err)})` };
  }
  const fm = parseFrontmatter(raw);
  if ("problem" in fm) return fm;
  const name = fm.fields.name;
  const description = fm.fields.description;
  if (name === undefined || name === "" || description === undefined || description === "") {
    return { problem: "frontmatter requires name and description" };
  }
  if (!SKILL_NAME.test(name)) {
    return { problem: `invalid skill name "${name}" (lowercase alphanumerics and hyphens)` };
  }
  return { name, description };
}

/** Minimal YAML frontmatter reader — deliberately a subset, zero deps.
 * Top-level `key: value` scalars (plain, quoted, or |/> block); indented
 * lines under a structured key (e.g. metadata maps) are tolerated and
 * ignored. Anything else is malformed and skips the skill with a warning. */
export function parseFrontmatter(
  raw: string,
): { fields: Record<string, string> } | { problem: string } {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== "---") return { problem: "missing YAML frontmatter" };
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") return { fields };
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Indented continuation: belongs to a nested structure or block we
    // already consumed — never to the flat fields we need.
    if (/^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (m === null) return { problem: `malformed YAML frontmatter (line ${i + 1}: "${line}")` };
    const key = m[1];
    let value = m[2].trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      // The index renders one line per skill, so both literal and folded
      // blocks collapse to a single space-joined line here.
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) {
        const piece = lines[i + 1].trim();
        if (piece !== "") block.push(piece);
        i++;
      }
      value = block.join(" ");
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { problem: "unterminated YAML frontmatter (no closing ---)" };
}

/** Body after the frontmatter — what the skill tool returns. A file that
 * lost its frontmatter since discovery degrades to its full text. */
export function stripFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return raw;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, "") === "---") return lines.slice(i + 1).join("\n");
  }
  return raw;
}
