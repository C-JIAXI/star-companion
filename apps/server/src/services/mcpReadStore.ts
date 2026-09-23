import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { decryptApiKey } from "./apiKeyVault.js";
import type { McpToolSummary } from "./mcpClient.js";
import type { McpRuntimeStore } from "./mcpRuntime.js";

const names = (value: Prisma.JsonValue): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const tools = (value: Prisma.JsonValue): McpToolSummary[] => Array.isArray(value) ? value as McpToolSummary[] : [];
const mapRow = (row: { id: string; name: string; endpointUrl: string; allowPrivateNetwork: boolean;
  bearerEncrypted: string | null; enabled: boolean; toolDefinitions: Prisma.JsonValue; enabledToolNames: Prisma.JsonValue }) => ({
  id: row.id, name: row.name, endpointUrl: row.endpointUrl, allowPrivateNetwork: row.allowPrivateNetwork,
  bearerEncrypted: row.bearerEncrypted, enabled: row.enabled,
  tools: tools(row.toolDefinitions), enabledToolNames: names(row.enabledToolNames)
});

export const desktopMcpRuntimeStore: McpRuntimeStore = {
  async list() { return (await prisma.mcpConnection.findMany({ where: { enabled: true }, orderBy: { name: "asc" } })).map(mapRow); },
  async get(id) { const row = await prisma.mcpConnection.findUnique({ where: { id } }); return row ? mapRow(row) : null; },
  decryptToken: (encrypted) => decryptApiKey(encrypted)
};
