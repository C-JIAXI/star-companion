import type { Prisma, UserSettings } from "@prisma/client";
import { completeChatCompletionDetailed, estimateTokenUsage, normalizeProvider, streamChatCompletion, type ChatCompletionMessage, type ChatCompletionResult, type ChatCompletionStreamEvent } from "./completions.js";
import { createModelError, ModelCallError, normalizeModelError } from "./modelErrors.js";
import { resolveAutomaticFallbackSettings, resolveModuleSettings, settingsSupportVisionInput, type AiModuleId } from "./moduleModels.js";
import {
  beginModelRequest,
  estimateInputTokens,
  failModelRequest,
  reserveModelAttempt,
  retryDelay,
  settleModelAttempt,
  waitForRetry,
  markRequestStreaming,
  type PriceSnapshot
} from "./modelUsage.js";

type ProviderModel = {
  id?: string;
  model?: string;
  pricing?: { inputMicrosPerMillion?: number; outputMicrosPerMillion?: number; currency?: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parsePricing = (model: ProviderModel | undefined): PriceSnapshot => {
  const pricing = model?.pricing;
  return pricing && Number.isSafeInteger(pricing.inputMicrosPerMillion) && Number.isSafeInteger(pricing.outputMicrosPerMillion) && pricing.currency === "USD"
    ? { inputMicrosPerMillion: pricing.inputMicrosPerMillion!, outputMicrosPerMillion: pricing.outputMicrosPerMillion!, currency: "USD" }
    : null;
};

export const getModelIdentity = (settings: UserSettings) => {
  const providers: Record<string, unknown>[] = Array.isArray(settings.providers)
    ? (settings.providers as unknown[]).filter(isRecord)
    : [];
  const provider = providers.find((entry) => entry.id === settings.activeProviderId);
  const models: Record<string, unknown>[] = provider && Array.isArray(provider.models)
    ? (provider.models as unknown[]).filter(isRecord)
    : [];
  const model = models.find((entry) => entry.id === settings.activeModelId) as ProviderModel | undefined;
  return {
    providerId: typeof provider?.id === "string" ? provider.id : settings.activeProviderId || settings.activeProvider,
    providerType: normalizeProvider(typeof provider?.provider === "string" ? provider.provider : settings.activeProvider),
    modelPresetId: typeof model?.id === "string" ? model.id : settings.activeModelId || settings.model,
    modelId: typeof model?.model === "string" ? model.model : settings.model,
    pricing: parsePricing(model)
  };
};

const reliability = (settings: UserSettings) => {
  const raw = isRecord(settings.modelReliability) ? settings.modelReliability : {};
  const retry = isRecord(raw.retry) ? raw.retry : {};
  return {
    enabled: retry.enabled === true,
    maxRetries: typeof retry.maxRetries === "number" ? Math.max(0, Math.min(2, Math.trunc(retry.maxRetries))) : 0
  };
};

const estimateMultimodalInputTokens = (messages: ChatCompletionMessage[]) =>
  estimateInputTokens(messages.map((message) => message.content)) +
  messages.reduce((total, message) => total + (message.images?.length ?? 0) * 1024, 0);

export type ReliableCallContext = {
  requestId: string;
  module: AiModuleId;
  operation: string;
  chatId?: string;
  messageId?: string;
  overrideHardBudget?: boolean;
  signal?: AbortSignal;
  onRetry?: (input: { attempt: number; retryAfterMs: number; error: ModelCallError }) => void;
  onFallback?: (input: { from: ReturnType<typeof getModelIdentity>; to: ReturnType<typeof getModelIdentity>; error: ModelCallError }) => void;
  /** WebSocket generation claims the request before persisting the user message. */
  requestAlreadyClaimed?: boolean;
};

export type ReliableTextResult = ChatCompletionResult & {
  requestId: string;
  attemptId: string;
  attemptNumber: number;
  providerId: string;
  providerType: string;
  modelId: string;
  pricing: PriceSnapshot;
  usedFallback: boolean;
};

export type ReliableOperationResult<T> = {
  value: T;
  usage: ChatCompletionResult["usage"];
  requestId: string;
  attemptId: string;
  attemptNumber: number;
  identity: ReturnType<typeof getModelIdentity>;
  usedFallback: boolean;
  specialTokensUnknown: boolean;
};

/**
 * Reliability/budget envelope for non-chat provider calls (embeddings and
 * media). The callback is invoked once per real provider attempt; neither
 * prompts nor provider response bodies are persisted by this layer.
 */
export const executeReliableOperation = async <T>(input: {
  settings: UserSettings;
  context: ReliableCallContext;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  specialTokensUnknown?: boolean;
  invoke: (settings: UserSettings, signal: AbortSignal | undefined) => Promise<{
    value: T;
    usage?: ChatCompletionResult["usage"];
  }>;
}): Promise<ReliableOperationResult<T>> => {
  if (!input.context.requestAlreadyClaimed) {
    const claimed = await beginModelRequest({
      requestId: input.context.requestId,
      module: input.context.module,
      operation: input.context.operation,
      chatId: input.context.chatId,
      messageId: input.context.messageId,
      overrideHardBudget: input.context.overrideHardBudget
    });
    if (!claimed.created) {
      throw normalizeModelError(new Error(`Duplicate request in state ${claimed.request.status}`), {
        provider: input.settings.activeProvider,
        modelId: input.settings.model
      });
    }
  }

  const primarySettings = resolveModuleSettings(input.settings, input.context.module);
  const candidates = [primarySettings, ...resolveAutomaticFallbackSettings(input.settings, input.context.module)];
  const primaryIdentity = getModelIdentity(primarySettings);
  let attemptNumber = 0;
  let lastError: ModelCallError | null = null;

  for (const [candidateIndex, settings] of candidates.entries()) {
    const identity = getModelIdentity(settings);
    if (candidateIndex > 0 && lastError) input.context.onFallback?.({ from: primaryIdentity, to: identity, error: lastError });
    const retry = reliability(settings);
    const maxAttempts = retry.enabled ? 1 + retry.maxRetries : 1;
    for (let candidateAttempt = 1; candidateAttempt <= maxAttempts; candidateAttempt += 1) {
      attemptNumber += 1;
      const pricing = input.specialTokensUnknown ? null : identity.pricing;
      const attempt = await reserveModelAttempt({
        settings,
        requestId: input.context.requestId,
        attemptNumber,
        module: input.context.module,
        chatId: input.context.chatId,
        messageId: input.context.messageId,
        providerId: identity.providerId,
        providerType: identity.providerType,
        modelId: identity.modelId,
        promptTokens: input.estimatedInputTokens ?? 0,
        maxOutputTokens: input.maxOutputTokens ?? 0,
        pricing,
        usedFallback: candidateIndex > 0,
        fallbackFromProviderId: candidateIndex > 0 ? primaryIdentity.providerId : undefined,
        fallbackFromModelId: candidateIndex > 0 ? primaryIdentity.modelId : undefined
      });
      if (attempt.status === "blocked") {
        throw createBudgetBlockedError(identity, attemptNumber, attempt.diagnosticId);
      }
      try {
        const result = await input.invoke(settings, input.context.signal);
        const usage = result.usage ?? null;
        await settleModelAttempt({
          attemptId: attempt.id,
          requestId: input.context.requestId,
          status: "succeeded",
          promptTokens: usage?.promptTokens,
          outputTokens: usage?.completionTokens,
          usageSource: usage ? (usage.estimated ? "estimated" : "provider") : undefined,
          specialTokensUnknown: input.specialTokensUnknown ?? false,
          pricing,
          requestComplete: true,
          messageId: input.context.messageId
        });
        return { value: result.value, usage, requestId: input.context.requestId, attemptId: attempt.id, attemptNumber, identity, usedFallback: candidateIndex > 0, specialTokensUnknown: input.specialTokensUnknown ?? false };
      } catch (caught) {
        const error = normalizeModelError(caught, {
          provider: identity.providerType,
          modelId: identity.modelId,
          attempt: attemptNumber,
          cancelled: input.context.signal?.aborted
        });
        const canRetry = error.safe.retryable && candidateAttempt < maxAttempts && !input.context.signal?.aborted;
        const canFallback = error.safe.retryable && candidateIndex < candidates.length - 1 && !input.context.signal?.aborted;
        const final = !canRetry && !canFallback;
        await settleModelAttempt({ attemptId: attempt.id, requestId: input.context.requestId, status: error.safe.code === "cancelled" ? "cancelled" : "failed", pricing, error: error.safe, specialTokensUnknown: input.specialTokensUnknown ?? false, requestComplete: final });
        if (final) throw error;
        lastError = error;
        if (canRetry) {
          const milliseconds = retryDelay(candidateAttempt, error.safe.retryAfterMs);
          input.context.onRetry?.({ attempt: attemptNumber + 1, retryAfterMs: milliseconds, error });
          try {
            await waitForRetry(milliseconds, input.context.signal);
          } catch (waitError) {
            const cancelled = normalizeModelError(waitError, { provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber, cancelled: input.context.signal?.aborted });
            await failModelRequest(input.context.requestId, cancelled);
            throw cancelled;
          }
        } else break;
      }
    }
  }
  throw new Error("Unreachable reliable model operation state");
};

const createBudgetBlockedError = (
  identity: ReturnType<typeof getModelIdentity>,
  attempt: number,
  diagnosticId?: string | null
) => new ModelCallError({
  code: "budget_blocked",
  retryable: false,
  receivedOutputTokens: false,
  provider: identity.providerType,
  modelId: identity.modelId,
  attempt,
  summary: "The local hard budget prevented this model call.",
  diagnosticId: diagnosticId ?? "mdl_budget"
});

export const executeReliableTextCompletion = async (input: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  context: ReliableCallContext;
}): Promise<ReliableTextResult> => {
  if (!input.context.requestAlreadyClaimed) {
    const { created, request } = await beginModelRequest({
      requestId: input.context.requestId,
      module: input.context.module,
      operation: input.context.operation,
      chatId: input.context.chatId,
      messageId: input.context.messageId,
      overrideHardBudget: input.context.overrideHardBudget
    });
    if (!created) {
      throw normalizeModelError(new Error(`Duplicate request in state ${request.status}`), {
        provider: input.settings.activeProvider,
        modelId: input.settings.model
      });
    }
  }

  const primarySettings = resolveModuleSettings(input.settings, input.context.module);
  const requiresVision = input.messages.some((message) => Boolean(message.images?.length));
  const candidates = [primarySettings, ...resolveAutomaticFallbackSettings(input.settings, input.context.module)]
    .filter((settings) => !requiresVision || settingsSupportVisionInput(settings));
  if (!candidates.length) throw createModelError({ code: "unsupported_capability", provider: primarySettings.activeProvider, modelId: primarySettings.model });
  const primaryIdentity = getModelIdentity(primarySettings);
  const promptTokens = estimateMultimodalInputTokens(input.messages);
  let attemptNumber = 0;
  let lastError: ModelCallError | null = null;

  for (const [candidateIndex, settings] of candidates.entries()) {
    const identity = getModelIdentity(settings);
    if (candidateIndex > 0 && lastError) input.context.onFallback?.({ from: primaryIdentity, to: identity, error: lastError });
    const retry = reliability(settings);
    const maxAttemptsForCandidate = retry.enabled ? 1 + retry.maxRetries : 1;
    for (let candidateAttempt = 1; candidateAttempt <= maxAttemptsForCandidate; candidateAttempt += 1) {
    attemptNumber += 1;
    const attempt = await reserveModelAttempt({
      settings,
      requestId: input.context.requestId,
      attemptNumber,
      module: input.context.module,
      chatId: input.context.chatId,
      messageId: input.context.messageId,
      providerId: identity.providerId,
      providerType: identity.providerType,
      modelId: identity.modelId,
      promptTokens,
      maxOutputTokens: input.maxTokens ?? settings.maxTokens,
      pricing: identity.pricing,
      usedFallback: candidateIndex > 0,
      fallbackFromProviderId: candidateIndex > 0 ? primaryIdentity.providerId : undefined,
      fallbackFromModelId: candidateIndex > 0 ? primaryIdentity.modelId : undefined,
      specialTokensUnknown: requiresVision
    });
    if (attempt.status === "blocked") {
      throw normalizeModelError(new ModelCallError({
        code: "budget_blocked", retryable: false, receivedOutputTokens: false,
        provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber,
        summary: "The local hard budget prevented this model call.", diagnosticId: attempt.diagnosticId ?? "mdl_budget"
      }), { provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber });
    }
    try {
      const result = await completeChatCompletionDetailed({
        settings,
        messages: input.messages,
        signal: input.context.signal,
        maxTokens: input.maxTokens,
        temperature: input.temperature
      });
      const usage = result.usage ?? estimateTokenUsage(input.messages, result.content);
      await settleModelAttempt({
        attemptId: attempt.id,
        requestId: input.context.requestId,
        status: "succeeded",
        promptTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        usageSource: usage.estimated ? "estimated" : "provider",
        specialTokensUnknown: requiresVision && usage.estimated,
        pricing: identity.pricing,
        requestComplete: true,
        messageId: input.context.messageId
      });
      return { ...result, usage, requestId: input.context.requestId, attemptId: attempt.id, attemptNumber, ...identity, usedFallback: candidateIndex > 0 };
    } catch (caught) {
      const error = normalizeModelError(caught, {
        provider: identity.providerType,
        modelId: identity.modelId,
        attempt: attemptNumber,
        cancelled: input.context.signal?.aborted
      });
      const canFallback = error.safe.retryable && candidateIndex < candidates.length - 1 && !error.safe.receivedOutputTokens;
      const canRetry = error.safe.retryable && candidateAttempt < maxAttemptsForCandidate && !input.context.signal?.aborted;
      const final = (!canRetry && !canFallback) || input.context.signal?.aborted;
      await settleModelAttempt({
        attemptId: attempt.id,
        requestId: input.context.requestId,
        status: error.safe.code === "cancelled" ? "cancelled" : "failed",
        pricing: identity.pricing,
        specialTokensUnknown: requiresVision,
        error: error.safe,
        requestComplete: final
      });
      if (final) throw error;
      lastError = error;
      if (canRetry) {
        const milliseconds = retryDelay(candidateAttempt, error.safe.retryAfterMs);
        input.context.onRetry?.({ attempt: attemptNumber + 1, retryAfterMs: milliseconds, error });
        try {
          await waitForRetry(milliseconds, input.context.signal);
        } catch (caught) {
          const cancelled = normalizeModelError(caught, {
            provider: identity.providerType,
            modelId: identity.modelId,
            attempt: attemptNumber,
            cancelled: input.context.signal?.aborted
          });
          await failModelRequest(input.context.requestId, cancelled);
          throw cancelled;
        }
      } else {
        break;
      }
    }
    }
  }
  throw new Error("Unreachable reliable model call state");
};

export const generationMetadata = (result: ReliableTextResult) => ({
  providerId: result.providerId,
  providerType: result.providerType,
  modelId: result.modelId,
  requestId: result.requestId,
  attemptId: result.attemptId,
  usage: result.usage,
  usageSource: result.usage ? (result.usage.estimated ? "estimated" : "provider") : null,
  inputPriceMicros: result.pricing?.inputMicrosPerMillion ?? null,
  outputPriceMicros: result.pricing?.outputMicrosPerMillion ?? null,
  estimatedCostMicros: result.usage && result.pricing
    ? Math.ceil((result.usage.promptTokens * result.pricing.inputMicrosPerMillion + result.usage.completionTokens * result.pricing.outputMicrosPerMillion) / 1_000_000)
    : null,
  currency: result.pricing?.currency ?? null,
  usedFallback: result.usedFallback,
  incomplete: false
}) satisfies Prisma.JsonObject;

export const incompleteGenerationMetadata = (input: {
  requestId: string;
  attemptId: string;
  providerId: string;
  providerType: string;
  modelId: string;
  pricing: PriceSnapshot;
  usedFallback: boolean;
  usage: NonNullable<ChatCompletionResult["usage"]>;
}) => ({
  providerId: input.providerId,
  providerType: input.providerType,
  modelId: input.modelId,
  requestId: input.requestId,
  attemptId: input.attemptId,
  usage: input.usage,
  usageSource: input.usage.estimated ? "estimated" : "provider",
  inputPriceMicros: input.pricing?.inputMicrosPerMillion ?? null,
  outputPriceMicros: input.pricing?.outputMicrosPerMillion ?? null,
  estimatedCostMicros: input.pricing
    ? Math.ceil((input.usage.promptTokens * input.pricing.inputMicrosPerMillion + input.usage.completionTokens * input.pricing.outputMicrosPerMillion) / 1_000_000)
    : null,
  currency: input.pricing?.currency ?? null,
  usedFallback: input.usedFallback,
  incomplete: true
}) satisfies Prisma.JsonObject;

export type ReliableStreamEvent = ChatCompletionStreamEvent | {
  type: "attempt";
  attemptId: string;
  attemptNumber: number;
  identity: ReturnType<typeof getModelIdentity>;
  usedFallback: boolean;
} | {
  type: "retry";
  attempt: number;
  retryAfterMs: number;
  error: ModelCallError;
} | {
  type: "fallback";
  from: ReturnType<typeof getModelIdentity>;
  to: ReturnType<typeof getModelIdentity>;
  error: ModelCallError;
} | {
  type: "complete";
  result: ReliableTextResult;
};

export async function* executeReliableTextStream(input: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  context: ReliableCallContext;
}): AsyncGenerator<ReliableStreamEvent> {
  const primarySettings = resolveModuleSettings(input.settings, input.context.module);
  const requiresVision = input.messages.some((message) => Boolean(message.images?.length));
  const candidates = [primarySettings, ...resolveAutomaticFallbackSettings(input.settings, input.context.module)]
    .filter((settings) => !requiresVision || settingsSupportVisionInput(settings));
  if (!candidates.length) throw createModelError({ code: "unsupported_capability", provider: primarySettings.activeProvider, modelId: primarySettings.model });
  const primaryIdentity = getModelIdentity(primarySettings);
  const promptTokensEstimate = estimateMultimodalInputTokens(input.messages);
  let attemptNumber = 0;
  let lastError: ModelCallError | null = null;

  for (const [candidateIndex, settings] of candidates.entries()) {
    const identity = getModelIdentity(settings);
    if (candidateIndex > 0 && lastError) yield { type: "fallback", from: primaryIdentity, to: identity, error: lastError };
    const retry = reliability(settings);
    const maxAttemptsForCandidate = retry.enabled ? 1 + retry.maxRetries : 1;
    for (let candidateAttempt = 1; candidateAttempt <= maxAttemptsForCandidate; candidateAttempt += 1) {
      attemptNumber += 1;
      const attempt = await reserveModelAttempt({
        settings,
        requestId: input.context.requestId,
        attemptNumber,
        module: input.context.module,
        chatId: input.context.chatId,
        messageId: input.context.messageId,
        providerId: identity.providerId,
        providerType: identity.providerType,
        modelId: identity.modelId,
        promptTokens: promptTokensEstimate,
        maxOutputTokens: settings.maxTokens,
        pricing: identity.pricing,
        usedFallback: candidateIndex > 0,
        fallbackFromProviderId: candidateIndex > 0 ? primaryIdentity.providerId : undefined,
        fallbackFromModelId: candidateIndex > 0 ? primaryIdentity.modelId : undefined,
        specialTokensUnknown: requiresVision
      });
      if (attempt.status === "blocked") {
        throw new ModelCallError({
          code: "budget_blocked", retryable: false, receivedOutputTokens: false,
          provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber,
          summary: "The local hard budget prevented this model call.", diagnosticId: attempt.diagnosticId ?? "mdl_budget"
        });
      }
      let outputStarted = false;
      let content = "";
      let usage: ChatCompletionResult["usage"] = null;
      try {
        yield { type: "attempt", attemptId: attempt.id, attemptNumber, identity, usedFallback: candidateIndex > 0 };
        for await (const event of streamChatCompletion({ settings, messages: input.messages, signal: input.context.signal ?? new AbortController().signal })) {
          if (event.type === "usage") usage = event.usage;
          if (event.type === "token" && event.content) {
            content += event.content;
            if (!outputStarted) {
              outputStarted = true;
              await markRequestStreaming(input.context.requestId);
            }
          }
          yield event;
        }
        usage ??= estimateTokenUsage(input.messages, content);
        await settleModelAttempt({
          attemptId: attempt.id,
          requestId: input.context.requestId,
          status: "succeeded",
          promptTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          usageSource: usage.estimated ? "estimated" : "provider",
          specialTokensUnknown: requiresVision && usage.estimated,
          pricing: identity.pricing,
          requestComplete: false
        });
        yield { type: "complete", result: {
          content,
          usage,
          requestId: input.context.requestId,
          attemptId: attempt.id,
          attemptNumber,
          ...identity,
          usedFallback: candidateIndex > 0
        } };
        return;
      } catch (caught) {
        const error = normalizeModelError(caught, {
          provider: identity.providerType,
          modelId: identity.modelId,
          attempt: attemptNumber,
          receivedOutputTokens: outputStarted,
          cancelled: input.context.signal?.aborted
        });
        const canFallback = error.safe.retryable && candidateIndex < candidates.length - 1 && !outputStarted;
        const canRetry = error.safe.retryable && candidateAttempt < maxAttemptsForCandidate && !outputStarted && !input.context.signal?.aborted;
        const final = (!canRetry && !canFallback) || input.context.signal?.aborted;
        const partialUsage = outputStarted ? estimateTokenUsage(input.messages, content) : null;
        await settleModelAttempt({
          attemptId: attempt.id,
          requestId: input.context.requestId,
          status: error.safe.code === "cancelled" ? "cancelled" : outputStarted ? "interrupted" : "failed",
          promptTokens: partialUsage?.promptTokens,
          outputTokens: partialUsage?.completionTokens,
          usageSource: partialUsage ? "estimated" : undefined,
          specialTokensUnknown: requiresVision,
          pricing: identity.pricing,
          error: error.safe,
          requestComplete: final
        });
        if (final) throw error;
        lastError = error;
        if (canRetry) {
          const milliseconds = retryDelay(candidateAttempt, error.safe.retryAfterMs);
          yield { type: "retry", attempt: attemptNumber + 1, retryAfterMs: milliseconds, error };
          try {
            await waitForRetry(milliseconds, input.context.signal);
          } catch (caught) {
            const cancelled = normalizeModelError(caught, {
              provider: identity.providerType,
              modelId: identity.modelId,
              attempt: attemptNumber,
              cancelled: input.context.signal?.aborted
            });
            await failModelRequest(input.context.requestId, cancelled);
            throw cancelled;
          }
        } else break;
      }
    }
  }
}
