import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatAgentDraftMessages,
  extractChatAgentActions,
  getChatAgentModeTitle,
  type ChatAgentMode
} from "./chatAgent.js";

const modes: ChatAgentMode[] = [
  "scene_summary",
  "next_steps",
  "reply_drafts",
  "memory_lore_candidates",
  "continuity_check",
  "character_consistency"
];

describe("chatAgent", () => {
  it("builds a bounded read-only prompt for every agent mode", () => {
    for (const mode of modes) {
      const messages = buildChatAgentDraftMessages(
        [
          {
            role: "system",
            content: "Character context."
          },
          {
            role: "user",
            content: "Recent user message."
          }
        ],
        mode,
        "focus text"
      );
      const systemPrompt = messages[0]?.content ?? "";

      assert.equal(messages.at(-1)?.content, "Create the requested agent draft from the context above.");
      assert.ok(getChatAgentModeTitle(mode));
      assert.match(systemPrompt, /read-only context assistant/);
      assert.match(systemPrompt, /single-user, single-character/);
      assert.match(systemPrompt, /User focus:\nfocus text/);
      assert.match(systemPrompt, /Do not .*introduce standalone lorebook\/worldbook features\./i);
      assert.doesNotMatch(systemPrompt, /create standalone lorebook/i);
      assert.doesNotMatch(systemPrompt, /group chat with/i);
    }
  });

  it("extracts only user-confirmable draft and candidate actions", () => {
    const drafts = extractChatAgentActions(
      "reply_drafts",
      "[DRAFT]Ask about the promise.[/DRAFT]\n[DRAFT]Wait and observe.[/DRAFT]"
    );
    assert.deepEqual(drafts.map((action) => action.kind), ["reply_draft", "reply_draft"]);
    assert.deepEqual(drafts.map((action) => action.content), ["Ask about the promise.", "Wait and observe."]);

    const candidates = extractChatAgentActions(
      "memory_lore_candidates",
      "[MEMORY The blue door | The user trusts the blue door. | blue door, trust]\n[LORE blue door, hinge | The door hinge always squeaks.]"
    );
    assert.deepEqual(candidates.map((action) => action.kind), ["memory_candidate", "lore_candidate"]);
    assert.deepEqual(candidates[0]?.keywords, ["blue door", "trust"]);
    assert.deepEqual(candidates[1]?.keywords, ["blue door", "hinge"]);
    assert.deepEqual(extractChatAgentActions("continuity_check", "Nothing to save."), []);
  });
});
