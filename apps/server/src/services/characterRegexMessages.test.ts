import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { prisma } from "../db.js";
import { buildPromptMessages } from "./promptBuilder.js";
import { addDisplayContent, processStoredContent } from "./characterRegexMessages.js";

const created: { characterId?: string; chatId?: string } = {};
const stored = { id: "stored", title: "Store", pattern: "hello", replacement: "saved", enabled: true, scope: "user", renderOnly: false };
const rendered = { id: "rendered", title: "Render", pattern: "saved", replacement: "shown", enabled: true, scope: "user", renderOnly: true };

describe("character regex message context", () => {
  after(async () => {
    if (created.chatId) await prisma.chat.delete({ where: { id: created.chatId } }).catch(() => {});
    if (created.characterId) await prisma.character.delete({ where: { id: created.characterId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("keeps rendered history out of model context while stored edits enter it", async () => {
    const character = await prisma.character.create({ data: { name: "Regex context test", prompt: "Synthetic", regexScripts: [stored, rendered] } });
    created.characterId = character.id;
    const chat = await prisma.chat.create({ data: { title: "Regex context chat", characterId: character.id } });
    created.chatId = chat.id;

    const content = await processStoredContent(chat.id, "user", "hello");
    assert.equal(content, "saved");
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content } });
    assert.equal((await addDisplayContent([{ chatId: chat.id, role: "user", content: message.content }]))[0]?.displayContent, "shown");
    assert.equal((await buildPromptMessages({ chatId: chat.id })).some((part) => part.content === "saved"), true);
    assert.equal((await buildPromptMessages({ chatId: chat.id })).some((part) => part.content === "shown"), false);

    await prisma.character.update({ where: { id: character.id }, data: { regexScripts: [stored, { ...rendered, replacement: "changed" }] } });
    assert.equal((await addDisplayContent([{ chatId: chat.id, role: "user", content: message.content }]))[0]?.displayContent, "changed");
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).content, "saved");
    assert.equal(await processStoredContent(chat.id, "user", "hello"), "saved", "an edited message is processed with the current stored rule");
  });
});
