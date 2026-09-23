export type PendingMcpApproval = {
  chatId: string;
  runId: string;
  callId: string;
  connectionId: string;
  connectionName: string;
  endpointUrl: string;
  toolName: string;
  definitionDigest: string;
  readOnlyHint: boolean;
  arguments: Record<string, unknown>;
  createdAt: string;
};

type PendingRecord = { view: PendingMcpApproval; scopeDigest: string; resolve: (value: { approved: boolean; sessionGrant: boolean }) => void;
  reject: (error: Error) => void; timer: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void };
const pending = new Map<string, PendingRecord>();
const grants = new Set<string>();
const keyFor = (chatId: string, runId: string, callId: string) => `${chatId}:${runId}:${callId}`;
const grantFor = (chatId: string, connectionId: string, toolName: string, digest: string, scopeDigest: string) => `${chatId}:${connectionId}:${toolName}:${digest}:${scopeDigest}`;

export const getPendingMcpApproval = (chatId: string, runId: string) =>
  [...pending.values()].find((record) => record.view.chatId === chatId && record.view.runId === runId)?.view ?? null;

export const requestMcpApproval = (input: Omit<PendingMcpApproval, "createdAt"> & { scopeDigest: string; signal?: AbortSignal; onPending?: () => void }) => {
  if (input.signal?.aborted) return Promise.reject(new Error("Agent task cancelled"));
  if (input.readOnlyHint && grants.has(grantFor(input.chatId, input.connectionId, input.toolName, input.definitionDigest, input.scopeDigest))) {
    return Promise.resolve({ approved: true, sessionGrant: true });
  }
  const key = keyFor(input.chatId, input.runId, input.callId);
  if (pending.has(key) || pending.size >= 100) return Promise.reject(new Error("MCP approval capacity reached"));
  return new Promise<{ approved: boolean; sessionGrant: boolean }>((resolve, reject) => {
    const { signal, onPending, scopeDigest, ...data } = input;
    const view: PendingMcpApproval = { ...data, createdAt: new Date().toISOString() };
    const cleanup = () => {
      const record = pending.get(key);
      if (record?.timer) clearTimeout(record.timer);
      if (record?.signal && record.onAbort) record.signal.removeEventListener("abort", record.onAbort);
      pending.delete(key);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("MCP approval expired")); }, 10 * 60 * 1000);
    timer.unref();
    const onAbort = () => { cleanup(); reject(new Error("Agent task cancelled")); };
    pending.set(key, { view, scopeDigest, resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); }, timer, signal, onAbort });
    signal?.addEventListener("abort", onAbort, { once: true });
    onPending?.();
  });
};

export const decideMcpApproval = (chatId: string, runId: string, callId: string, decision: { approved: boolean; sessionGrant: boolean }) => {
  const record = pending.get(keyFor(chatId, runId, callId));
  if (!record) return { accepted: false };
  if (decision.approved && decision.sessionGrant && record.view.readOnlyHint) {
    grants.add(grantFor(chatId, record.view.connectionId, record.view.toolName, record.view.definitionDigest, record.scopeDigest));
  }
  record.resolve({ approved: decision.approved, sessionGrant: decision.approved && decision.sessionGrant && record.view.readOnlyHint });
  return { accepted: true };
};

export const clearMcpApprovals = () => {
  for (const record of [...pending.values()]) record.reject(new Error("MCP approval interrupted"));
  pending.clear();
  grants.clear();
};
