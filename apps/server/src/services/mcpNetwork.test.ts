import assert from "node:assert/strict";
import { it } from "node:test";
import { validateMcpAddress, validateMcpUrl } from "./mcpNetwork.js";

it("MCP URL policy requires explicit private access and rejects embedded credentials", () => {
  assert.equal(validateMcpUrl("https://example.com/mcp", false).pathname, "/mcp");
  assert.equal(validateMcpUrl("http://localhost:9000/mcp", true).hostname, "localhost");
  assert.throws(() => validateMcpUrl("http://example.com/mcp", false));
  assert.throws(() => validateMcpUrl("https://user:token@example.com/mcp", false));
  assert.throws(() => validateMcpUrl("https://example.com/mcp?token=secret", false));
});

it("MCP DNS policy blocks cloud metadata, loopback, and private addresses unless explicitly allowed", () => {
  assert.doesNotThrow(() => validateMcpAddress("8.8.8.8", false, "https:"));
  assert.throws(() => validateMcpAddress("8.8.8.8", true, "http:"));
  assert.throws(() => validateMcpAddress("127.0.0.1", false, "https:"));
  assert.doesNotThrow(() => validateMcpAddress("127.0.0.1", true, "http:"));
  assert.doesNotThrow(() => validateMcpAddress("192.168.1.5", true, "http:"));
  assert.throws(() => validateMcpAddress("169.254.169.254", true, "http:"));
  assert.throws(() => validateMcpAddress("::", true, "https:"));
  assert.throws(() => validateMcpAddress("::ffff:169.254.169.254", true, "http:"));
});
