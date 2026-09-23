import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import type { ModelToolCall, ModelToolDefinition } from "./toolProtocol.js";
import { connectMcp, type McpToolSummary } from "./mcpClient.js";
import { requestMcpApproval } from "./mcpApprovals.js";

export type McpRuntimeConnection = {
  id: string; name: string; endpointUrl: string; allowPrivateNetwork: boolean; bearerEncrypted: string | null;
  enabled: boolean; tools: McpToolSummary[]; enabledToolNames: string[];
};
export type McpRuntimeStore = {
  list(): Promise<McpRuntimeConnection[]>;
  get(id: string): Promise<McpRuntimeConnection | null>;
  decryptToken(encrypted: string | null): string;
};
export type McpModelTool = { modelName: string; connectionId: string; connectionName: string; endpointUrl: string;
  tool: McpToolSummary; definition: ModelToolDefinition };

export class McpOutcomeUnknown extends Error {
  readonly code = "mcp_outcome_unknown";
}

const ajv = new Ajv({ allErrors: false, strict: false, validateSchema: true });
const fingerprint = (connectionId: string, name: string) => createHash("sha256").update(`${connectionId}:${name}`).digest("hex").slice(0, 20);
const getTool = (row: McpRuntimeConnection, name: string) => row.enabled && row.enabledToolNames.includes(name)
  ? row.tools.find((tool) => tool.name === name) : undefined;

export const listMcpModelTools = async (store: McpRuntimeStore): Promise<McpModelTool[]> => {
  const rows = await store.list();
  const tools: McpModelTool[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    for (const tool of row.tools) {
      if (!getTool(row, tool.name) || !tool.inputSchema || typeof tool.inputSchema !== "object") continue;
      try { ajv.compile(tool.inputSchema); } catch { continue; }
      const modelName = `mcp_${fingerprint(row.id, tool.name)}`;
      tools.push({ modelName, connectionId: row.id, connectionName: row.name, endpointUrl: row.endpointUrl, tool,
        definition: { name: modelName, description: `External MCP tool from ${row.name}: ${tool.name}. ${tool.description.slice(0, 800)}. Requires user approval before sending arguments.`,
          parameters: tool.inputSchema } });
      if (tools.length >= 20) return tools;
    }
  }
  return tools;
};

export const executeMcpModelTool = async (input: {
  chatId: string; runId: string; call: ModelToolCall; tools: McpModelTool[]; store: McpRuntimeStore;
  signal?: AbortSignal; onApprovalRequired?: () => void; onApprovalResolved?: () => void;
}) => {
  const selected = input.tools.find((tool) => tool.modelName === input.call.name);
  if (!selected || !input.call.arguments) return { content: JSON.stringify({ error: "tool_unavailable" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  const args = input.call.arguments;
  const encodedArgs = JSON.stringify(args);
  if (!encodedArgs || Buffer.byteLength(encodedArgs, "utf8") > 16_000) return { content: JSON.stringify({ error: "invalid_arguments" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  let valid = false;
  try { valid = Boolean(ajv.compile(selected.tool.inputSchema)(args)); } catch { /* invalid remote schema */ }
  if (!valid) return { content: JSON.stringify({ error: "invalid_arguments" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  const current = await input.store.get(selected.connectionId);
  const latest = current && getTool(current, selected.tool.name);
  if (!current || !latest || latest.definitionDigest !== selected.tool.definitionDigest || current.endpointUrl !== selected.endpointUrl) {
    return { content: JSON.stringify({ error: "tool_definition_changed" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  }
  const approval = await requestMcpApproval({ chatId: input.chatId, runId: input.runId, callId: input.call.id,
    connectionId: selected.connectionId, connectionName: selected.connectionName, toolName: selected.tool.name,
    endpointUrl: current.endpointUrl,
    scopeDigest: createHash("sha256").update(`${current.endpointUrl}:${current.bearerEncrypted ?? ""}`).digest("hex"),
    definitionDigest: selected.tool.definitionDigest, readOnlyHint: selected.tool.readOnlyHint,
    arguments: args, signal: input.signal, onPending: input.onApprovalRequired });
  input.onApprovalResolved?.();
  if (!approval.approved) return { content: JSON.stringify({ error: "user_denied" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  if (input.signal?.aborted) throw new Error("Agent task cancelled");
  const beforeCall = await input.store.get(selected.connectionId);
  const finalTool = beforeCall && getTool(beforeCall, selected.tool.name);
  if (!beforeCall || !finalTool || finalTool.definitionDigest !== selected.tool.definitionDigest || beforeCall.endpointUrl !== selected.endpointUrl) {
    return { content: JSON.stringify({ error: "tool_definition_changed" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true };
  }
  let connection: Awaited<ReturnType<typeof connectMcp>>;
  try {
    connection = await connectMcp({ url: beforeCall.endpointUrl, bearerToken: input.store.decryptToken(beforeCall.bearerEncrypted),
      allowPrivateNetwork: beforeCall.allowPrivateNetwork });
  } catch { return { content: JSON.stringify({ error: "connection_failed" }), sourceMessageIds: [], sourceMemoryIds: [], isError: true }; }
  try {
    const result = await connection.callTool(selected.tool.name, args, input.signal);
    const encoded = JSON.stringify(result);
    const content = encoded.length > 16_000 ? JSON.stringify({ truncated: true, excerpt: encoded.slice(0, 15_000) }) : encoded;
    return { content, sourceMessageIds: [], sourceMemoryIds: [], isError: Boolean((result as { isError?: boolean }).isError) };
  } catch {
    throw new McpOutcomeUnknown("External MCP tool result is unknown; do not replay this call automatically");
  } finally { await connection.close().catch(() => undefined); }
};
