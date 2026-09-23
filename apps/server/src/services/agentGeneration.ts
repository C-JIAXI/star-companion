import type { ChatAgentMode } from "./chatAgent.js";

export type AgentGenerationOptions = { temperature: number; maxTokens: number };

const AGENT_GENERATION_DEFAULTS: Record<ChatAgentMode, AgentGenerationOptions> = {
  scene_summary: { temperature: 0.2, maxTokens: 1400 },
  next_steps: { temperature: 0.6, maxTokens: 1400 },
  reply_drafts: { temperature: 0.8, maxTokens: 1800 },
  memory_lore_candidates: { temperature: 0.3, maxTokens: 1600 },
  continuity_check: { temperature: 0.1, maxTokens: 1800 },
  character_consistency: { temperature: 0.2, maxTokens: 1600 }
};

export const resolveAgentGeneration = (
  mode: ChatAgentMode,
  override?: Partial<AgentGenerationOptions>
): AgentGenerationOptions => ({ ...AGENT_GENERATION_DEFAULTS[mode], ...override });
