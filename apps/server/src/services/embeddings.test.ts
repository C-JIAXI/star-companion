import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { generateEmbeddings } from "./embeddings.js";

const originalFetch = globalThis.fetch;

const createSettings = (overrides: Partial<UserSettings> = {}) =>
  ({
    activeProvider: "openai-compatible",
    apiBaseUrl: "https://api.example.test/v1",
    apiKey: "",
    model: "text-embedding-3-small",
    ...overrides
  }) as UserSettings;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("embedding provider adapters", () => {
  it("calls an OpenAI-compatible embeddings endpoint with batched input", async () => {
    let requestedUrl = "";
    let requestedBody: unknown = null;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "text-embedding-3-small",
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await generateEmbeddings({
      settings: createSettings(),
      inputs: ["first", "second"],
      task: "document"
    });

    assert.equal(requestedUrl, "https://api.example.test/v1/embeddings");
    assert.deepEqual(requestedBody, {
      model: "text-embedding-3-small",
      input: ["first", "second"]
    });
    assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
  });

  it("uses Gemini retrieval task types for query embeddings", async () => {
    let requestedUrl = "";
    let requestedBody: unknown = null;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ embeddings: [{ values: [0.5, 0.5] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await generateEmbeddings({
      settings: createSettings({
        activeProvider: "google-gemini",
        apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "models/gemini-embedding-001"
      }),
      inputs: ["find the promise"],
      task: "query"
    });

    assert.equal(
      requestedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents"
    );
    assert.deepEqual(requestedBody, {
      requests: [
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "find the promise" }] },
          taskType: "RETRIEVAL_QUERY"
        }
      ]
    });
  });

  it("rejects malformed vectors instead of persisting them", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [1, "bad"] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    await assert.rejects(
      generateEmbeddings({
        settings: createSettings(),
        inputs: ["invalid"],
        task: "document"
      }),
      /invalid vector/
    );
  });
});
