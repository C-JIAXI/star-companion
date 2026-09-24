import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { generatedBuildInfo } from "../generated/buildInfo.js";
import { createMcpFetch, validateMcpUrl } from "./mcpNetwork.js";

export type McpToolSummary = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  definitionDigest: string;
};

const boundedJson = (value: unknown, maxBytes: number) => {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("MCP result exceeds the size limit");
  return encoded;
};

export const connectMcp = async (input: { url: string; bearerToken?: string | null; allowPrivateNetwork: boolean }) => {
  const endpoint = validateMcpUrl(input.url, input.allowPrivateNetwork);
  const network = createMcpFetch(endpoint, input.allowPrivateNetwork);
  const client = new Client({ name: "star-companion", version: generatedBuildInfo.appVersion }, {
    versionNegotiation: { mode: "auto" },
    supportedProtocolVersions: ["2026-07-28", "2025-11-25"]
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: network.fetch,
    ...(input.bearerToken ? { authProvider: { token: async () => input.bearerToken! } } : {})
  });
  try {
    await client.connect(transport);
    const era = client.getProtocolEra();
    if (era !== "modern" && era !== "legacy") throw new Error("MCP protocol negotiation failed");
    return {
      era,
      async listTools() {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          // The SDK auto-aggregates every page when listTools receives no cursor.
          // Read the first page directly so the 100-tool and 10-page bounds apply before more requests.
          const result = cursor === undefined
            ? await client.request({ method: "tools/list", params: {} }) as { tools: Tool[]; nextCursor?: string }
            : await client.listTools({ cursor });
          if (!Array.isArray(result.tools)) throw new Error("Invalid MCP tool list");
          tools.push(...result.tools);
          if (tools.length > 100) throw new Error("MCP tool list exceeds the limit");
          if (!result.nextCursor) break;
          if (page === 9) throw new Error("MCP tool pagination exceeds the limit");
          cursor = result.nextCursor;
        }
        return tools.map((tool) => {
          const definition = { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema, annotations: tool.annotations };
          const encoded = boundedJson(definition, 20_000);
          return { name: tool.name, description: String(tool.description ?? "").slice(0, 1000),
            inputSchema: tool.inputSchema as Record<string, unknown>, readOnlyHint: tool.annotations?.readOnlyHint === true,
            definitionDigest: createHash("sha256").update(encoded).digest("hex") };
        });
      },
      async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
        if (boundedJson(args, 16_000).length > 16_000) throw new Error("MCP tool arguments exceed the limit");
        const result = await client.callTool({ name, arguments: args }, { signal });
        return JSON.parse(boundedJson(result, 64_000)) as unknown;
      },
      async close() { await client.close(); await network.close(); }
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await network.close().catch(() => undefined);
    throw error;
  }
};
