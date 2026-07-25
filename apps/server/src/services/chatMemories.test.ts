import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import {
  buildChatMemoryMaintenanceMessages,
  buildMemoryRerankMessages,
  recallChatMemories,
  updateChatMemoriesFromTurn
} from "./chatMemories.js";

const originalFetch = globalThis.fetch;

const createSettings = (overrides: Partial<UserSettings> = {}): UserSettings =>
  ({
    id: "memory-settings-test",
    activeProvider: "openai-compatible",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "",
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
    updatedAt: new Date(),
    ...overrides
  }) as UserSettings;

const ids = {
  characterId: "",
  chatId: "",
  otherChatId: ""
};

describe("chat memory helpers", () => {
  before(async () => {
    const character = await prisma.character.create({
      data: {
        name: "Memory Test Character",
        avatar: "",
        prefix: "",
        prompt: "Memory test character.",
        suffix: ""
      }
    });
    ids.characterId = character.id;

    const chat = await prisma.chat.create({
      data: {
        title: "Memory Test Chat",
        characterId: character.id
      }
    });
    ids.chatId = chat.id;

    const otherChat = await prisma.chat.create({
      data: {
        title: "Other Memory Test Chat",
        characterId: character.id
      }
    });
    ids.otherChatId = otherChat.id;

    await prisma.chatMemory.createMany({
      data: [
        {
          chatId: chat.id,
          title: "Blue door clue",
          content: "The blue door hides the archive key.",
          keywords: ["blue door", "archive"],
          importance: 5,
          enabled: true,
          sourceMessageIds: []
        },
        {
          chatId: chat.id,
          title: "Disabled clue",
          content: "A disabled memory should not be recalled.",
          keywords: ["blue door"],
          importance: 5,
          enabled: false,
          sourceMessageIds: []
        },
        {
          chatId: otherChat.id,
          title: "Foreign clue",
          content: "Another chat has its own blue door.",
          keywords: ["blue door"],
          importance: 5,
          enabled: true,
          sourceMessageIds: []
        }
      ]
    });

    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: "We are checking the blue door.",
        variants: [],
        activeVariantIndex: 0
      }
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    if (ids.chatId) {
      await prisma.chat.delete({ where: { id: ids.chatId } }).catch(() => {});
    }
    if (ids.otherChatId) {
      await prisma.chat.delete({ where: { id: ids.otherChatId } }).catch(() => {});
    }
    if (ids.characterId) {
      await prisma.character.delete({ where: { id: ids.characterId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("recalls enabled memories from the current chat only", async () => {
    const recentMessages = await prisma.message.findMany({ where: { chatId: ids.chatId } });
    const memories = await recallChatMemories({
      chatId: ids.chatId,
      query: "What did we learn at the blue door?",
      recentMessages,
      settings: createSettings()
    });

    assert.deepEqual(memories.map((memory) => memory.title), ["Blue door clue"]);
  });

  it("falls back to keyword ranking when LLM reranking returns invalid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "not-json" } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const recentMessages = await prisma.message.findMany({ where: { chatId: ids.chatId } });
    const memories = await recallChatMemories({
      chatId: ids.chatId,
      query: "The archive behind the blue door matters.",
      recentMessages,
      settings: createSettings({ apiKey: "sk-test" })
    });

    assert.equal(memories[0]?.title, "Blue door clue");
  });

  it("returns a maintenance summary when automatic memory creates entries", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  actions: [
                    {
                      type: "create",
                      title: "Quiet inn preference",
                      content: "The user prefers quiet inns during travel scenes.",
                      keywords: ["quiet inn", "travel"],
                      importance: 4
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const chat = await prisma.chat.create({
      data: {
        title: "Memory summary chat",
        characterId: ids.characterId
      }
    });
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: "Please remember that I prefer quiet inns.",
        variants: [],
        activeVariantIndex: 0
      }
    });

    const summary = await updateChatMemoriesFromTurn({
      chatId: chat.id,
      settings: createSettings({ apiKey: "sk-test" })
    });

    assert.deepEqual(summary && {
      chatId: summary.chatId,
      created: summary.created,
      updated: summary.updated,
      disabled: summary.disabled,
      hasUpdatedAt: Boolean(summary.memoryUpdatedAt)
    }, {
      chatId: chat.id,
      created: 1,
      updated: 0,
      disabled: 0,
      hasUpdatedAt: true
    });

    await prisma.chat.delete({ where: { id: chat.id } });
  });

  it("does not throw when memory maintenance receives an empty model content", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "The model spent the response budget on reasoning."
              },
              finish_reason: "length"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const chat = await prisma.chat.create({
      data: {
        title: "Empty memory maintenance output",
        characterId: ids.characterId
      }
    });
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: "Please remember that I prefer quiet inns.",
        variants: [],
        activeVariantIndex: 0
      }
    });

    await assert.doesNotReject(
      updateChatMemoriesFromTurn({
        chatId: chat.id,
        settings: createSettings({ apiKey: "sk-test" })
      })
    );

    const memories = await prisma.chatMemory.findMany({ where: { chatId: chat.id } });
    assert.equal(memories.length, 0);
    const unchangedChat = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    assert.equal(unchangedChat.memoryUpdatedAt, null);

    await prisma.chat.delete({ where: { id: chat.id } });
  });

  it("builds rerank prompts that restrict output to candidate IDs", () => {
    const messages = buildMemoryRerankMessages("blue door", [
      {
        id: "memory-a",
        chatId: ids.chatId,
        title: "Blue door clue",
        content: "The blue door hides the archive key.",
        keywords: ["blue door"],
        importance: 5,
        enabled: true,
        score: 12,
        lastMatchedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]);

    assert.match(messages[0].content, /Only choose from the provided candidate IDs/);
    assert.match(messages[0].content, /Return JSON only/);
    assert.match(messages[1].content, /id=memory-a/);
  });

  it("builds maintenance prompts with privacy constraints", async () => {
    const recentMessages = await prisma.message.findMany({ where: { chatId: ids.chatId } });
    const messages = buildChatMemoryMaintenanceMessages([], recentMessages);

    assert.match(messages[0].content, /\/no_think/);
    assert.match(messages[0].content, /Do not write analysis/);
    assert.match(messages[0].content, /Do not store API keys/);
    assert.match(messages[0].content, /credentials/);
    assert.match(messages[0].content, /unsupported guesses/);
  });
});
