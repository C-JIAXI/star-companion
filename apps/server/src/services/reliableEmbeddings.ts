import { randomUUID } from "node:crypto";
import type { UserSettings } from "@prisma/client";
import { generateEmbeddings, type EmbeddingResult, type EmbeddingTask } from "./embeddings.js";
import { estimateInputTokens } from "./modelUsage.js";
import { executeReliableOperation } from "./reliableModelCalls.js";
import { getAgentUsageScope } from "./agentUsageScope.js";

export const generateReliableEmbeddings = async (input: {
  settings: UserSettings;
  inputs: string[];
  task: EmbeddingTask;
  chatId?: string;
  requestId?: string;
  overrideHardBudget?: boolean;
}): Promise<EmbeddingResult> => {
  const scope = getAgentUsageScope();
  let result;
  try { result = await executeReliableOperation({
  settings: input.settings,
  context: {
    requestId: scope?.requestId ?? input.requestId ?? `embedding_${randomUUID()}`,
    module: "memory_embedding",
    operation: input.task === "query" ? "embed_query" : "embed_documents",
    chatId: scope?.chatId ?? input.chatId,
    overrideHardBudget: input.overrideHardBudget,
    requestAlreadyClaimed: Boolean(scope),
    signal: scope?.signal
  },
  attemptNumberOffset: scope?.attemptNumber,
  requestComplete: !scope,
  allowFallback: scope ? false : undefined,
  allowRetry: scope ? false : undefined,
  estimatedInputTokens: estimateInputTokens(input.inputs),
  maxOutputTokens: 0,
  specialTokensUnknown: true,
  invoke: async (settings) => ({ value: await generateEmbeddings({ settings, inputs: input.inputs, task: input.task }) })
  }); }
  catch (error) { if (scope) scope.attemptNumber += 1; throw error; }
  if (scope) scope.attemptNumber = result.attemptNumber;
  return result.value;
};
