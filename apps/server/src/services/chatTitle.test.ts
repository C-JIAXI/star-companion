import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatTitleSuggestionMessages,
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
});
