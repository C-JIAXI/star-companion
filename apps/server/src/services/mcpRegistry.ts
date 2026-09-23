import { randomUUID } from "node:crypto";
import type { McpConnection, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { decryptApiKey, encryptApiKey } from "./apiKeyVault.js";
import { connectMcp, type McpToolSummary } from "./mcpClient.js";
import { validateMcpUrl } from "./mcpNetwork.js";

const jsonTools = (value: Prisma.JsonValue): McpToolSummary[] => Array.isArray(value)
  ? value.filter((item) => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof item.name === "string" && typeof item.definitionDigest === "string")) as McpToolSummary[] : [];
const jsonNames = (value: Prisma.JsonValue): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const summary = (row: McpConnection) => ({ id: row.id, name: row.name, endpointUrl: row.endpointUrl,
  allowPrivateNetwork: row.allowPrivateNetwork, hasBearerToken: Boolean(row.bearerEncrypted), enabled: row.enabled,
  tools: jsonTools(row.toolDefinitions).map((tool) => ({ ...tool, enabled: jsonNames(row.enabledToolNames).includes(tool.name) })),
  version: row.version, lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() });

export const listMcpConnections = async () => (await prisma.mcpConnection.findMany({ orderBy: { name: "asc" } })).map(summary);

export const createMcpConnection = async (input: { name: string; endpointUrl: string; allowPrivateNetwork: boolean; bearerToken?: string }) => {
  validateMcpUrl(input.endpointUrl, input.allowPrivateNetwork);
  if (await prisma.mcpConnection.findUnique({ where: { name: input.name }, select: { id: true } })) throw new HttpError(409, "MCP name already exists");
  const row = await prisma.mcpConnection.create({ data: {
    id: randomUUID(), name: input.name, endpointUrl: input.endpointUrl,
    allowPrivateNetwork: input.allowPrivateNetwork, bearerEncrypted: encryptApiKey(input.bearerToken)
  } });
  return summary(row);
};

export const updateMcpConnection = async (id: string, input: { expectedVersion: number; name?: string; endpointUrl?: string; allowPrivateNetwork?: boolean; bearerToken?: string | null; enabled?: boolean }) => {
  return prisma.$transaction(async (tx) => {
    const current = await tx.mcpConnection.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "MCP connection not found");
    if (current.version !== input.expectedVersion) throw new HttpError(409, "MCP connection changed");
    const endpointUrl = input.endpointUrl ?? current.endpointUrl;
    const allowPrivateNetwork = input.allowPrivateNetwork ?? current.allowPrivateNetwork;
    validateMcpUrl(endpointUrl, allowPrivateNetwork);
    const connectionChanged = endpointUrl !== current.endpointUrl || allowPrivateNetwork !== current.allowPrivateNetwork || input.bearerToken !== undefined;
    const row = await tx.mcpConnection.update({ where: { id, version: current.version }, data: {
      name: input.name ?? current.name, endpointUrl, allowPrivateNetwork,
      bearerEncrypted: input.bearerToken === undefined ? current.bearerEncrypted : encryptApiKey(input.bearerToken),
      enabled: connectionChanged ? false : input.enabled ?? current.enabled,
      ...(connectionChanged ? { toolDefinitions: [], enabledToolNames: [], lastCheckedAt: null } : {}),
      version: { increment: 1 }
    } });
    return summary(row);
  });
};

export const checkMcpConnection = async (id: string, expectedVersion: number) => {
  const row = await prisma.mcpConnection.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, "MCP connection not found");
  if (row.version !== expectedVersion) throw new HttpError(409, "MCP connection changed");
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let tools: McpToolSummary[];
  let protocolEra: string;
  try {
    connection = await connectMcp({ url: row.endpointUrl, bearerToken: decryptApiKey(row.bearerEncrypted), allowPrivateNetwork: row.allowPrivateNetwork });
    protocolEra = connection.era;
    tools = await connection.listTools();
  } catch {
    throw new HttpError(502, "MCP connection check failed");
  } finally { await connection?.close().catch(() => undefined); }
  const old = new Map(jsonTools(row.toolDefinitions).map((tool) => [tool.name, tool.definitionDigest]));
  const enabled = jsonNames(row.enabledToolNames).filter((name) => tools.some((tool) => tool.name === name && old.get(name) === tool.definitionDigest));
  const updated = await prisma.mcpConnection.update({ where: { id, version: row.version }, data: {
    toolDefinitions: tools as unknown as Prisma.InputJsonValue,
    enabledToolNames: enabled as Prisma.InputJsonValue,
    lastCheckedAt: new Date(), version: { increment: 1 }
  } });
  return { ...summary(updated), protocolEra };
};

export const setMcpToolEnabled = async (id: string, input: { expectedVersion: number; toolName: string; definitionDigest: string; enabled: boolean }) => {
  return prisma.$transaction(async (tx) => {
    const current = await tx.mcpConnection.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "MCP connection not found");
    if (current.version !== input.expectedVersion) throw new HttpError(409, "MCP connection changed");
    const tool = jsonTools(current.toolDefinitions).find((item) => item.name === input.toolName);
    if (!tool || tool.definitionDigest !== input.definitionDigest) throw new HttpError(409, "MCP tool definition changed");
    const names = new Set(jsonNames(current.enabledToolNames));
    if (input.enabled) names.add(input.toolName); else names.delete(input.toolName);
    const updated = await tx.mcpConnection.update({ where: { id, version: current.version }, data: { enabledToolNames: [...names], version: { increment: 1 } } });
    return summary(updated);
  });
};

export const deleteMcpConnection = async (id: string, expectedVersion: number) => {
  const removed = await prisma.mcpConnection.deleteMany({ where: { id, version: expectedVersion } });
  if (!removed.count) throw new HttpError(409, "MCP connection changed or missing");
  return { deleted: true };
};
