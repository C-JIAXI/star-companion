import { Router } from "express";
import type { Prisma, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { fetchAvailableModels, testModelConnection } from "../services/completions.js";
import { settingsUpdateSchema, userProfileUpdateSchema } from "../schemas.js";
import { serializeSettings } from "../serializers.js";
import { encryptApiKey, hasStoredApiKey } from "../services/apiKeyVault.js";

export const settingsRouter = Router();

const generateId = () => Math.random().toString(36).slice(2, 12);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const migrateModelsToProviders = async (settings: UserSettings) => {
  const providers = settings.providers;
  const models = settings.models;

  if (
    Array.isArray(providers) && providers.length > 0
  ) {
    return settings;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return settings;
  }

  const groupMap = new Map<string, { provider: string; apiBaseUrl: string; key?: string; models: { id: string; label: string; model: string }[] }>();

  for (const preset of models) {
    if (!isRecord(preset)) {
      continue;
    }

    const provider = String(preset.provider ?? "");
    const apiBaseUrl = String(preset.apiBaseUrl ?? "");
    const key = typeof preset.key === "string" ? preset.key : undefined;
    const modelId = String(preset.model ?? "");
    const label = String(preset.label ?? modelId);

    const groupKey = `${provider}\0${apiBaseUrl}`;
    let group = groupMap.get(groupKey);

    if (!group) {
      group = { provider, apiBaseUrl, key, models: [] };
      groupMap.set(groupKey, group);
    }

    if (key && !group.key) {
      group.key = key;
    }

    group.models.push({ id: generateId(), label, model: modelId });
  }

  const migratedProviders = Array.from(groupMap.values()).map((group) => ({
    id: generateId(),
    label: group.provider || "custom",
    provider: group.provider,
    apiBaseUrl: group.apiBaseUrl,
    key: group.key,
    models: group.models
  }));

  let activeProviderId = "";
  let activeModelId = "";

  for (const provider of migratedProviders) {
    if (
      provider.provider === settings.activeProvider &&
      provider.apiBaseUrl === settings.apiBaseUrl
    ) {
      activeProviderId = provider.id;
      const matchedModel = provider.models.find((m) => m.model === settings.model);
      activeModelId = matchedModel?.id ?? provider.models[0]?.id ?? "";
      break;
    }
  }

  if (!activeProviderId && migratedProviders.length > 0) {
    activeProviderId = migratedProviders[0].id;
    activeModelId = migratedProviders[0].models[0]?.id ?? "";
  }

  await prisma.userSettings.update({
    where: { id: settings.id },
    data: {
      providers: migratedProviders as unknown as Prisma.JsonArray,
      activeProviderId,
      activeModelId
    }
  });

  return prisma.userSettings.findUniqueOrThrow({ where: { id: settings.id } });
};

export const getOrCreateSettings = async () => {
  const existing = await prisma.userSettings.findFirst({
    orderBy: { createdAt: "asc" }
  });

  if (existing) {
    return migrateModelsToProviders(existing);
  }

  return prisma.userSettings.create({ data: {} });
};

settingsRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: hasStoredApiKey(settings.apiKey)
      }
    });
  })
);

settingsRouter.post(
  "/test",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();
    const result = await testModelConnection(settings);

    response.json({
      ok: true,
      data: result
    });
  })
);

settingsRouter.get(
  "/models",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();
    const result = await fetchAvailableModels(settings);

    response.json({
      ok: true,
      data: result
    });
  })
);

settingsRouter.post(
  "/providers/:providerId/models",
  asyncHandler(async (request, response) => {
    const settings = await getOrCreateSettings();
    const body = request.body as Record<string, unknown> | undefined;

    let activeProvider = "";
    let apiBaseUrl = "";
    let apiKey = settings.apiKey;

    if (body && typeof body === "object" && typeof body.apiBaseUrl === "string") {
      activeProvider = String(body.provider ?? "");
      apiBaseUrl = body.apiBaseUrl;
      if (typeof body.key === "string" && body.key) {
        apiKey = body.key;
      }
    } else {
      const providers: unknown[] = Array.isArray(settings.providers) ? settings.providers : [];
      const targetProvider = providers.find(
        (provider): provider is Record<string, unknown> =>
          isRecord(provider) && String(provider.id) === request.params.providerId
      );

      if (!targetProvider) {
        response.status(404).json({ ok: false, error: "Provider not found" });
        return;
      }

      activeProvider = String(targetProvider.provider ?? "");
      apiBaseUrl = String(targetProvider.apiBaseUrl ?? "");
      if (typeof targetProvider.key === "string" && targetProvider.key) {
        apiKey = targetProvider.key;
      }
    }

    const providerSettings: UserSettings = {
      ...settings,
      activeProvider,
      apiBaseUrl,
      apiKey
    };

    const result = await fetchAvailableModels(providerSettings);

    response.json({
      ok: true,
      data: result
    });
  })
);

settingsRouter.put(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const existing = await getOrCreateSettings();

    const activeProfile = body.providers.find((p) => p.id === body.activeProviderId);
    const activeModel = activeProfile?.models.find((m) => m.id === body.activeModelId);

    const resolvedProvider = activeProfile?.provider ?? body.activeProvider;
    const resolvedBaseUrl = activeProfile?.apiBaseUrl ?? body.apiBaseUrl;
    const resolvedModel = activeModel?.model ?? body.model;
    const resolvedApiKey = activeProfile?.key ?? ("apiKey" in body ? body.apiKey : undefined);

    const data: Prisma.UserSettingsUpdateInput = {
      providers: body.providers as Prisma.JsonArray,
      activeProviderId: body.activeProviderId,
      activeModelId: body.activeModelId,
      activeProvider: resolvedProvider,
      apiBaseUrl: resolvedBaseUrl,
      model: resolvedModel,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      autoSummarizeUser: body.autoSummarizeUser,
      showMessageAvatars: body.showMessageAvatars,
      userProfileSummary: body.userProfileSummary,
      userProfileUpdatedAt:
        typeof body.userProfileSummary === "string" ? new Date() : undefined,
      apiKey: resolvedApiKey !== undefined ? encryptApiKey(resolvedApiKey) : undefined
    };

    const settings = await prisma.userSettings.update({
      where: { id: existing.id },
      data
    });

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: hasStoredApiKey(settings.apiKey)
      }
    });
  })
);

settingsRouter.put(
  "/user-profile",
  asyncHandler(async (request, response) => {
    const body = parseBody(userProfileUpdateSchema, request.body);
    const existing = await getOrCreateSettings();
    const settings = await prisma.userSettings.update({
      where: { id: existing.id },
      data: {
        userProfileSummary: body.userProfileSummary.trim(),
        autoSummarizeUser: body.autoSummarizeUser,
        userProfileUpdatedAt: body.userProfileSummary.trim() ? new Date() : null
      }
    });

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: hasStoredApiKey(settings.apiKey)
      }
    });
  })
);
