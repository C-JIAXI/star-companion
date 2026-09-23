import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { clearMcpApprovals, decideMcpApproval, getPendingMcpApproval } from "./mcpApprovals.js";
import { executeMcpModelTool, listMcpModelTools, McpOutcomeUnknown, type McpRuntimeConnection } from "./mcpRuntime.js";
import { normalizeModelError } from "./modelErrors.js";

it("requires approval, denies without execution, and executes a confirmed MCP tool only once", async () => {
  clearMcpApprovals();
  let invoked = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "approval-test", version: "1.0.0" });
    server.registerTool("read-scene", { description: "Read a scene", inputSchema: z.object({ scene: z.string() }),
      annotations: { readOnlyHint: true } }, async ({ scene }) => {
      invoked += 1;
      return { content: [{ type: "text", text: scene }] };
    });
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((request, response) => { void nodeHandler(request, response); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const row: McpRuntimeConnection = { id: "connection-1", name: "Scenes", endpointUrl: `http://127.0.0.1:${address.port}/mcp`,
    allowPrivateNetwork: true, bearerEncrypted: null, enabled: true, enabledToolNames: ["read-scene"],
    tools: [{ name: "read-scene", description: "Read a scene", inputSchema: { type: "object", properties: { scene: { type: "string" } }, required: ["scene"], additionalProperties: false },
      readOnlyHint: true, destructiveHint: false, definitionDigest: "a".repeat(64) }] };
  const store = { async list() { return [row]; }, async get() { return row; }, decryptToken() { return ""; } };
  try {
    const tools = await listMcpModelTools(store);
    assert.equal(tools.length, 1);
    const call = (id: string) => ({ id, name: tools[0].modelName, arguments: { scene: "blue gate" } });
    let notifyPending!: () => void;
    const pending = new Promise<void>((resolve) => { notifyPending = resolve; });
    const denied = executeMcpModelTool({ chatId: "chat-1", runId: "run-1", call: call("deny"), tools, store, onApprovalRequired: notifyPending });
    await Promise.race([pending, denied.then((result) => { throw new Error(`No approval requested: ${result.content}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Approval was not requested")), 2_000))]);
    assert.ok(getPendingMcpApproval("chat-1", "run-1"));
    assert.deepEqual(decideMcpApproval("chat-1", "run-1", "deny", { approved: false, sessionGrant: false }), { accepted: true });
    assert.equal((await denied).isError, true);
    assert.equal(invoked, 0);
    let notifySecond!: () => void;
    const secondPending = new Promise<void>((resolve) => { notifySecond = resolve; });
    const approved = executeMcpModelTool({ chatId: "chat-1", runId: "run-1", call: call("allow"), tools, store, onApprovalRequired: notifySecond });
    await Promise.race([secondPending, approved.then((result) => { throw new Error(`No approval requested: ${result.content}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Approval was not requested")), 2_000))]);
    assert.deepEqual(decideMcpApproval("chat-1", "run-1", "allow", { approved: true, sessionGrant: false }), { accepted: true });
    assert.equal((await approved).isError, false);
    assert.equal(invoked, 1);
    assert.deepEqual(decideMcpApproval("chat-1", "run-1", "allow", { approved: true, sessionGrant: false }), { accepted: false });
    row.tools = [{ ...row.tools[0], definitionDigest: "b".repeat(64) }];
    const stale = await executeMcpModelTool({ chatId: "chat-1", runId: "run-1", call: call("stale"), tools, store });
    assert.match(stale.content, /tool_definition_changed/);
    assert.equal(invoked, 1);
  } finally {
    clearMcpApprovals();
    http.closeAllConnections();
    http.close();
    await once(http, "close");
  }
});

it("marks uncertain external results as non-retryable", () => {
  const error = normalizeModelError(new McpOutcomeUnknown("unknown"), { provider: "openai-compatible", modelId: "test" });
  assert.equal(error.safe.code, "mcp_outcome_unknown");
  assert.equal(error.safe.retryable, false);
});
