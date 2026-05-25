import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBody } from "./lib/http.js";
import { characterPageQuerySchema, chatUpdateSchema, settingsUpdateSchema } from "./schemas.js";

describe("chatUpdateSchema", () => {
  it("does not inject create-time defaults into partial chat updates", () => {
    const parsed = parseBody(chatUpdateSchema, { userPersona: "Roleplay as an engineer." });

    assert.deepEqual(parsed, {
      userPersona: "Roleplay as an engineer."
    });
    assert.equal("characterIds" in parsed, false);
    assert.equal("memoryTurns" in parsed, false);
    assert.equal("userProfileSummary" in parsed, false);
  });
});

describe("settingsUpdateSchema", () => {
  it("accepts showMessageAvatars in settings payloads", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      models: [],
      showMessageAvatars: false
    });

    assert.equal(parsed.showMessageAvatars, false);
  });
});

describe("characterPageQuerySchema", () => {
  it("normalizes defaults and clamps page size", () => {
    assert.deepEqual(parseBody(characterPageQuerySchema, {}), {
      q: "",
      page: 1,
      pageSize: 40
    });

    assert.deepEqual(parseBody(characterPageQuerySchema, { q: "  pilot  ", page: "2", pageSize: "500" }), {
      q: "pilot",
      page: 2,
      pageSize: 100
    });
  });
});
