import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCharacterDraftMessages, parseCharacterDraftItems, type CharacterDraftRequest } from "./characterDraftProtocol.js";

const request = (task: CharacterDraftRequest["task"]): CharacterDraftRequest => ({ requestId: "draft-test", task, brief: "creator points", draft: { name: "Original", description: "Description", prefix: "Prefix secret", prompt: "Prompt text", suffix: "Suffix secret", loreEntries: [{ keys: ["key"], content: "Lore secret", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true }], quickReplies: [{ label: "Hello", content: "Content secret" }] } });

describe("character drafting protocol", () => {
  it("sends only minimal fields for core generation", () => {
    const payload = JSON.parse(buildCharacterDraftMessages(request("generate_core_prompt"))[1].content);
    assert.deepEqual(Object.keys(payload), ["name", "description", "brief"]);
    assert.equal(JSON.stringify(payload).includes("Prefix secret"), false);
    assert.equal(JSON.stringify(payload).includes("Content secret"), false);
  });
  it("uses only prompt and existing labels for quick replies", () => {
    const payload = JSON.parse(buildCharacterDraftMessages(request("suggest_quick_replies"))[1].content);
    assert.deepEqual(Object.keys(payload), ["prompt", "existingLabels", "brief"]);
    assert.equal(JSON.stringify(payload).includes("Lore secret"), false);
  });
  it("parses structured prompt, lore, and quick-reply drafts", () => {
    const items = parseCharacterDraftItems(JSON.stringify({ items: [{ field: "prompt", title: "Core", suggestion: "New prompt" }, { field: "loreEntries", title: "Lore", suggestion: "Lore", loreEntry: { keys: ["alpha"], content: "Lore", scope: "prompt", triggerMode: "both" } }, { field: "quickReplies", title: "Reply", suggestion: "Hi", quickReply: { label: "Hello", content: "Hi" } }] }));
    assert.equal(items.length, 3); assert.equal(items[1].loreEntry?.keys[0], "alpha"); assert.equal(items[2].quickReply?.content, "Hi");
  });
  it("rejects malformed or empty model output", () => {
    assert.throws(() => parseCharacterDraftItems("not json"));
    assert.throws(() => parseCharacterDraftItems('{"items":[]}'));
  });
});
