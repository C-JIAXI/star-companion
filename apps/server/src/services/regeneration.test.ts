import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRegenerationGuidanceMessage } from "./regeneration.js";

describe("guided regeneration", () => {
  it("keeps the original response and one-time guidance in a user message", () => {
    const message = buildRegenerationGuidanceMessage({
      originalResponse: "She agrees immediately.",
      guidance: "Keep the decision unresolved and make the tone more restrained."
    });

    assert.equal(message.role, "user");
    assert.match(message.content, /She agrees immediately\./);
    assert.match(message.content, /Keep the decision unresolved/);
    assert.match(message.content, /Return only the replacement assistant response/);
  });
});
