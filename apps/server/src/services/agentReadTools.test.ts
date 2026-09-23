import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeAgentReadTool, type AgentReadStore } from "./agentReadTools.js";
import { runAgentToolLoop } from "./agentToolLoop.js";

const visibleMessage = { id: "visible-1", role: "user", content: "The brass hinge was repaired.", createdAt: "2026-01-01T00:00:00.000Z" };
const store: AgentReadStore = {
  async searchHistory({ chatId, query }) {
    assert.equal(chatId, "chat-1");
    return { messages: query === "hinge" ? [visibleMessage] : [], nextCursor: null };
  },
  async readMessages({ chatId, ids }) {
    assert.equal(chatId, "chat-1");
    return ids.includes(visibleMessage.id) ? [visibleMessage] : [];
  },
  async searchMemories({ chatId, query }) {
    assert.equal(chatId, "chat-1");
    return query === "hinge" ? [{ id: "memory-1", title: "Hinge repair", content: "The brass hinge was repaired.", keywords: ["hinge"], importance: 4, embeddingStatus: "ready", currentRevision: 7 }] : [];
  },
  async readCharacter({ chatId }) {
    assert.equal(chatId, "chat-1");
    return { name: "Keeper", description: "Keeps the gate.", visibility: "public", locked: false,
      prefix: "Speak clearly.", prompt: "Guard the gate.", suffix: "Stay alert.",
      loreEntries: [{ id: "lore-1", keys: ["hinge"], content: "The hinge is brass.", priority: 1, alwaysActive: false }] };
  }
};

describe("bounded agent read tools", () => {
  it("rejects invalid arguments before storage access", async () => {
    let calls = 0;
    const result = await executeAgentReadTool({
      chatId: "chat-1",
      call: { id: "call-1", name: "read_messages", arguments: { ids: Array.from({ length: 9 }, (_, index) => `message-${index}`) } },
      store: { ...store, searchHistory: async () => { calls++; return { messages: [], nextCursor: null }; }, readMessages: async () => { calls++; return []; }, searchMemories: async () => { calls++; return []; }, readCharacter: async () => { calls++; return null; } }
    });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  });

  it("passes only actually read message IDs into citations", async () => {
    const result = await runAgentToolLoop({
      chatId: "chat-1", store,
      decide: async (_exchanges, round) => round === 1
        ? { text: "", calls: [{ id: "call-1", name: "search_history", arguments: { query: "hinge" } }], assistant: { role: "assistant", tool_calls: [] }, usage: null }
        : round === 2
          ? { text: "", calls: [{ id: "call-2", name: "read_messages", arguments: { ids: ["visible-1", "unknown"] } }], assistant: { role: "assistant", tool_calls: [] }, usage: null }
          : { text: "The hinge was repaired. [source:visible-1]", calls: [], assistant: { role: "assistant" }, usage: null }
    });
    assert.deepEqual(result.sourceMessageIds, ["visible-1"]);
    assert.equal(result.callsUsed, 2);
  });

  it("does not execute calls beyond the task limit", async () => {
    let calls = 0;
    const result = await runAgentToolLoop({
      chatId: "chat-1", maxCalls: 0,
      store: { ...store, searchHistory: async () => { calls++; return { messages: [], nextCursor: null }; }, readMessages: async () => { calls++; return []; }, searchMemories: async () => { calls++; return []; }, readCharacter: async () => { calls++; return null; } },
      decide: async () => ({ text: "", calls: [{ id: "call-1", name: "search_history", arguments: { query: "hinge" } }], assistant: { role: "assistant" }, usage: null })
    });
    assert.equal(result.limitReached, true);
    assert.equal(calls, 0);
  });

  it("returns memory IDs only for recalled memories", async () => {
    const result = await executeAgentReadTool({ chatId: "chat-1", call: { id: "call-memory", name: "search_memories", arguments: { query: "hinge" } }, store });
    assert.equal(result.isError, false);
    assert.deepEqual(result.sourceMemoryIds, ["memory-1"]);
    assert.deepEqual(result.sourceMessageIds, []);
    assert.deepEqual(result.memoryVersions, { "memory-1": 7 });
  });

  it("reads enabled character Lore while hiding locked private fields", async () => {
    const call = { id: "call-character", name: "read_character", arguments: {} };
    const visible = await executeAgentReadTool({ chatId: "chat-1", call, store });
    assert.equal(JSON.parse(visible.content).character.loreEntries[0].id, "lore-1");
    const locked = await executeAgentReadTool({
      chatId: "chat-1", call,
      store: { ...store, readCharacter: async () => ({
        name: "Keeper", description: "secret", visibility: "private", locked: true,
        prefix: "secret", prompt: "secret", suffix: "secret", loreEntries: [{ id: "secret", keys: [], content: "secret", priority: 0, alwaysActive: true }]
      }) }
    });
    assert.deepEqual(JSON.parse(locked.content), { character: { name: "Keeper", visibility: "private", locked: true } });
  });

  it("loads an enabled Skill and a named reference without granting citations", async () => {
    const skillStore: AgentReadStore = { ...store, loadSkill: async ({ chatId, name, path }) => {
      assert.equal(chatId, "chat-1");
      if (name !== "scene-method") return null;
      return path ? path === "references/guide.md" ? { name, path, content: "Check the gate." } : null
        : { name, content: "---\nname: scene-method\n---\nSearch first.", referencePaths: ["references/guide.md"] };
    } };
    const instruction = await executeAgentReadTool({ chatId: "chat-1", call: { id: "skill-1", name: "load_skill", arguments: { name: "scene-method" } }, store: skillStore });
    assert.equal(instruction.isError, false);
    assert.deepEqual(instruction.sourceMessageIds, []);
    assert.deepEqual(instruction.sourceMemoryIds, []);
    assert.deepEqual(JSON.parse(instruction.content).referencePaths, ["references/guide.md"]);
    const reference = await executeAgentReadTool({ chatId: "chat-1", call: { id: "skill-2", name: "load_skill", arguments: { name: "scene-method", path: "references/guide.md" } }, store: skillStore });
    assert.equal(JSON.parse(reference.content).content, "Check the gate.");
    const disabled = await executeAgentReadTool({ chatId: "chat-1", call: { id: "skill-3", name: "load_skill", arguments: { name: "disabled" } }, store: skillStore });
    assert.equal(disabled.isError, true);
  });

  it("stops the task when a memory tool hits the hard budget", async () => {
    const blocked = Object.assign(new Error("budget blocked"), { safe: { code: "budget_blocked" } });
    let decisions = 0;
    await assert.rejects(runAgentToolLoop({
      chatId: "chat-1",
      store: { ...store, searchMemories: async () => { throw blocked; } },
      decide: async () => {
        decisions += 1;
        return { text: "", calls: [{ id: "budget-call", name: "search_memories", arguments: { query: "hinge" } }], assistant: { role: "assistant" }, usage: null };
      }
    }), (error) => error === blocked);
    assert.equal(decisions, 1);
  });
});
