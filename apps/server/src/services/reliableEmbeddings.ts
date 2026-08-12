import { randomUUID } from "node:crypto";
import type { UserSettings } from "@prisma/client";
import { generateEmbeddings, type EmbeddingResult, type EmbeddingTask } from "./embeddings.js";
import { estimateInputTokens } from "./modelUsage.js";
import { executeReliableOperation } from "./reliableModelCalls.js";

export const generateReliableEmbeddings = async (input: {
  settings: UserSettings;
  inputs: string[];
  task: EmbeddingTask;
  chatId?: string;
  requestId?: string;
  overrideHardBudget?: boolean;
}): Promise<EmbeddingResult> => (await executeReliableOperation({
  settings: input.settings,
  context: {
    requestId: input.requestId ?? `embedding_${randomUUID()}`,
    module: "memory_embedding",
    operation: input.task === "query" ? "embed_query" : "embed_documents",
    chatId: input.chatId,
    overrideHardBudget: input.overrideHardBudget
  },
  estimatedInputTokens: estimateInputTokens(input.inputs),
  maxOutputTokens: 0,
  specialTokensUnknown: true,
  invoke: async (settings) => ({ value: await generateEmbeddings({ settings, inputs: input.inputs, task: input.task }) })
})).value;
