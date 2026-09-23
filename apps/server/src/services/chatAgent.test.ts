import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatAgentDraftMessages,
  extractChatAgentActions,
  getChatAgentModeTitle,
  readVerifiedAgentMemoryIds,
  readVerifiedAgentSourceIds,
  type ChatAgentMode
} from "./chatAgent.js";
import { parseAgentStructuredOutput } from "./agentStructuredOutput.js";

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
        "focus text",
        ["message-1"]
      );
      const systemPrompt = messages[0]?.content ?? "";

      assert.match(messages.at(-1)?.content ?? "", /Create the requested agent draft from the reference data above\./);
      assert.ok(getChatAgentModeTitle(mode));
      assert.match(systemPrompt, /read-only context assistant/);
      assert.match(systemPrompt, /single-user, single-character/);
      assert.doesNotMatch(systemPrompt, /Character context|focus text/);
      assert.match(messages.at(-1)?.content ?? "", /User focus:\nfocus text/);
      assert.match(messages.at(-1)?.content ?? "", /"sourceId":"message-1"/);
      assert.match(systemPrompt, /Do not .*introduce standalone lorebook\/worldbook features\./i);
      assert.doesNotMatch(systemPrompt, /create standalone lorebook/i);
      assert.doesNotMatch(systemPrompt, /group chat with/i);
    }
  });

  it("extracts only user-confirmable draft and candidate actions", () => {
    const drafts = extractChatAgentActions(
      "reply_drafts",
      JSON.stringify({ answer: "Two options", candidates: [
        { kind: "reply_draft", title: "Ask", content: "Ask about the promise." },
        { kind: "reply_draft", title: "Wait", content: "Wait and observe." }
      ] })
    );
    assert.deepEqual(drafts.map((action) => action.kind), ["reply_draft", "reply_draft"]);
    assert.deepEqual(drafts.map((action) => action.content), ["Ask about the promise.", "Wait and observe."]);

    const candidates = extractChatAgentActions(
      "memory_lore_candidates",
      JSON.stringify({ answer: "Two candidates", candidates: [
        { kind: "memory_candidate", title: "The blue door", content: "The user trusts the blue door.", keywords: ["blue door", "trust"] },
        { kind: "lore_candidate", title: "Blue door", content: "The door hinge always squeaks.", keywords: ["blue door", "hinge"] }
      ] })
    );
    assert.deepEqual(candidates.map((action) => action.kind), ["memory_candidate", "lore_candidate"]);
    assert.deepEqual(candidates[0]?.keywords, ["blue door", "trust"]);
    assert.deepEqual(candidates[1]?.keywords, ["blue door", "hinge"]);
    assert.deepEqual(extractChatAgentActions("continuity_check", "Nothing to save."), []);
  });

  it("attributes each candidate only to valid citations inside its content", () => {
    const actions = extractChatAgentActions(
      "memory_lore_candidates",
      JSON.stringify({ answer: "Promise", candidates: [
        { kind: "memory_candidate", title: "Promise", content: "The promise was made.", keywords: ["promise"], sourceMessageIds: ["message-1", "other-chat"], sourceMemoryIds: ["memory-1", "disabled"] },
        { kind: "lore_candidate", title: "Promise", content: "The promise matters.", keywords: ["promise"], sourceMessageIds: ["message-2"] }
      ] }),
      ["message-1", "message-2"],
      ["memory-1"]
    );
    assert.deepEqual(actions.map((action) => action.sourceMessageIds), [["message-1"], ["message-2"]]);
    assert.deepEqual(actions.map((action) => action.sourceMemoryIds), [["memory-1"], []]);
    assert.deepEqual(actions.map((action) => action.content), ["The promise was made.", "The promise matters."]);
    assert.deepEqual(readVerifiedAgentSourceIds("[source:other-chat] [source:message-1]", ["message-1"]), ["message-1"]);
    assert.deepEqual(readVerifiedAgentMemoryIds("[memory:disabled] [memory:memory-1]", ["memory-1"]), ["memory-1"]);
    assert.deepEqual(extractChatAgentActions("memory_lore_candidates", "[MEMORY Forged | Save me | forged]"), []);
  });

  it("only accepts memory mutation targets from read memories", () => {
    const actions = extractChatAgentActions("memory_lore_candidates", JSON.stringify({ answer: "Merge duplicates", candidates: [
      { kind: "memory_candidate", memoryAction: "merge", targetMemoryIds: ["memory-a", "memory-b"], title: "Merged", content: "One fact", keywords: [] },
      { kind: "memory_candidate", memoryAction: "disable", targetMemoryIds: ["foreign"], title: "Bad", content: "Cannot touch", keywords: [] },
      { kind: "memory_candidate", memoryAction: "merge", targetMemoryIds: ["memory-a", "memory-a"], title: "Duplicate", content: "Same ID", keywords: [] }
    ] }), [], ["memory-a", "memory-b"]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.memoryAction, "merge");
    assert.deepEqual(actions[0]?.targetMemoryIds, ["memory-a", "memory-b"]);
  });

  it("only accepts Lore updates targeting an exposed embedded entry", () => {
    const raw = JSON.stringify({ answer: "Revise the gate", candidates: [
      { kind: "lore_candidate", loreAction: "update", targetLoreEntryId: "lore-visible", title: "Gate", content: "The gate is blue.", keywords: ["gate"] },
      { kind: "lore_candidate", loreAction: "update", targetLoreEntryId: "lore-hidden", title: "Hidden", content: "Do not touch.", keywords: ["hidden"] }
    ] });
    const result = parseAgentStructuredOutput("memory_lore_candidates", raw, [], [], ["lore-visible"]);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.targetLoreEntryId, "lore-visible");
  });
});
