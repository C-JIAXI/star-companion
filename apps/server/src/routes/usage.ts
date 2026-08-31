import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { getOrCreateSettings } from "./settings.js";
import { calculateCostMicros, estimateInputTokens, parseUsageBudgets, usagePeriodKeys } from "../services/modelUsage.js";
import { getModelIdentity } from "../services/reliableModelCalls.js";
import { resolveModuleSettings, type AiModuleId } from "../services/moduleModels.js";

export const usageRouter = Router();

const validModules = new Set<AiModuleId>(["chat", "agent", "memory", "memory_embedding", "user_profile", "voice_transcription", "voice_speech", "image_generation"]);
const isoDate = (value: unknown, fallback: Date) => {
  const parsed = typeof value === "string" ? new Date(value) : fallback;
  if (!Number.isFinite(parsed.getTime())) throw new HttpError(400, "Invalid usage date range.");
  return parsed;
};

type AggregateRow = {
  status: string;
  usedFallback: boolean;
  attemptNumber: number;
  _count: { _all: number; estimatedCostMicros: number };
  _sum: {
    promptTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedCostMicros: number | null;
  };
};

const bucket = <Row extends AggregateRow>(
  rows: Row[],
  keyOf: (row: Row) => string,
  labelOf: (row: Row) => string = keyOf
) => {
  const values = new Map<string, { key: string; label: string; attempts: number; succeeded: number; failed: number; retries: number; fallbacks: number; promptTokens: number; outputTokens: number; totalTokens: number; estimatedCostMicros: number; unknownCostAttempts: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const item = values.get(key) ?? { key, label: labelOf(row), attempts: 0, succeeded: 0, failed: 0, retries: 0, fallbacks: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0, unknownCostAttempts: 0 };
    item.attempts += row._count._all;
    item.succeeded += row.status === "succeeded" ? row._count._all : 0;
    item.failed += row.status === "failed" || row.status === "interrupted" ? row._count._all : 0;
    item.retries += row.attemptNumber > 1 ? row._count._all : 0;
    item.fallbacks += row.usedFallback ? row._count._all : 0;
    item.promptTokens += row._sum.promptTokens ?? 0;
    item.outputTokens += row._sum.outputTokens ?? 0;
    item.totalTokens += row._sum.totalTokens ?? 0;
    item.estimatedCostMicros += row._sum.estimatedCostMicros ?? 0;
    item.unknownCostAttempts += row._count._all - row._count.estimatedCostMicros;
    values.set(key, item);
  }
  return [...values.values()].sort((left, right) => right.estimatedCostMicros - left.estimatedCostMicros || right.attempts - left.attempts);
};

const aggregateFields = {
  _count: { _all: true, estimatedCostMicros: true },
  _sum: { promptTokens: true, outputTokens: true, totalTokens: true, estimatedCostMicros: true }
} as const;

usageRouter.get("/summary", asyncHandler(async (request, response) => {
  const now = new Date();
  const from = isoDate(request.query.from, new Date(now.getTime() - 31 * 86_400_000));
  const to = isoDate(request.query.to, new Date(now.getTime() + 1));
  if (to <= from || to.getTime() - from.getTime() > 370 * 86_400_000) throw new HttpError(400, "Usage range must be between 1 and 370 days.");
  const settings = await getOrCreateSettings();
  const timezone = settings.usageTimezone || "UTC";
  const periods = usagePeriodKeys(now, timezone);
  const filters = {
    ...(typeof request.query.module === "string" && validModules.has(request.query.module as AiModuleId) ? { module: request.query.module } : {}),
    ...(typeof request.query.providerId === "string" && request.query.providerId ? { providerId: request.query.providerId } : {}),
    ...(typeof request.query.modelId === "string" && request.query.modelId ? { modelId: request.query.modelId } : {}),
    ...(typeof request.query.chatId === "string" && request.query.chatId ? { chatId: request.query.chatId } : {})
  };
  const where: Prisma.ModelUsageAttemptWhereInput = {
    startedAt: { gte: from, lt: to },
    ...filters
  };
  const [moduleRows, providerRows, modelRows, chatRows, recent, unknownCostAttempts, periodRows] = await Promise.all([
    prisma.modelUsageAttempt.groupBy({
      by: ["module", "status", "usedFallback", "attemptNumber"], where, ...aggregateFields
    }),
    prisma.modelUsageAttempt.groupBy({
      by: ["providerId", "status", "usedFallback", "attemptNumber"], where, ...aggregateFields
    }),
    prisma.modelUsageAttempt.groupBy({
      by: ["providerId", "modelId", "status", "usedFallback", "attemptNumber"], where, ...aggregateFields
    }),
    prisma.modelUsageAttempt.groupBy({
      by: ["chatId", "status", "usedFallback", "attemptNumber"],
      where: { AND: [where, { chatId: { not: null } }] },
      ...aggregateFields
    }),
    prisma.modelUsageAttempt.findMany({
      where,
      include: { chat: { select: { title: true } } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 30
    }),
    prisma.modelUsageAttempt.count({ where: { AND: [where, { estimatedCostMicros: null }] } }),
    prisma.modelUsageAttempt.groupBy({
      by: ["reservationDay", "reservationMonth"],
      where: { OR: [{ reservationDay: periods.day }, { reservationMonth: periods.month }] },
      _sum: { estimatedCostMicros: true, totalTokens: true }
    })
  ]);
  const chatIds = [...new Set(chatRows.map((row) => row.chatId).filter((id): id is string => Boolean(id)))];
  const chatTitles = new Map((await prisma.chat.findMany({
    where: { id: { in: chatIds } },
    select: { id: true, title: true }
  })).map((chat) => [chat.id, chat.title]));
  const todayRows = periodRows.filter((row) => row.reservationDay === periods.day);
  const monthRows = periodRows.filter((row) => row.reservationMonth === periods.month);
  const sum = (values: typeof periodRows, field: "estimatedCostMicros" | "totalTokens") =>
    values.reduce((total, row) => total + (row._sum[field] ?? 0), 0);
  response.json({ ok: true, data: {
    from: from.toISOString(), to: to.toISOString(),
    todayCostMicros: sum(todayRows, "estimatedCostMicros"),
    monthCostMicros: sum(monthRows, "estimatedCostMicros"),
    todayTokens: sum(todayRows, "totalTokens"), monthTokens: sum(monthRows, "totalTokens"),
    unknownCostAttempts,
    budgets: parseUsageBudgets(settings.usageBudgets), timezone,
    byModule: bucket(moduleRows, (row) => row.module),
    byProvider: bucket(providerRows, (row) => row.providerId),
    byModel: bucket(modelRows, (row) => `${row.providerId}/${row.modelId}`),
    byChat: bucket(chatRows, (row) => row.chatId ?? "", (row) => chatTitles.get(row.chatId ?? "") ?? "Local chat").slice(0, 100),
    recent: recent.map((row) => ({
      attemptId: row.id, requestId: row.requestId, attemptNumber: row.attemptNumber, module: row.module,
      chatId: row.chatId, chatTitle: row.chat?.title ?? null, messageId: row.messageId,
      providerId: row.providerId, providerType: row.providerType, modelId: row.modelId,
      startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      status: row.status, promptTokens: row.promptTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens,
      usageSource: row.usageSource, inputPriceMicros: row.inputPriceMicros, outputPriceMicros: row.outputPriceMicros,
      estimatedCostMicros: row.estimatedCostMicros, currency: row.currency, usedFallback: row.usedFallback,
      specialTokensUnknown: row.specialTokensUnknown,
      errorCode: row.errorCode
    }))
  } });
}));

usageRouter.post("/preview", asyncHandler(async (request, response) => {
  const body = request.body as Record<string, unknown>;
  const module = typeof body.module === "string" && validModules.has(body.module as AiModuleId) ? body.module as AiModuleId : "chat";
  const texts = Array.isArray(body.texts) ? body.texts.filter((value): value is string => typeof value === "string").slice(0, 1000) : [];
  const settings = resolveModuleSettings(await getOrCreateSettings(), module);
  const identity = getModelIdentity(settings);
  const inputTokens = typeof body.inputTokens === "number" && Number.isInteger(body.inputTokens)
    ? Math.max(0, Math.min(100_000_000, body.inputTokens))
    : estimateInputTokens(texts);
  const maxOutputTokens = typeof body.maxOutputTokens === "number" && Number.isInteger(body.maxOutputTokens) ? Math.max(1, Math.min(200000, body.maxOutputTokens)) : settings.maxTokens;
  const now = new Date();
  const timezone = settings.usageTimezone || "UTC";
  const periods = usagePeriodKeys(now, timezone);
  const aggregate = await prisma.modelUsageAttempt.groupBy({ by: ["reservationDay", "reservationMonth"], where: { OR: [{ reservationDay: periods.day }, { reservationMonth: periods.month }] }, _sum: { estimatedCostMicros: true, reservedCostMicros: true } });
  const today = aggregate.filter((row) => row.reservationDay === periods.day).reduce((sum, row) => sum + (row._sum.estimatedCostMicros ?? 0), 0);
  const month = aggregate.filter((row) => row.reservationMonth === periods.month).reduce((sum, row) => sum + (row._sum.estimatedCostMicros ?? 0), 0);
  const todayCommitted = aggregate.filter((row) => row.reservationDay === periods.day).reduce((sum, row) => sum + (row._sum.estimatedCostMicros ?? 0) + (row._sum.reservedCostMicros ?? 0), 0);
  const monthCommitted = aggregate.filter((row) => row.reservationMonth === periods.month).reduce((sum, row) => sum + (row._sum.estimatedCostMicros ?? 0) + (row._sum.reservedCostMicros ?? 0), 0);
  const budgets = parseUsageBudgets(settings.usageBudgets);
  const maximum = calculateCostMicros(inputTokens, maxOutputTokens, identity.pricing);
  const remaining = (limit: number | null, used: number) => limit === null ? null : Math.max(0, limit - used);
  response.json({ ok: true, data: {
    providerId: identity.providerId, modelId: identity.modelId, inputTokens, maxOutputTokens,
    minimumCostMicros: identity.pricing ? calculateCostMicros(inputTokens, 0, identity.pricing) : null,
    maximumCostMicros: maximum, currency: identity.pricing?.currency ?? null,
    todayCostMicros: today, monthCostMicros: month,
    dailySoftRemainingMicros: remaining(budgets.dailySoftMicros, todayCommitted), dailyHardRemainingMicros: remaining(budgets.dailyHardMicros, todayCommitted),
    monthlySoftRemainingMicros: remaining(budgets.monthlySoftMicros, monthCommitted), monthlyHardRemainingMicros: remaining(budgets.monthlyHardMicros, monthCommitted),
    unknownPricing: !identity.pricing,
    softWarning: maximum !== null && ((budgets.dailySoftMicros !== null && todayCommitted + maximum > budgets.dailySoftMicros) || (budgets.monthlySoftMicros !== null && monthCommitted + maximum > budgets.monthlySoftMicros)),
    hardBlocked: (!identity.pricing && !budgets.allowUnknownPricing) || (maximum !== null && ((budgets.dailyHardMicros !== null && todayCommitted + maximum > budgets.dailyHardMicros) || (budgets.monthlyHardMicros !== null && monthCommitted + maximum > budgets.monthlyHardMicros))),
    timezone
  } });
}));

usageRouter.delete("/history", asyncHandler(async (request, response) => {
  if (request.body?.confirm !== "DELETE_USAGE_HISTORY") throw new HttpError(400, "Explicit usage-history confirmation is required.");
  const result = await prisma.$transaction(async (tx) => {
    const deletedAttempts = await tx.modelUsageAttempt.deleteMany();
    const deletedRequests = await tx.modelRequest.deleteMany({ where: { status: { in: ["succeeded", "failed", "cancelled", "interrupted", "blocked"] } } });
    return { attempts: deletedAttempts.count, requests: deletedRequests.count };
  });
  response.json({ ok: true, data: result });
}));
