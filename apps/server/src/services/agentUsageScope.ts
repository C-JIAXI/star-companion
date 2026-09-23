import { AsyncLocalStorage } from "node:async_hooks";

export type AgentUsageScope = {
  requestId: string;
  chatId: string;
  signal?: AbortSignal;
  attemptNumber: number;
};

const storage = new AsyncLocalStorage<AgentUsageScope>();

export const withAgentUsageScope = <T>(scope: AgentUsageScope, run: () => Promise<T>) => storage.run(scope, run);
export const getAgentUsageScope = () => storage.getStore();
