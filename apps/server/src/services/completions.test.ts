import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import {
  completeChatCompletion,
  fetchAvailableModels,
  streamChatCompletion,
  testModelConnection
} from "./completions.js";

const originalFetch = globalThis.fetch;

const createSettings = (overrides: Partial<UserSettings>): UserSettings =>
  ({
    id: "settings-test",
    activeProvider: "openai",
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("model provider adapters", () => {
  it("calls Gemini native generateContent and parses the text response", async () => {
    let requestedUrl = "";
    let requestedBody: unknown = null;

    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Gemini reply" }]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const content = await completeChatCompletion({
      settings: createSettings({
        activeProvider: "google-gemini",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-flash"
      }),
      messages: [
        { role: "system", content: "Stay concise." },
        { role: "user", content: "Hello" }
      ]
    });

    assert.equal(
      requestedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    assert.deepEqual(requestedBody, {
      systemInstruction: { parts: [{ text: "Stay concise." }] },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: {
        temperature: 0.4,
        topP: 1,
        maxOutputTokens: 500
      }
    });
    assert.equal(content, "Gemini reply");
  });

  it("parses Anthropic streaming text deltas", async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )) as typeof fetch;

    const events = [];
    for await (const event of streamChatCompletion({
      settings: createSettings({
        activeProvider: "anthropic",
        apiBaseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-5"
      }),
      messages: [{ role: "user", content: "Hello" }],
      signal: new AbortController().signal
    })) {
      events.push(event);
    }

    assert.deepEqual(events, [
      { type: "token", content: "Hel" },
      { type: "token", content: "lo" },
      {
        type: "usage",
        usage: {
          promptTokens: 12,
          completionTokens: 2,
          totalTokens: 14,
          estimated: false
        }
      }
    ]);
  });

  it("imports Gemini listModels responses as plain model IDs", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              supportedGenerationMethods: ["generateContent"]
            },
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["embedContent"]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const result = await fetchAvailableModels(
      createSettings({
        activeProvider: "google-gemini",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta"
      })
    );

    assert.deepEqual(result.models, ["gemini-2.5-flash", "text-embedding-004"]);
  });

  it("tests model connectivity with a real chat completion request", async () => {
    const requestedUrls: string[] = [];
    let requestedBody: unknown = null;

    globalThis.fetch = (async (input, init) => {
      requestedUrls.push(String(input));
      requestedBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await testModelConnection(
      createSettings({
        activeProvider: "openai-compatible",
        apiBaseUrl: "http://localhost:1234/v1",
        model: "local-chat-model",
        temperature: 0.9,
        maxTokens: 2000
      })
    );

    assert.deepEqual(requestedUrls, ["http://localhost:1234/v1/chat/completions"]);
    assert.equal((requestedBody as { model?: string }).model, "local-chat-model");
    assert.equal((requestedBody as { max_tokens?: number }).max_tokens, 16);
    assert.equal((requestedBody as { temperature?: number }).temperature, 0);
    assert.equal(result.reachable, true);
    assert.equal(result.model, "local-chat-model");
  });
});
