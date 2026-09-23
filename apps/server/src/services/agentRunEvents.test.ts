import assert from "node:assert/strict";
import { it } from "node:test";
import { clearAgentRunEvents, emitAgentRunEvent, subscribeAgentRunEvents } from "./agentRunEvents.js";

it("replays only later Agent events with stable run sequence numbers", () => {
  clearAgentRunEvents();
  const chatId = "chat-events";
  const runId = "00000000-0000-4000-8000-000000000001";
  assert.equal(emitAgentRunEvent(chatId, runId, "started").seq, 1);
  assert.equal(emitAgentRunEvent(chatId, runId, "context_start").seq, 2);
  const seen: number[] = [];
  const unsubscribe = subscribeAgentRunEvents(chatId, runId, 1, (event) => seen.push(event.seq));
  emitAgentRunEvent(chatId, runId, "context_complete");
  unsubscribe();
  emitAgentRunEvent(chatId, runId, "succeeded");
  assert.deepEqual(seen, [2, 3]);
  clearAgentRunEvents();
});
