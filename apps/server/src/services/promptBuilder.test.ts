import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../db.js";
import { buildPromptContext } from "./promptBuilder.js";

const ids = {
  characterId: "",
  foreignCharacterId: "",
  chatId: "",
  loreCharacterId: "",
  loreChatId: ""
};

describe("buildPromptContext", () => {
  before(async () => {
    await prisma.userSettings.findFirst({
      orderBy: { createdAt: "asc" }
    });

    const character = await prisma.character.create({
      data: {
        name: "Prompt Test Character",
        avatar: "",
        prefix: "Stay grounded.",
        prompt: "A character used by prompt builder tests.",
        suffix: "Reply briefly.",
        htmlCss: ".card { color: #fff; } .title { font-weight: 700; }",
        loreEntries: [
          {
            id: "entry-1",
            keys: ["user-key"],
            content: "User-triggered lore content.",
            priority: 4,
            triggerMode: "user",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-2",
            keys: ["assistant-key"],
            content: "Assistant-triggered lore content.",
            priority: 3,
            triggerMode: "assistant",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-3",
            keys: ["shared-key"],
            content: "Shared-triggered lore content.",
            priority: 2,
            triggerMode: "both",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-4",
            keys: [],
            content: "Persistent lore content.",
            priority: 1,
            triggerMode: "both",
            alwaysActive: true,
            enabled: true
          },
          {
            id: "entry-5",
            keys: ["disabled-key"],
            content: "Disabled lore content.",
            priority: 5,
            triggerMode: "both",
            alwaysActive: false,
            enabled: false
          }
        ]
      }
    });
    ids.characterId = character.id;

    const foreignCharacter = await prisma.character.create({
      data: {
        name: "Prompt Test Foreign Character",
        avatar: "",
        prefix: "This character belongs to another chat.",
        prompt: "A stale target that must not affect private chats.",
        suffix: "Never appear in the private chat prompt."
      }
    });
    ids.foreignCharacterId = foreignCharacter.id;

    const loreCharacter = await prisma.character.create({
      data: {
        name: "Lore Test Character",
        avatar: "",
        prefix: "",
        prompt: "A character with no lore entries.",
        suffix: "",
        loreEntries: []
      }
    });
    ids.loreCharacterId = loreCharacter.id;

    const chat = await prisma.chat.create({
      data: {
        title: "Prompt Test Chat",
        mode: "single",
        characterIds: [character.id],
        memoryTurns: 4,
        userPersona: "The user is roleplaying as a cautious investigator who values truth over comfort.",
        userProfileSummary: "User prefers concise technical summaries."
      }
    });
    ids.chatId = chat.id;

    const loreChat = await prisma.chat.create({
      data: {
        title: "Lore Test Chat",
        mode: "single",
        characterIds: [loreCharacter.id],
        memoryTurns: 4
      }
    });
    ids.loreChatId = loreChat.id;

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

    await prisma.message.create({
      data: {
        chatId: loreChat.id,
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
    if (ids.loreChatId) {
      await prisma.chat.delete({ where: { id: ids.loreChatId } }).catch(() => {});
    }
    if (ids.characterId) {
      await prisma.character.delete({ where: { id: ids.characterId } }).catch(() => {});
    }
    if (ids.foreignCharacterId) {
      await prisma.character.delete({ where: { id: ids.foreignCharacterId } }).catch(() => {});
    }
    if (ids.loreCharacterId) {
      await prisma.character.delete({ where: { id: ids.loreCharacterId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("injects user profile memory and only matching entries from bound lorebooks", async () => {
    const context = await buildPromptContext({ chatId: ids.chatId });
    const matchedContents = context.matchedLoreEntries.map((entry) => entry.content);
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.match(promptText, /User prefers concise technical summaries/);
    assert.match(promptText, /The user is roleplaying as a cautious investigator who values truth over comfort\./);
    assert.match(promptText, /When it conflicts with inferred profile memory, prefer this explicit setting\./);
    assert.match(promptText, /You are writing as the character "Prompt Test Character"/);
    assert.match(promptText, /HTML rendering is enabled for this character/);
    assert.match(promptText, /Available renderer CSS:\n\.card \{ color: #fff; \} \.title \{ font-weight: 700; \}/);
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
    assert.match(promptText, /Prompt Test Character: The assistant says assistant-key\./);
  });

  it("does not inject lore when a chat character has no lore entries", async () => {
    const context = await buildPromptContext({ chatId: ids.loreChatId });

    assert.equal(context.matchedLoreEntries.length, 0);
    assert.doesNotMatch(
      context.messages.map((message) => message.content).join("\n\n"),
      /User-triggered lore content/
    );
  });

  it("uses the private chat character when a stale target character is provided", async () => {
    const context = await buildPromptContext({
      chatId: ids.chatId,
      characterId: ids.foreignCharacterId
    });
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.match(promptText, /You are writing as the character "Prompt Test Character"/);
    assert.doesNotMatch(promptText, /Prompt Test Foreign Character/);
    assert.doesNotMatch(promptText, /A stale target that must not affect private chats/);
  });
});
