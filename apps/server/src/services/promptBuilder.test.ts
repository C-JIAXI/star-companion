import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { buildPromptContext } from "./promptBuilder.js";
import { createCharacterExportCard, importCharacterCard } from "./characterCards.js";
import { serializeUserCustomConfig } from "./userCustomConfig.js";

const ids = {
  characterId: "",
  foreignCharacterId: "",
  chatId: "",
  loreCharacterId: "",
  loreChatId: "",
  privateCharacterId: "",
  privateChatId: ""
};

const testSettings = {
  id: "prompt-builder-settings-test",
  activeProvider: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: null,
  model: "gpt-4o-mini",
  temperature: 0.8,
  maxTokens: 800,
  topP: 1,
  language: "zh-CN",
  models: [],
  providers: [],
  activeProviderId: "",
  activeModelId: "",
  userProfileSummary: "",
  autoSummarizeUser: true,
  showMessageAvatars: true,
  userProfileUpdatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date()
} as UserSettings;

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
            scope: "prompt",
            triggerMode: "user",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-2",
            keys: ["assistant-key"],
            content: "Assistant-triggered lore content.",
            priority: 3,
            scope: "prompt",
            triggerMode: "assistant",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-3",
            keys: ["shared-key"],
            content: "Shared-triggered lore content.",
            priority: 2,
            scope: "prompt",
            triggerMode: "both",
            alwaysActive: false,
            enabled: true
          },
          {
            id: "entry-4",
            keys: [],
            content: "Persistent lore content.",
            priority: 1,
            scope: "prompt",
            triggerMode: "both",
            alwaysActive: true,
            enabled: true
          },
          {
            id: "entry-5",
            keys: ["disabled-key"],
            content: "Disabled lore content.",
            priority: 5,
            scope: "prompt",
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

    const privateCharacterCard = createCharacterExportCard(
      {
        name: "Imported Private Character",
        avatar: null,
        prefix: "Hidden prefix instruction.",
        prompt: "Hidden prompt instruction for imported private cards.",
        suffix: "Hidden suffix instruction.",
        htmlCss: ".private-card { color: #abc; }",
        loreEntries: []
      },
      "private",
      "open-sesame"
    );
    const privateCharacter = await prisma.character.create({
      data: importCharacterCard(privateCharacterCard)
    });
    ids.privateCharacterId = privateCharacter.id;

    const chat = await prisma.chat.create({
      data: {
        title: "Prompt Test Chat",
        characterId: character.id,
        memoryTurns: 4,
        userPersona: serializeUserCustomConfig({
          prefix: "The user is roleplaying as a cautious investigator.",
          prompt: "They value truth over comfort.",
          suffix: "Keep the relationship tense but cooperative."
        }),
        userProfileSummary: "User prefers concise technical summaries."
      }
    });
    ids.chatId = chat.id;

    const loreChat = await prisma.chat.create({
      data: {
        title: "Lore Test Chat",
        characterId: loreCharacter.id,
        memoryTurns: 4
      }
    });
    ids.loreChatId = loreChat.id;

    const privateChat = await prisma.chat.create({
      data: {
        title: "Imported Private Character Chat",
        characterId: privateCharacter.id,
        memoryTurns: 4
      }
    });
    ids.privateChatId = privateChat.id;

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

    await prisma.chatMemory.create({
      data: {
        chatId: chat.id,
        title: "Investigation preference",
        content: "The user and character have agreed to keep clues explicit.",
        keywords: ["clues", "investigation"],
        importance: 4,
        enabled: true,
        sourceMessageIds: []
      }
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
    if (ids.privateChatId) {
      await prisma.chat.delete({ where: { id: ids.privateChatId } }).catch(() => {});
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
    if (ids.privateCharacterId) {
      await prisma.character.delete({ where: { id: ids.privateCharacterId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("injects user profile memory and only matching lore entries from the chat character", async () => {
    const context = await buildPromptContext({ chatId: ids.chatId, settings: testSettings });
    const matchedContents = context.matchedLoreEntries.map((entry) => entry.content);
    const matchedMemoryContents = context.matchedMemoryEntries.map((entry) => entry.content);
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.match(promptText, /User prefers concise technical summaries/);
    assert.match(promptText, /Relevant long-term chat memories/);
    assert.match(promptText, /The user and character have agreed to keep clues explicit/);
    assert.match(promptText, /The user is roleplaying as a cautious investigator\./);
    assert.match(promptText, /They value truth over comfort\./);
    assert.match(promptText, /Keep the relationship tense but cooperative\./);
    assert.match(
      promptText,
      /The user is roleplaying as a cautious investigator\.[\s\S]*They value truth over comfort\.[\s\S]*Keep the relationship tense but cooperative\./
    );
    assert.match(promptText, /Stay grounded\./);
    assert.match(promptText, /A character used by prompt builder tests\./);
    assert.match(promptText, /Reply briefly\./);
    assert.doesNotMatch(promptText, /\.card \{ color: #fff; \} \.title \{ font-weight: 700; \}/);
    assert.doesNotMatch(promptText, /Global instruction:/);
    assert.doesNotMatch(promptText, /You are writing as the character/);
    assert.doesNotMatch(promptText, /HTML rendering is enabled for this character/);
    assert.doesNotMatch(promptText, /When it conflicts with inferred profile memory/);
    assert.deepEqual(
      new Set(matchedContents),
      new Set([
        "User-triggered lore content.",
        "Assistant-triggered lore content.",
        "Shared-triggered lore content.",
        "Persistent lore content."
      ])
    );
    assert.deepEqual(
      new Set(matchedMemoryContents),
      new Set(["The user and character have agreed to keep clues explicit."])
    );
    assert.doesNotMatch(promptText, /Disabled lore content/);
    assert.match(promptText, /Prompt Test Character: The assistant says assistant-key\./);
  });

  it("does not inject lore when a chat character has no lore entries", async () => {
    const context = await buildPromptContext({ chatId: ids.loreChatId, settings: testSettings });

    assert.equal(context.matchedLoreEntries.length, 0);
    assert.doesNotMatch(
      context.messages.map((message) => message.content).join("\n\n"),
      /User-triggered lore content/
    );
  });

  it("ignores malformed chat user config payloads", async () => {
    const malformedChat = await prisma.chat.create({
      data: {
        title: "Malformed User Persona Chat",
        characterId: ids.characterId,
        memoryTurns: 4,
        userPersona: "not-json",
        userProfileSummary: ""
      }
    });

    try {
      const context = await buildPromptContext({ chatId: malformedChat.id, settings: testSettings });
      const promptText = context.messages.map((message) => message.content).join("\n\n");

      assert.doesNotMatch(promptText, /not-json/);
    } finally {
      await prisma.chat.delete({ where: { id: malformedChat.id } }).catch(() => {});
    }
  });

  it("uses the private chat character when a stale target character is provided", async () => {
    const context = await buildPromptContext({
      chatId: ids.chatId,
      characterId: ids.foreignCharacterId,
      settings: testSettings
    });
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.match(promptText, /Stay grounded\./);
    assert.doesNotMatch(promptText, /Prompt Test Foreign Character/);
    assert.doesNotMatch(promptText, /A stale target that must not affect private chats/);
  });

  it("hides prompt fields for imported private characters until password unlock", async () => {
    const context = await buildPromptContext({ chatId: ids.privateChatId, settings: testSettings });
    const promptText = context.messages.map((message) => message.content).join("\n\n");

    assert.doesNotMatch(promptText, /Hidden prefix instruction\./);
    assert.doesNotMatch(promptText, /Hidden prompt instruction for imported private cards\./);
    assert.doesNotMatch(promptText, /Hidden suffix instruction\./);
  });
});
