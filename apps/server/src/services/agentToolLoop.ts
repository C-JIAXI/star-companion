import { executeAgentReadTool, type AgentReadStore } from "./agentReadTools.js";
import type { ModelToolDecision, ModelToolExchange, ModelToolResult } from "./toolProtocol.js";
import { McpOutcomeUnknown } from "./mcpRuntime.js";

export type AgentToolLoopEvent =
  | { type: "model_decision"; round: number }
  | { type: "tool_start"; round: number; callId: string; name: string }
  | { type: "tool_complete"; round: number; callId: string; name: string; isError: boolean }
  | { type: "approval_required" | "approval_resolved"; round: number; callId: string; name: string };

export const runAgentToolLoop = async (input: {
  chatId: string;
  store: AgentReadStore;
  signal?: AbortSignal;
  decide: (exchanges: ModelToolExchange[], round: number) => Promise<ModelToolDecision>;
  onEvent?: (event: AgentToolLoopEvent) => void;
  maxRounds?: number;
  maxCalls?: number;
  executeTool?: (call: ModelToolDecision["calls"][number], round: number) => Promise<Awaited<ReturnType<typeof executeAgentReadTool>>>;
}) => {
  const maxRounds = input.maxRounds ?? 8;
  const maxCalls = input.maxCalls ?? 12;
  const exchanges: ModelToolExchange[] = [];
  const sourceMessageIds = new Set<string>();
  const sourceMemoryIds = new Set<string>();
  const sourceLoreEntryIds = new Set<string>();
  const memoryVersions: Record<string, number> = {};
  const usedCallIds = new Set<string>();
  let callsUsed = 0;
  let lastText = "";
  for (let round = 1; round <= maxRounds; round += 1) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Agent task cancelled");
    input.onEvent?.({ type: "model_decision", round });
    const decision = await input.decide(exchanges, round);
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Agent task cancelled");
    lastText = decision.text;
    if (!decision.calls.length) return { content: decision.text, sourceMessageIds: [...sourceMessageIds], sourceMemoryIds: [...sourceMemoryIds], sourceLoreEntryIds: [...sourceLoreEntryIds], memoryVersions, exchanges, rounds: round, callsUsed, limitReached: false };
    if (round === maxRounds || callsUsed + decision.calls.length > maxCalls) {
      return { content: `${lastText}\n\nTool limit reached. Review the evidence found so far and explicitly continue if needed.`.trim(), sourceMessageIds: [...sourceMessageIds], sourceMemoryIds: [...sourceMemoryIds], sourceLoreEntryIds: [...sourceLoreEntryIds], memoryVersions, exchanges, rounds: round, callsUsed, limitReached: true };
    }
    const results: ModelToolResult[] = [];
    for (const call of decision.calls) {
      if (!call.id || !call.name || usedCallIds.has(call.id)) throw new Error("Invalid or duplicate model tool call ID");
      usedCallIds.add(call.id);
      callsUsed += 1;
      input.onEvent?.({ type: "tool_start", round, callId: call.id, name: call.name });
      let result: Awaited<ReturnType<typeof executeAgentReadTool>>;
      try {
        result = input.executeTool ? await input.executeTool(call, round)
          : await executeAgentReadTool({ chatId: input.chatId, call, store: input.store, signal: input.signal });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if ((error as { safe?: { code?: string } })?.safe?.code === "budget_blocked") throw error;
        if (error instanceof McpOutcomeUnknown) throw error;
        result = { content: JSON.stringify({ error: "tool_failed" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
      }
      for (const id of result.sourceMessageIds) sourceMessageIds.add(id);
      for (const id of result.sourceMemoryIds) sourceMemoryIds.add(id);
      for (const id of result.sourceLoreEntryIds ?? []) sourceLoreEntryIds.add(id);
      Object.assign(memoryVersions, result.memoryVersions ?? {});
      results.push({ id: call.id, name: call.name, content: result.content, isError: result.isError });
      input.onEvent?.({ type: "tool_complete", round, callId: call.id, name: call.name, isError: result.isError });
    }
    exchanges.push({ assistant: decision.assistant, results });
  }
  throw new Error("Agent tool loop ended without a decision");
};
