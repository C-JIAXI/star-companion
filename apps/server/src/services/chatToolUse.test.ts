import assert from "node:assert/strict";
import { it } from "node:test";
import { selectChatTools } from "./chatToolUse.js";
import type { McpModelTool } from "./mcpRuntime.js";

const external: McpModelTool = { modelName: "mcp_scene", connectionId: "connection-1", connectionName: "Scenes", endpointUrl: "https://example.com/mcp",
  tool: { name: "read-scene", description: "Read a scene", inputSchema: { type: "object" }, readOnlyHint: true,
    destructiveHint: false, definitionDigest: "a".repeat(64) },
  definition: { name: "mcp_scene", description: "Read a scene", parameters: { type: "object" } } };

it("keeps ordinary chat tools disabled by default and exposes only chat-selected definitions", () => {
  assert.deepEqual(selectChatTools(undefined, [external]).definitions, []);
  assert.deepEqual(selectChatTools({ enabled: false, toolNames: ["search_history", "connection-1:read-scene"] }, [external]).definitions, []);
  const selected = selectChatTools({ enabled: true, toolNames: ["search_history", "connection-1:read-scene", "another-chat:tool"] }, [external]);
  assert.deepEqual(selected.definitions.map((tool) => tool.name), ["search_history", "mcp_scene"]);
  const web = selectChatTools({ enabled: true, toolNames: ["web_search", "read_web_page"] }, [], true);
  assert.deepEqual(web.definitions.map((tool) => tool.name), ["web_search", "read_web_page"]);
  assert.deepEqual(selectChatTools({ enabled: true, toolNames: ["web_search", "read_web_page"] }, []).definitions.map((tool) => tool.name), ["read_web_page"]);
});
