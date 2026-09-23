import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { it } from "node:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { prisma } from "../db.js";
import { checkMcpConnection, createMcpConnection, deleteMcpConnection, listMcpConnections, setMcpToolEnabled } from "./mcpRegistry.js";

it("MCP discovery keeps the token private and revokes a changed tool definition", async () => {
  let description = "Read the gate";
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "registry-test", version: "1.0.0" });
    server.registerTool("read-gate", { description, inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "blue gate" }] }));
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const http = createServer((request, response) => { void nodeHandler(request, response); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  let id: string | undefined;
  try {
    const created = await createMcpConnection({ name: `registry-test-${Date.now()}`, endpointUrl: `http://127.0.0.1:${address.port}/mcp`,
      allowPrivateNetwork: true, bearerToken: "registry-test-secret" });
    id = created.id;
    assert.equal(created.hasBearerToken, true);
    assert.equal(JSON.stringify(await listMcpConnections()).includes("registry-test-secret"), false);
    const checked = await checkMcpConnection(id, created.version);
    assert.equal(checked.protocolEra, "modern");
    assert.equal(checked.tools[0].enabled, false);
    const enabled = await setMcpToolEnabled(id, { expectedVersion: checked.version, toolName: "read-gate",
      definitionDigest: checked.tools[0].definitionDigest, enabled: true });
    assert.equal(enabled.tools[0].enabled, true);
    description = "Read the changed gate";
    const changed = await checkMcpConnection(id, enabled.version);
    assert.equal(changed.tools[0].enabled, false);
    assert.notEqual(changed.tools[0].definitionDigest, checked.tools[0].definitionDigest);
    await assert.rejects(setMcpToolEnabled(id, { expectedVersion: changed.version, toolName: "read-gate",
      definitionDigest: checked.tools[0].definitionDigest, enabled: true }), /definition changed/);
    await deleteMcpConnection(id, changed.version);
    id = undefined;
  } finally {
    if (id) await prisma.mcpConnection.deleteMany({ where: { id } });
    http.close();
    await once(http, "close");
  }
});
