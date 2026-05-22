import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../db.js";
import { buildPromptContext } from "./promptBuilder.js";

const ids = {
  characterId: "",
  boundLorebookId: "",
  unboundLorebookId: "",
  chatId: "",
  unboundChatId: ""
};

let settingsId = "";
let originalUserProfileSummary = "";

describe("buildPromptContext", () => {
  before(async () => {
    const existingSettings = await prisma.userSettings.findFirst({
      orderBy: { createdAt: "asc" }
    });
    const settings =
      existingSettings ??
      (await prisma.userSettings.create({
        data: {}
      }));

    settingsId = settings.id;
    originalUserProfileSummary = settings.userProfileSummary;
    await prisma.userSettings.update({
      where: { id: settings.id },
      data: {
        userProfileSummary: "User prefers concise technical summaries."
      }
    });

    const character = await prisma.character.create({
      data: {
        name: "Prompt Test Character",
        avatar: "",
        prefix: "Stay grounded.",
        prompt: "A character used by prompt builder tests.",
        suffix: "Reply briefly."
      }
    });
    ids.characterId = character.id;

    const boundLorebook = await prisma.lorebook.create({
      data: {
        name: "Prompt Test Bound Lorebook",
        description: "Bound lorebook"
      }
    });
    ids.boundLorebookId = boundLorebook.id;

    const unboundLorebook = await prisma.lorebook.create({
      data: {
        name: "Prompt Test Unbound Lorebook",
        description: "Unbound lorebook"
      }
    });
    ids.unboundLorebookId = unboundLorebook.id;

    await prisma.loreEntry.createMany({
      data: [
        {
          lorebookId: boundLorebook.id,
          keys: ["user-key"],
          content: "User-triggered lore content.",
          priority: 4,
          triggerMode: "user",
          alwaysActive: false,
          enabled: true
        },
        {
          lorebookId: boundLorebook.id,
          keys: ["assistant-key"],
          content: "Assistant-triggered lore content.",
          priority: 3,
          triggerMode: "assistant",
          alwaysActive: false,
          enabled: true
        },
        {
          lorebookId: boundLorebook.id,
          keys: ["shared-key"],
          content: "Shared-triggered lore content.",
          priority: 2,
          triggerMode: "both",
          alwaysActive: false,
          enabled: true
        },
        {
          lorebookId: boundLorebook.id,
          keys: ["missing-key"],
          content: "Persistent lore content.",
          priority: 1,
          triggerMode: "both",
          alwaysActive: true,
          enabled: true
        },
        {
          lorebookId: boundLorebook.id,
          keys: ["user-key"],
          content: "Disabled lore content.",
          priority: 10,
          triggerMode: "user",
          alwaysActive: false,
          enabled: false
        },
        {
          lorebookId: unboundLorebook.id,
          keys: ["user-key"],
          content: "Unbound lore content.",
          priority: 10,
          triggerMode: "user",
          alwaysActive: false,
          enabled: true
        }
      ]
    });

    const chat = await prisma.chat.create({
      data: {
        title: "Prompt Test Chat",
        mode: "single",
        characterIds: [character.id],
        lorebookIds: [boundLorebook.id],
        memoryTurns: 4
      }
    });
    ids.chatId = chat.id;

    await prisma.message.createMany({
      data: [
        {
          chatId: chat.id,
          role: "user",
          characterId: null,
          content: "The user says user-key and shared-key.",
          variants: [],
          activeVariantIndex: 0
        },
        {
          chatId: chat.id,
          role: "assistant",
          characterId: character.id,
          content: "The assistant says assistant-key.",
          variants: [],
          activeVariantIndex: 0
        }
      ]
    });

    const unboundChat = await prisma.chat.create({
      data: {
        title: "Prompt Test Unbound Chat",
        mode: "single",
        characterIds: [character.id],
        lorebookIds: [],
        memoryTurns: 4
      }
    });
    ids.unboundChatId = unboundChat.id;

    await prisma.message.create({
      data: {
        chatId: unboundChat.id,
        role: "user",
        characterId: null,
        content: "The user says user-key.",
        variants: [],
        activeVariantIndex: 0
      }
    });
  });

  after(async () => {
    if (ids.chatId) {
      await prisma.chat.delete({ where: { id: ids.chatId } }).catch(() => {});
    }
    if (ids.unboundChatId) {
      await prisma.chat.delete({ where: { id: ids.unboundChatId } }).catch(() => {});
    }
    if (ids.boundLorebookId) {
      await prisma.lorebook.delete({ where: { id: ids.boundLorebookId } }).catch(() => {});
    }
    if (ids.unboundLorebookId) {
      await prisma.lorebook.delete({ where: { id: ids.unboundLorebookId } }).catch(() => {});
    }
    if (ids.characterId) {
      await prisma.character.delete({ where: { id: ids.characterId } }).catch(() => {});
    }
    if (settingsId) {
      await prisma.userSettings
        .update({
          where: { id: settingsId },
          data: { userProfileSummary: originalUserProfileSummary }
        })
        .catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("injects user profile memory and only matching entries from bound lorebooks", async () => {
    const context = await buildPromptContext({ chatId: ids.chatId });
    const matchedContents = context.matchedLoreEntries.map((entry) => entry.content);
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.match(promptText, /User prefers concise technical summaries/);
    assert.match(promptText, /You are writing as the character "Prompt Test Character"/);
    assert.deepEqual(
      new Set(matchedContents),
      new Set([
        "User-triggered lore content.",
        "Assistant-triggered lore content.",
        "Shared-triggered lore content.",
        "Persistent lore content."
      ])
    );
    assert.doesNotMatch(promptText, /Disabled lore content/);
    assert.doesNotMatch(promptText, /Unbound lore content/);
    assert.match(promptText, /Prompt Test Character: The assistant says assistant-key\./);
  });

  it("does not inject lore when a chat has no bound lorebook", async () => {
    const context = await buildPromptContext({ chatId: ids.unboundChatId });

    assert.equal(context.matchedLoreEntries.length, 0);
    assert.doesNotMatch(
      context.messages.map((message) => message.content).join("\n\n"),
      /User-triggered lore content/
    );
  });
});
