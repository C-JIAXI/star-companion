import { agentReadToolDefinitions } from "./agentReadTools.js";
import { webToolDefinitions } from "./webTools.js";
import type { McpModelTool } from "./mcpRuntime.js";

export type ChatToolUse = { enabled: boolean; toolNames: string[] };

export const selectChatTools = (policy: ChatToolUse | undefined, mcpTools: McpModelTool[], webSearchAvailable = false) => {
  if (!policy?.enabled) return { builtins: [], external: [], definitions: [] };
  const names = new Set(policy.toolNames);
  const builtins = [...agentReadToolDefinitions, ...webToolDefinitions].filter((tool) => names.has(tool.name) && (tool.name !== "web_search" || webSearchAvailable));
  const external = mcpTools.filter((tool) => names.has(`${tool.connectionId}:${tool.tool.name}`));
  return { builtins, external, definitions: [...builtins, ...external.map((tool) => tool.definition)] };
};
