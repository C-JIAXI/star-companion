import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { completeToolDecision } from "./completions.js";
import { parseModelToolDecision } from "./toolProtocol.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const settings = (activeProvider: string): UserSettings => ({
  activeProvider, apiBaseUrl: "https://model.example/v1", apiKey: "", model: "fixture-model",
  temperature: 0.3, maxTokens: 800, topP: 1
}) as UserSettings;

const tools = [{
  name: "search_history", description: "Search current chat history",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }
}];
const messages = [{ role: "user" as const, content: "Find the old blue door agreement" }];

describe("native tool protocols", () => {
  it("round-trips OpenAI tool call ids and arguments", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(bodies.length === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "search_history", arguments: '{"query":"blue door"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }
        : { choices: [{ message: { role: "assistant", content: "Found it." } }], usage: { prompt_tokens: 30, completion_tokens: 4 } }), { status: 200 });
    };
    const first = await completeToolDecision({ settings: settings("openai"), messages, tools, exchanges: [] });
    assert.deepEqual(first.calls, [{ id: "call_a", name: "search_history", arguments: { query: "blue door" } }]);
    const second = await completeToolDecision({ settings: settings("openai"), messages, tools, exchanges: [{ assistant: first.assistant, results: [{ id: "call_a", name: "search_history", content: "match-1" }] }] });
    assert.equal(second.text, "Found it.");
    assert.deepEqual((bodies[1].messages as Array<Record<string, unknown>>).at(-1), { role: "tool", tool_call_id: "call_a", content: "match-1" });
    assert.deepEqual((bodies[0].tools as Array<Record<string, unknown>>)[0].type, "function");
  });

  it("round-trips Anthropic tool_use and tool_result blocks", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(bodies.length === 1
        ? { content: [{ type: "tool_use", id: "toolu_1", name: "search_history", input: { query: "blue door" } }], usage: { input_tokens: 20, output_tokens: 8 } }
        : { content: [{ type: "text", text: "Found it." }], usage: { input_tokens: 30, output_tokens: 4 } }), { status: 200 });
    };
    const first = await completeToolDecision({ settings: settings("anthropic"), messages, tools, exchanges: [] });
    assert.deepEqual(first.calls, [{ id: "toolu_1", name: "search_history", arguments: { query: "blue door" } }]);
    await completeToolDecision({ settings: settings("anthropic"), messages, tools, exchanges: [{ assistant: first.assistant, results: [{ id: "toolu_1", name: "search_history", content: "match-1" }] }] });
    const history = bodies[1].messages as Array<Record<string, unknown>>;
    assert.deepEqual((history.at(-1)?.content as Array<Record<string, unknown>>)[0], { type: "tool_result", tool_use_id: "toolu_1", content: "match-1", is_error: false });
  });

  it("preserves Gemini function call ids and thought signatures in the returned model part", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(bodies.length === 1
        ? { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fn_1", name: "search_history", args: { query: "blue door" } }, thoughtSignature: "opaque-signature" }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 } }
        : { candidates: [{ content: { role: "model", parts: [{ text: "Found it." }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } }), { status: 200 });
    };
    const first = await completeToolDecision({ settings: settings("google-gemini"), messages, tools, exchanges: [] });
    assert.deepEqual(first.calls, [{ id: "fn_1", providerCallId: "fn_1", name: "search_history", arguments: { query: "blue door" } }]);
    await completeToolDecision({ settings: settings("google-gemini"), messages, tools, exchanges: [{ assistant: first.assistant, results: [{ id: "fn_1", name: "search_history", content: "match-1" }] }] });
    const history = bodies[1].contents as Array<Record<string, unknown>>;
    assert.deepEqual((history.at(-2)?.parts as Array<Record<string, unknown>>)[0].thoughtSignature, "opaque-signature");
    assert.deepEqual((history.at(-1)?.parts as Array<Record<string, unknown>>)[0].functionResponse, { name: "search_history", id: "fn_1", response: { result: "match-1" } });
  });

  it("keeps invalid JSON arguments non-executable", () => {
    const decision = parseModelToolDecision("openai-compatible", { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_bad", function: { name: "search_history", arguments: "not JSON" } }] } }] });
    assert.equal(decision.calls[0].arguments, null);
  });
});
