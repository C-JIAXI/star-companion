import { randomUUID } from "node:crypto";
import type { Prisma, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { createModelError, type ModelCallError, type SafeModelError } from "./modelErrors.js";

export type UsageBudgets = {
  dailySoftMicros: number | null;
  dailyHardMicros: number | null;
  monthlySoftMicros: number | null;
  monthlyHardMicros: number | null;
  allowUnknownPricing: boolean;
};

export type PriceSnapshot = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  currency: "USD";
} | null;

export const defaultUsageBudgets: UsageBudgets = {
  dailySoftMicros: null,
  dailyHardMicros: null,
  monthlySoftMicros: null,
  monthlyHardMicros: null,
  allowUnknownPricing: true
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseUsageBudgets = (value: Prisma.JsonValue): UsageBudgets => {
  if (!record(value)) return defaultUsageBudgets;
  const amount = (key: string) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0
    ? value[key] as number
    : null;
  return {
    dailySoftMicros: amount("dailySoftMicros"),
    dailyHardMicros: amount("dailyHardMicros"),
    monthlySoftMicros: amount("monthlySoftMicros"),
    monthlyHardMicros: amount("monthlyHardMicros"),
    allowUnknownPricing: value.allowUnknownPricing !== false
  };
};

export const calculateCostMicros = (
  promptTokens: number,
  outputTokens: number,
  pricing: PriceSnapshot
) => pricing
  ? Math.ceil((promptTokens * pricing.inputMicrosPerMillion + outputTokens * pricing.outputMicrosPerMillion) / 1_000_000)
  : null;

export const usagePeriodKeys = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return { day, month: day.slice(0, 7) };
};

export const estimateInputTokens = (texts: string[]) => texts.reduce((total, text) => {
  const compact = text.trim();
  return total + (compact ? Math.max(1, Math.ceil(compact.length / 2)) : 0);
}, 0);

export const beginModelRequest = async (input: {
  requestId: string;
  module: string;
  operation: string;
  chatId?: string;
  messageId?: string;
  overrideHardBudget?: boolean;
}) => {
  try {
    return { created: true, request: await prisma.modelRequest.create({
      data: {
        id: input.requestId,
        module: input.module,
        operation: input.operation,
        chatId: input.chatId,
        messageId: input.messageId,
        overrideHardBudget: input.overrideHardBudget ?? false
      }
    }) };
  } catch (error) {
    const existing = await prisma.modelRequest.findUnique({ where: { id: input.requestId } });
    if (!existing) throw error;
    return { created: false, request: existing };
  }
};

let reservationQueue = Promise.resolve();
const withReservationLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const previous = reservationQueue;
  let release!: () => void;
  reservationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
};

export const reserveModelAttempt = async (input: {
  settings: UserSettings;
  requestId: string;
  attemptNumber: number;
  module: string;
  chatId?: string;
  messageId?: string;
  providerId: string;
  providerType: string;
  modelId: string;
  promptTokens: number;
  maxOutputTokens: number;
  pricing: PriceSnapshot;
  usedFallback: boolean;
  fallbackFromProviderId?: string;
  fallbackFromModelId?: string;
  specialTokensUnknown?: boolean;
}) => withReservationLock(() => prisma.$transaction(async (tx) => {
  const request = await tx.modelRequest.findUniqueOrThrow({ where: { id: input.requestId } });
  const budgets = parseUsageBudgets(input.settings.usageBudgets);
  const timezone = input.settings.usageTimezone || "UTC";
  const periods = usagePeriodKeys(new Date(), timezone);
  const reservedCostMicros = calculateCostMicros(input.promptTokens, input.maxOutputTokens, input.pricing);

  const createBlockedAttempt = async () => {
    const error = createModelError({ code: "budget_blocked", provider: input.providerType, modelId: input.modelId, attempt: input.attemptNumber });
    await tx.modelRequest.update({ where: { id: input.requestId }, data: {
      status: "blocked", errorCode: error.safe.code, errorSummary: error.safe.summary,
      diagnosticId: error.safe.diagnosticId, completedAt: new Date()
    } });
    return tx.modelUsageAttempt.create({ data: {
      id: `att_${randomUUID()}`,
      requestId: input.requestId,
      attemptNumber: input.attemptNumber,
      module: input.module,
      chatId: input.chatId,
      messageId: input.messageId,
      providerId: input.providerId,
      providerType: input.providerType,
      modelId: input.modelId,
      status: "blocked",
      completedAt: new Date(),
      inputPriceMicros: input.pricing?.inputMicrosPerMillion,
      outputPriceMicros: input.pricing?.outputMicrosPerMillion,
      currency: input.pricing?.currency,
      usedFallback: input.usedFallback,
      fallbackFromProviderId: input.fallbackFromProviderId,
      fallbackFromModelId: input.fallbackFromModelId,
      errorCode: error.safe.code,
      diagnosticId: error.safe.diagnosticId,
      specialTokensUnknown: input.specialTokensUnknown ?? false,
      reservationDay: periods.day,
      reservationMonth: periods.month
    } });
  };

  if (reservedCostMicros === null && !budgets.allowUnknownPricing && !request.overrideHardBudget) {
    return createBlockedAttempt();
  }

  if (reservedCostMicros !== null && !request.overrideHardBudget) {
    const [daily, monthly] = await Promise.all([
      tx.modelUsageAttempt.aggregate({
        where: { reservationDay: periods.day },
        _sum: { estimatedCostMicros: true, reservedCostMicros: true }
      }),
      tx.modelUsageAttempt.aggregate({
        where: { reservationMonth: periods.month },
        _sum: { estimatedCostMicros: true, reservedCostMicros: true }
      })
    ]);
    const dailyProjected = (daily._sum.estimatedCostMicros ?? 0) + (daily._sum.reservedCostMicros ?? 0) + reservedCostMicros;
    const monthlyProjected = (monthly._sum.estimatedCostMicros ?? 0) + (monthly._sum.reservedCostMicros ?? 0) + reservedCostMicros;
    if (
      (budgets.dailyHardMicros !== null && dailyProjected > budgets.dailyHardMicros) ||
      (budgets.monthlyHardMicros !== null && monthlyProjected > budgets.monthlyHardMicros)
    ) {
      return createBlockedAttempt();
    }
  }

  const id = `att_${randomUUID()}`;
  const attempt = await tx.modelUsageAttempt.create({ data: {
    id,
    requestId: input.requestId,
    attemptNumber: input.attemptNumber,
    module: input.module,
    chatId: input.chatId,
    messageId: input.messageId,
    providerId: input.providerId,
    providerType: input.providerType,
    modelId: input.modelId,
    inputPriceMicros: input.pricing?.inputMicrosPerMillion,
    outputPriceMicros: input.pricing?.outputMicrosPerMillion,
    currency: input.pricing?.currency,
    usedFallback: input.usedFallback,
    fallbackFromProviderId: input.fallbackFromProviderId,
    fallbackFromModelId: input.fallbackFromModelId,
    specialTokensUnknown: input.specialTokensUnknown ?? false,
    reservedCostMicros: reservedCostMicros ?? 0,
    reservationDay: periods.day,
    reservationMonth: periods.month
  } });
  await tx.modelRequest.update({ where: { id: input.requestId }, data: {
    status: "running", startedAt: request.startedAt ?? new Date(), activeAttemptId: id,
    chatId: input.chatId ?? request.chatId,
    messageId: input.messageId ?? request.messageId,
    errorCode: null, errorSummary: null, diagnosticId: null
  } });
  return attempt;
}));

export const settleModelAttempt = async (input: {
  attemptId: string;
  requestId: string;
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  promptTokens?: number;
  outputTokens?: number;
  usageSource?: "provider" | "estimated";
  specialTokensUnknown?: boolean;
  pricing: PriceSnapshot;
  error?: SafeModelError;
  messageId?: string;
  requestComplete?: boolean;
}) => prisma.$transaction(async (tx) => {
  const promptTokens = input.promptTokens;
  const outputTokens = input.outputTokens;
  const cost = promptTokens === undefined || outputTokens === undefined
    ? null
    : calculateCostMicros(promptTokens, outputTokens, input.pricing);
  await tx.modelUsageAttempt.update({ where: { id: input.attemptId }, data: {
    status: input.status,
    completedAt: new Date(),
    promptTokens,
    outputTokens,
    totalTokens: promptTokens === undefined || outputTokens === undefined ? undefined : promptTokens + outputTokens,
    usageSource: input.usageSource,
    specialTokensUnknown: input.specialTokensUnknown ?? false,
    estimatedCostMicros: cost,
    errorCode: input.error?.code,
    diagnosticId: input.error?.diagnosticId,
    reservedCostMicros: 0,
    messageId: input.messageId
  } });
  if (input.requestComplete) {
    const status = input.status === "succeeded" ? "succeeded" : input.status;
    await tx.modelRequest.update({ where: { id: input.requestId }, data: {
      status,
      messageId: input.messageId,
      errorCode: input.error?.code,
      errorSummary: input.error?.summary,
      diagnosticId: input.error?.diagnosticId,
      completedAt: new Date()
    } });
  }
});

export const markRequestStreaming = (requestId: string) => prisma.modelRequest.update({
  where: { id: requestId }, data: { status: "streaming", outputStarted: true }
});

export const completeModelRequest = (requestId: string, messageId?: string) => prisma.$transaction(async (tx) => {
  await tx.modelRequest.update({ where: { id: requestId }, data: {
    status: "succeeded", messageId, completedAt: new Date(), errorCode: null, errorSummary: null, diagnosticId: null
  } });
  if (messageId) {
    await tx.modelUsageAttempt.updateMany({ where: { requestId, status: "succeeded" }, data: { messageId } });
  }
});

export const linkModelRequestMessage = (requestId: string, messageId: string) => prisma.$transaction(async (tx) => {
  await tx.modelRequest.update({ where: { id: requestId }, data: { messageId } });
  await tx.modelUsageAttempt.updateMany({ where: { requestId }, data: { messageId } });
});

export const failModelRequest = (requestId: string, error: ModelCallError, status?: "failed" | "cancelled" | "interrupted" | "blocked") =>
  prisma.modelRequest.update({ where: { id: requestId }, data: {
    status: status ?? (error.safe.code === "cancelled" ? "cancelled" : error.safe.receivedOutputTokens ? "interrupted" : error.safe.code === "budget_blocked" ? "blocked" : "failed"),
    errorCode: error.safe.code,
    errorSummary: error.safe.summary,
    diagnosticId: error.safe.diagnosticId,
    completedAt: new Date()
  } });

export const getModelRequest = (requestId: string) => prisma.modelRequest.findUnique({ where: { id: requestId } });

/**
 * A local process cannot resume an in-flight provider connection after a
 * restart. Close those lifecycle rows and release every stale reservation so
 * the next request is not blocked by money that can no longer be spent.
 */
export const recoverInterruptedModelCalls = () => prisma.$transaction(async (tx) => {
  const activeRequests = await tx.modelRequest.findMany({
    where: { status: { in: ["queued", "running", "streaming"] } },
    select: { id: true, diagnosticId: true }
  });
  const requestIds = activeRequests.map((request) => request.id);
  if (!requestIds.length) return { requests: 0, attempts: 0 };
  const completedAt = new Date();
  const attempts = await tx.modelUsageAttempt.updateMany({
    where: {
      requestId: { in: requestIds },
      OR: [
        { status: { in: ["queued", "running", "streaming"] } },
        { reservedCostMicros: { gt: 0 } }
      ]
    },
    data: {
      status: "interrupted",
      completedAt,
      reservedCostMicros: 0,
      errorCode: "stream_interrupted"
    }
  });
  for (const request of activeRequests) {
    await tx.modelRequest.update({
      where: { id: request.id },
      data: {
        status: "interrupted",
        completedAt,
        errorCode: "stream_interrupted",
        errorSummary: "The previous model request was interrupted when the local service stopped.",
        diagnosticId: request.diagnosticId ?? `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}`
      }
    });
  }
  return { requests: activeRequests.length, attempts: attempts.count };
});

export const retryDelay = (attempt: number, retryAfter?: number) =>
  retryAfter ?? Math.min(30_000, Math.round(500 * 2 ** Math.max(0, attempt - 1) * (0.75 + Math.random() * 0.5)));

export const waitForRetry = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }, { once: true });
});
