// Skills (M8): discovery, precedence, frontmatter hardening, and the
// on-demand loading contract of the skill tool. The prompt-injection
// bytes are frozen in prompt-golden.test.ts; this file covers behavior.
// The layout under test is the one dsh reads (<root>/skills/<name>/
// SKILL.md across .dsc/.agents, project and home), so these tests are
// also the interop claim: a fixture either harness discovers, both do.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseFrontmatter, stripFrontmatter } from "../src/skills/discover";
import { makeSkillTool } from "../src/tools/skill";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dsc-skills-"));
  dirs.push(d);
  return d;
}

function addSkill(root: string, sub: string, name: string, frontmatter: string, body = "Do the thing."): string {
  const dir = join(root, sub, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

describe("skill discovery", () => {
  test("empty and missing roots discover nothing, without warnings", () => {
    const project = tmp();
    const home = tmp();
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    const r = discoverSkills(project, home);
    expect(r.skills).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("finds skills in all four roots with name and description from frontmatter", () => {
    const project = tmp();
    const home = tmp();
    addSkill(project, ".dsc/skills", "alpha", 'name: alpha\ndescription: "First skill."');
    addSkill(project, ".agents/skills", "beta", "name: beta\ndescription: Second skill.");
    addSkill(home, ".dsc/skills", "gamma", "name: gamma\ndescription: Third skill.");
    addSkill(home, ".agents/skills", "delta", "name: delta\ndescription: Fourth skill.");
    const r = discoverSkills(project, home);
    expect(r.skills.map((s) => [s.name, s.source])).toEqual([
      ["alpha", "project-dsc"],
      ["beta", "project-agents"],
      ["gamma", "user-dsc"],
      ["delta", "user-agents"],
    ]);
    expect(r.skills[0].description).toBe("First skill.");
    expect(r.warnings).toEqual([]);
  });

  test("project wins a name collision against home, with a shadow warning", () => {
    const project = tmp();
    const home = tmp();
    const winner = addSkill(project, ".agents/skills", "dupe", "name: dupe\ndescription: Project copy.");
    addSkill(home, ".agents/skills", "dupe", "name: dupe\ndescription: Home copy.");
    const r = discoverSkills(project, home);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].description).toBe("Project copy.");
    expect(r.skills[0].path).toBe(winner);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("shadowed");
  });

  test(".dsc beats .agents within the same scope (harness-native first, the dsh rank order)", () => {
    const project = tmp();
    const home = tmp();
    addSkill(project, ".dsc/skills", "dupe", "name: dupe\ndescription: Native copy.");
    addSkill(project, ".agents/skills", "dupe", "name: dupe\ndescription: Shared copy.");
    const r = discoverSkills(project, home);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].source).toBe("project-dsc");
  });

  test("walks up to the .git project root, so subdirectories see project skills", () => {
    const project = tmp();
    const home = tmp();
    mkdirSync(join(project, ".git"), { recursive: true });
    addSkill(project, ".agents/skills", "rooted", "name: rooted\ndescription: At the repo root.");
    const sub = join(project, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const r = discoverSkills(sub, home);
    expect(r.skills.map((s) => s.name)).toEqual(["rooted"]);
  });

  test("skips with a warning instead of crashing: missing fields, bad name, malformed YAML", () => {
    const project = tmp();
    const home = tmp();
    addSkill(project, ".agents/skills", "no-desc", "name: no-desc");
    addSkill(project, ".agents/skills", "bad-name", "name: Bad_Name\ndescription: Casing dsh rejects too.");
    addSkill(project, ".agents/skills", "mangled", "name mangled\nnot yaml at all");
    const unterminated = join(project, ".agents/skills", "unterminated");
    mkdirSync(unterminated, { recursive: true });
    writeFileSync(
      join(unterminated, "SKILL.md"),
      "---\nname: unterminated\ndescription: x\nbody without a closing fence\n",
    );
    addSkill(project, ".agents/skills", "ok", "name: ok\ndescription: Survives its broken neighbors.");
    const r = discoverSkills(project, home);
    expect(r.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join("\n")).toContain("requires name and description");
    expect(r.warnings.join("\n")).toContain('invalid skill name "Bad_Name"');
    expect(r.warnings.join("\n")).toContain("malformed YAML");
    expect(r.warnings.join("\n")).toContain("unterminated");
  });

  test("a directory without SKILL.md and a file without frontmatter", () => {
    const project = tmp();
    const home = tmp();
    mkdirSync(join(project, ".agents", "skills", "not-a-skill"), { recursive: true });
    const bare = join(project, ".agents", "skills", "bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "SKILL.md"), "Just prose, no frontmatter.\n");
    const r = discoverSkills(project, home);
    expect(r.skills).toEqual([]);
    // No SKILL.md = not a skill, silently (matches dsh); no frontmatter
    // in a SKILL.md = broken skill, warned.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("missing YAML frontmatter");
  });
});

describe("frontmatter parsing", () => {
  test("plain, quoted, and folded-block scalars", () => {
    const r = parseFrontmatter(
      "---\nname: fold\ndescription: >-\n  Spans two\n  source lines.\nlicense: 'MIT'\n---\nbody",
    );
    if ("problem" in r) throw new Error(r.problem);
    expect(r.fields.name).toBe("fold");
    expect(r.fields.description).toBe("Spans two source lines.");
    expect(r.fields.license).toBe("MIT");
  });

  test("tolerates nested structures it does not need", () => {
    const r = parseFrontmatter("---\nname: meta\ndescription: Has metadata.\nmetadata:\n  author: someone\n---\n");
    if ("problem" in r) throw new Error(r.problem);
    expect(r.fields.name).toBe("meta");
  });

  test("stripFrontmatter returns the body, or the whole text when no frontmatter", () => {
    expect(stripFrontmatter("---\nname: x\n---\nThe body.\n")).toBe("The body.\n");
    expect(stripFrontmatter("No fences here.\n")).toBe("No fences here.\n");
  });
});

describe("skill tool", () => {
  const ctx = { cwd: "/work" };

  test("loads the body on demand, without the frontmatter, naming the source path", async () => {
    const project = tmp();
    const home = tmp();
    const path = addSkill(project, ".agents/skills", "loader", "name: loader\ndescription: Loads.", "Step 1: read.\nStep 2: act.");
    const { skills } = discoverSkills(project, home);
    const tool = makeSkillTool(skills);
    const r = await tool.execute({ name: "loader" }, ctx);
    expect(r.isError ?? false).toBe(false);
    expect(r.output).toContain('Skill "loader"');
    expect(r.output).toContain(path);
    expect(r.output).toContain("Step 1: read.");
    expect(r.output).not.toContain("description:");
  });

  test("unknown name errors and lists what exists", async () => {
    const project = tmp();
    const home = tmp();
    addSkill(project, ".agents/skills", "real", "name: real\ndescription: Exists.");
    const tool = makeSkillTool(discoverSkills(project, home).skills);
    const r = await tool.execute({ name: "imaginary" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("real");
  });

  test("a file deleted after discovery errors instead of crashing", async () => {
    const project = tmp();
    const home = tmp();
    const path = addSkill(project, ".agents/skills", "gone", "name: gone\ndescription: Doomed.");
    const tool = makeSkillTool(discoverSkills(project, home).skills);
    rmSync(path);
    const r = await tool.execute({ name: "gone" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("no longer exists");
  });

  test("coerces the aliases models actually emit", async () => {
    const project = tmp();
    const home = tmp();
    addSkill(project, ".agents/skills", "aliased", "name: aliased\ndescription: Aliases.");
    const tool = makeSkillTool(discoverSkills(project, home).skills);
    expect(tool.coerce!({ skill_name: "aliased" })).toEqual({ name: "aliased" });
    expect(tool.coerce!({ skill: "aliased" })).toEqual({ name: "aliased" });
  });
});
