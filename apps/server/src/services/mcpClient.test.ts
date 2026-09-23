import assert from "node:assert/strict";
import { createServer } from "node:http";
import { it } from "node:test";
import { once } from "node:events";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { connectMcp } from "./mcpClient.js";

it("negotiates modern Streamable HTTP and completes a bounded tool call", async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "scene-test", version: "1.0.0" });
    server.registerTool("echo-scene", {
      description: "Echo a fictional scene label", inputSchema: z.object({ label: z.string() }),
      annotations: { readOnlyHint: true }
    }, async ({ label }) => ({ content: [{ type: "text", text: label }] }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((request, response) => { void nodeHandler(request, response); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  try {
    await assert.rejects(connectMcp({ url, allowPrivateNetwork: false }));
    const connection = await connectMcp({ url, allowPrivateNetwork: true });
    try {
      assert.equal(connection.era, "modern");
      const tools = await connection.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "echo-scene");
      assert.equal(tools[0].readOnlyHint, true);
      const result = await connection.callTool("echo-scene", { label: "blue gate" });
      assert.deepEqual((result as { content: unknown }).content, [{ type: "text", text: "blue gate" }]);
    } finally { await connection.close(); }
  } finally {
    http.close();
    await once(http, "close");
  }
});

it("falls back to the 2025 session protocol when discovery is unavailable", async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "legacy-scene-test", version: "1.0.0" });
    server.registerTool("read-scene", { description: "Read a scene", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "old gate" }] }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((request, response) => {
    if (request.headers["mcp-method"] === "server/discover") { response.writeHead(404).end(); return; }
    void nodeHandler(request, response);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  try {
    const connection = await connectMcp({ url: `http://127.0.0.1:${address.port}/mcp`, allowPrivateNetwork: true });
    try {
      assert.equal(connection.era, "legacy");
      assert.equal((await connection.listTools())[0].name, "read-scene");
    } finally { await connection.close(); }
  } finally {
    http.close();
    await once(http, "close");
  }
});
