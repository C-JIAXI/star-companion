import assert from "node:assert/strict";
import { it } from "node:test";
import { clearMcpApprovals, decideMcpApproval, getPendingMcpApproval, requestMcpApproval } from "./mcpApprovals.js";

const approval = { chatId: "chat-1", runId: "run-1", callId: "call-1", connectionId: "connection-1",
  connectionName: "Scenes", endpointUrl: "https://example.com/mcp", scopeDigest: "scope-1", toolName: "read-scene", definitionDigest: "a".repeat(64), readOnlyHint: true,
  arguments: { scene: "gate" } };

it("requires the first external read approval and scopes a session grant to the same definition", async () => {
  clearMcpApprovals();
  const waiting = requestMcpApproval(approval);
  assert.deepEqual(getPendingMcpApproval("chat-1", "run-1")?.arguments, { scene: "gate" });
  assert.deepEqual(decideMcpApproval("chat-1", "run-1", "call-1", { approved: true, sessionGrant: true }), { accepted: true });
  assert.deepEqual(await waiting, { approved: true, sessionGrant: true });
  assert.deepEqual(decideMcpApproval("chat-1", "run-1", "call-1", { approved: true, sessionGrant: true }), { accepted: false });
  assert.deepEqual(await requestMcpApproval({ ...approval, callId: "call-2" }), { approved: true, sessionGrant: true });
  const changedEndpoint = requestMcpApproval({ ...approval, callId: "call-new-endpoint", scopeDigest: "scope-2" });
  assert.ok(getPendingMcpApproval("chat-1", "run-1"));
  decideMcpApproval("chat-1", "run-1", "call-new-endpoint", { approved: false, sessionGrant: false });
  assert.equal((await changedEndpoint).approved, false);
  const changed = requestMcpApproval({ ...approval, callId: "call-3", definitionDigest: "b".repeat(64) });
  assert.ok(getPendingMcpApproval("chat-1", "run-1"));
  decideMcpApproval("chat-1", "run-1", "call-3", { approved: false, sessionGrant: false });
  assert.equal((await changed).approved, false);
  clearMcpApprovals();
});

it("never stores session grants for external writes and aborts pending calls on lock", async () => {
  clearMcpApprovals();
  const write = { ...approval, runId: "write-run", callId: "write-call", readOnlyHint: false };
  const waiting = requestMcpApproval(write);
  decideMcpApproval("chat-1", "write-run", "write-call", { approved: true, sessionGrant: true });
  assert.deepEqual(await waiting, { approved: true, sessionGrant: false });
  const controller = new AbortController();
  const second = requestMcpApproval({ ...write, callId: "write-next", signal: controller.signal });
  controller.abort();
  await assert.rejects(second, /cancelled/);
  assert.equal(getPendingMcpApproval("chat-1", "write-run"), null);
  clearMcpApprovals();
});
