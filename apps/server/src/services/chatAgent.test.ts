import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatAgentDraftMessages,
  getChatAgentModeTitle,
  type ChatAgentMode
} from "./chatAgent.js";

const modes: ChatAgentMode[] = [
  "scene_summary",
  "next_steps",
  "reply_drafts",
  "memory_lore_candidates"
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
});
