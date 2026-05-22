import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUserProfileSummaryMessages,
  trimUserProfileSummary
} from "./userProfileMemory.js";

describe("user profile memory helpers", () => {
  it("builds a summary prompt with privacy constraints and recent user messages", () => {
    const messages = buildUserProfileSummaryMessages("Prefers concise answers.", [
      "Call me Lin.",
      "I like direct technical explanations."
    ]);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /Do not include API keys/);
    assert.match(messages[0].content, /unsupported guesses/);
    assert.equal(messages[1].role, "user");
    assert.match(messages[1].content, /Existing user profile:\nPrefers concise answers\./);
    assert.match(messages[1].content, /1\. Call me Lin\./);
    assert.match(messages[1].content, /2\. I like direct technical explanations\./);
  });

  it("trims whitespace and caps stored summaries", () => {
    const summary = trimUserProfileSummary(`  ${"a".repeat(1900)}  `);

    assert.equal(summary.length, 1800);
    assert.equal(summary, "a".repeat(1800));
  });
});
