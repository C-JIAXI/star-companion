import type { AgentToolLoopEvent } from "./agentToolLoop.js";

export type AgentRunEvent = {
  type: "agent_event";
  chatId: string;
  runId: string;
  seq: number;
  phase: "started" | "context_start" | "context_complete" | "model_decision" | "tool_start" | "tool_complete" | "approval_required" | "approval_resolved" | "succeeded" | "failed" | "cancelled";
  round?: number;
  toolName?: string;
  isError?: boolean;
};

type RunState = { chatId: string; seq: number; events: AgentRunEvent[]; listeners: Set<(event: AgentRunEvent) => void>; timer?: NodeJS.Timeout };
const runs = new Map<string, RunState>();
const maxRunStates = 100;

const keyFor = (chatId: string, runId: string) => `${chatId}:${runId}`;
const stateFor = (chatId: string, runId: string) => {
  const key = keyFor(chatId, runId);
  let state = runs.get(key);
  if (!state) {
    if (runs.size >= maxRunStates) {
      const oldest = runs.keys().next().value;
      if (oldest) { const old = runs.get(oldest); if (old?.timer) clearTimeout(old.timer); runs.delete(oldest); }
    }
    state = { chatId, seq: 0, events: [], listeners: new Set() };
    runs.set(key, state);
  }
  return state;
};

export const emitAgentRunEvent = (chatId: string, runId: string, phase: AgentRunEvent["phase"], details: Partial<Pick<AgentRunEvent, "round" | "toolName" | "isError">> = {}) => {
  const state = stateFor(chatId, runId);
  const event: AgentRunEvent = { type: "agent_event", chatId, runId, seq: ++state.seq, phase, ...details };
  state.events.push(event);
  if (state.events.length > 100) state.events.shift();
  for (const listener of state.listeners) listener(event);
  if (["succeeded", "failed", "cancelled"].includes(phase)) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => runs.delete(keyFor(chatId, runId)), 5 * 60 * 1000);
    state.timer.unref();
  }
  return event;
};

export const emitAgentToolEvent = (chatId: string, runId: string, event: AgentToolLoopEvent) =>
  emitAgentRunEvent(chatId, runId, event.type, {
    round: event.round,
    ...(event.type === "model_decision" ? {} : { toolName: event.name }),
    ...(event.type === "tool_complete" ? { isError: event.isError } : {})
  });

export const subscribeAgentRunEvents = (chatId: string, runId: string, afterSeq: number, listener: (event: AgentRunEvent) => void) => {
  const state = stateFor(chatId, runId);
  state.listeners.add(listener);
  for (const event of state.events) if (event.seq > afterSeq) listener(event);
  return () => state.listeners.delete(listener);
};

export const getAgentRunEventSequence = (chatId: string, runId: string) => runs.get(keyFor(chatId, runId))?.seq ?? 0;

export const clearAgentRunEvents = () => {
  for (const state of runs.values()) if (state.timer) clearTimeout(state.timer);
  runs.clear();
};
