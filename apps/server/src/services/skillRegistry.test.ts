import assert from "node:assert/strict";
import { after, it } from "node:test";
import { prisma } from "../db.js";
import { deleteSkill, getSkill, getSkillReference, importSkill, listEnabledChatSkillCatalog, loadEnabledChatSkill, listSkills, setSkillEnabled } from "./skillRegistry.js";

const name = "test-scene-tracker";
const chatIds: string[] = [];
after(async () => {
  await prisma.skillPackage.deleteMany({ where: { name } });
  if (chatIds.length) await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.$disconnect();
});

it("keeps imported Skills disabled, requires versioned replacement, and scopes chat activation", async () => {
  const markdown = `---\nname: ${name}\ndescription: Track the current scene.\n---\nSearch visible history only.`;
  const first = await importSkill({ format: "markdown", markdown });
  assert.equal(first.agentEnabled, false);
  assert.deepEqual(first.enabledChatIds, []);
  assert.equal((await listSkills()).filter((skill) => skill.source === "builtin").length, 4);
  assert.match((await getSkill(name)).skillMd, /Search visible history only/);
  await assert.rejects(getSkillReference(name, "../other"), /not found/);
  await assert.rejects(importSkill({ format: "markdown", markdown }), /confirm the current version/);
  const chat = await prisma.chat.create({ data: { title: "Skill scope" } });
  chatIds.push(chat.id);
  const enabled = await setSkillEnabled(name, { expectedVersion: first.version, chatId: chat.id, chatEnabled: true });
  assert.deepEqual(enabled.enabledChatIds, [chat.id]);
  assert.equal((await loadEnabledChatSkill(chat.id, name))?.name, name);
  assert.equal(await loadEnabledChatSkill("other-chat", name), null);
  assert.ok((await listEnabledChatSkillCatalog(chat.id)).some((skill) => skill.name === name));
  await assert.rejects(setSkillEnabled(name, { expectedVersion: first.version, agentEnabled: true }), /Skill changed/);
  const replaced = await importSkill({ format: "markdown", markdown: markdown.replace("Search visible history only", "Search memory too"), replaceVersion: enabled.version });
  assert.equal(replaced.agentEnabled, false);
  assert.deepEqual(replaced.enabledChatIds, []);
  await assert.rejects(deleteSkill(name, enabled.version), /changed/);
  assert.deepEqual(await deleteSkill(name, replaced.version), { deleted: true });
});
