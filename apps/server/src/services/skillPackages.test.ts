import assert from "node:assert/strict";
import { it } from "node:test";
import yazl from "yazl";
import { BUILTIN_SKILLS, parseSkillMarkdown, parseSkillZip } from "./skillPackages.js";

const markdown = "---\nname: scene-tracker\ndescription: Track a scene using current-chat evidence.\n---\nFind the prior promise, then cite it.";
const zipOf = (entries: Array<{ path: string; content: string; mode?: number }>) => new Promise<Buffer>((resolve, reject) => {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  zip.outputStream.on("error", reject);
  zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.content), entry.path, entry.mode ? { mode: entry.mode } : {});
  zip.end();
});

it("validates Skill metadata and ships four distinct built-in methods", () => {
  const skill = parseSkillMarkdown(markdown);
  assert.equal(skill.name, "scene-tracker");
  assert.equal(skill.description, "Track a scene using current-chat evidence.");
  assert.equal(BUILTIN_SKILLS.length, 4);
  assert.equal(new Set(BUILTIN_SKILLS.map((item) => item.name)).size, 4);
  assert.throws(() => parseSkillMarkdown(markdown.replace("scene-tracker", "Scene_Tracker")), /Invalid Skill name/);
  assert.throws(() => parseSkillMarkdown("---\nname: scene-tracker\n---\nBody"), /description/);
  assert.throws(() => parseSkillMarkdown(markdown.replace("name: scene-tracker", "name: !!js/function dangerous")));
});

it("loads text references from a bounded ZIP while marking executable files unavailable", async () => {
  const zip = await zipOf([
    { path: "scene-tracker/SKILL.md", content: markdown },
    { path: "scene-tracker/references/NOTES.md", content: "Current chat only." },
    { path: "scene-tracker/scripts/scan.py", content: "print('never run')" }
  ]);
  const skill = await parseSkillZip(zip);
  assert.equal(skill.references["references/NOTES.md"], "Current chat only.");
  assert.deepEqual(skill.unsupportedFiles, ["scripts/scan.py"]);
  assert.equal(skill.digest.length, 64);
});

it("rejects ZIP package name mismatches, symbolic links, and oversized payloads", async () => {
  await assert.rejects(parseSkillZip(await zipOf([{ path: "wrong/SKILL.md", content: markdown }])), /folder must match/);
  await assert.rejects(parseSkillZip(await zipOf([
    { path: "scene-tracker/SKILL.md", content: markdown },
    { path: "scene-tracker/references/link.md", content: "target", mode: 0o120777 }
  ])), /symbolic links/);
  await assert.rejects(parseSkillZip(await zipOf([
    { path: "scene-tracker/SKILL.md", content: markdown },
    { path: "scene-tracker/references/HUGE.txt", content: "x".repeat(600_000) }
  ])), /size limit/);
});
