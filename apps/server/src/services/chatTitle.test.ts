import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import {
  buildChatTitleSuggestionMessages,
  createChatTitleSuggestion,
  normalizeChatTitleSuggestion
} from "./chatTitle.js";

describe("chatTitle", () => {
  it("uses recent conversation only and keeps product boundaries in the title prompt", () => {
    const messages = buildChatTitleSuggestionMessages([
      { role: "system", content: "Character instructions should not be copied." },
      { role: "user", content: "We found a blue door." },
      { role: "assistant", content: "Its hinge points to the lighthouse." }
    ]);
    const prompt = messages[0]?.content ?? "";

    assert.match(prompt, /single-character roleplay chat/i);
    assert.match(prompt, /Do not introduce group chat/i);
    assert.match(prompt, /standalone lorebooks/i);
    assert.equal(messages.length, 3);
    assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /Character instructions/);
  });

  it("normalizes model output into a compact title", () => {
    assert.equal(normalizeChatTitleSuggestion('  ## "The Blue Door"  '), "The Blue Door");
    assert.equal(normalizeChatTitleSuggestion("   "), "");
    assert.ok(normalizeChatTitleSuggestion("a ".repeat(100)).length <= 80);
  });

  it("bounds long context and reports a visible error when a model uses its output budget without a title", async () => {
    const originalFetch = globalThis.fetch;
    const settings = await prisma.userSettings.create({ data: {
      id: `title-settings-${randomUUID()}`,
      createdAt: new Date(0),
      apiBaseUrl: "https://title-mock.invalid/v1",
      model: "reasoning-title-model",
      maxTokens: 800,
      providers: [{ id: "title-provider", label: "Title provider", provider: "openai-compatible", apiBaseUrl: "https://title-mock.invalid/v1",
        models: [{ id: "title-model", label: "Title model", model: "reasoning-title-model", capabilities: ["text_generation"] }] }],
      activeProviderId: "title-provider",
      activeModelId: "title-model",
      modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
      usageBudgets: { allowUnknownPricing: true }
    } });
    const chat = await prisma.chat.create({ data: { title: "Title fixture" } });
    let requestBody: { max_tokens?: number; messages?: Array<{ content: string }> } | null = null;
    try {
      await prisma.message.create({ data: { chatId: chat.id, role: "user", content: "A long scene. ".repeat(8000) } });
      globalThis.fetch = (async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "" } }],
          usage: { prompt_tokens: 29420, completion_tokens: 80, total_tokens: 29500 }
        }), { status: 200 });
      }) as typeof fetch;

      await assert.rejects(createChatTitleSuggestion(chat.id),
        (error) => error instanceof HttpError && error.status === 422 && /title/i.test(error.message));
      assert.ok(requestBody);
      assert.ok(requestBody.max_tokens >= 256);
      assert.ok((requestBody.messages ?? []).reduce((sum, message) => sum + message.content.length, 0) < 10_000);
    } finally {
      globalThis.fetch = originalFetch;
      await prisma.modelRequest.deleteMany({ where: { chatId: chat.id } });
      await prisma.chat.delete({ where: { id: chat.id } });
      await prisma.userSettings.delete({ where: { id: settings.id } });
    }
  });
});
