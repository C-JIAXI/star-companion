import { Router } from "express";
import type { Prisma, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { fetchAvailableModels } from "../services/completions.js";
import { settingsUpdateSchema, userProfileUpdateSchema } from "../schemas.js";
import { serializeSettings } from "../serializers.js";
import { encryptApiKey, hasStoredApiKey, isEncryptedApiKey } from "../services/apiKeyVault.js";
import { validateModelReliabilitySettings, validateModuleModelPreferences } from "../services/moduleModels.js";
import { getConfiguredMemoryEmbeddingSource } from "../services/chatMemories.js";
import { HttpError } from "../lib/http.js";
import { randomUUID } from "node:crypto";
import { executeReliableTextCompletion } from "../services/reliableModelCalls.js";

export const settingsRouter = Router();

const generateId = () => Math.random().toString(36).slice(2, 12);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeStoredApiKey = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  return isEncryptedApiKey(value) ? value : encryptApiKey(value) ?? undefined;
};

const getProviderKeys = (providers: Prisma.JsonValue) => {
  const keys = new Map<string, string>();
  if (!Array.isArray(providers)) {
    return keys;
  }

  for (const provider of providers) {
    if (!isRecord(provider) || typeof provider.id !== "string") {
      continue;
    }

    const key = normalizeStoredApiKey(provider.key);
    if (key) {
      keys.set(provider.id, key);
    }
  }

  return keys;
};

const mergeProviderProfiles = (
  incomingProviders: Array<Record<string, unknown>>,
  storedProviders: Prisma.JsonValue
) => {
  const storedKeys = getProviderKeys(storedProviders);

  return incomingProviders.map((profile) => {
    const merged = { ...profile };
    const hasSubmittedKey = Object.prototype.hasOwnProperty.call(profile, "key");
    const key = hasSubmittedKey
      ? normalizeStoredApiKey(profile.key)
      : storedKeys.get(String(profile.id));

    if (key) {
      merged.key = key;
    } else {
      delete merged.key;
    }

    return merged;
  });
};

const encryptLegacyProviderKeys = async (settings: UserSettings) => {
  const providers = settings.providers;
  if (!Array.isArray(providers)) {
    return settings;
  }

  let changed = false;
  const encryptedProviders = providers.map((provider) => {
    if (!isRecord(provider)) {
      return provider;
    }

    const key = normalizeStoredApiKey(provider.key);
    if (!key || key === provider.key) {
      return provider;
    }

    changed = true;
    return { ...provider, key };
  });

  if (!changed) {
    return settings;
  }

  await prisma.userSettings.update({
    where: { id: settings.id },
    data: { providers: encryptedProviders as Prisma.JsonArray }
  });

  return prisma.userSettings.findUniqueOrThrow({ where: { id: settings.id } });
};

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

  const migratedProviders = Array.from(groupMap.values()).map((group) => {
    const key = normalizeStoredApiKey(group.key);
    return {
      id: generateId(),
      label: group.provider || "custom",
      provider: group.provider,
      apiBaseUrl: group.apiBaseUrl,
      ...(key ? { key } : {}),
      models: group.models
    };
  });

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
    return encryptLegacyProviderKeys(await migrateModelsToProviders(existing));
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
    const call = await executeReliableTextCompletion({
      settings,
      messages: [{ role: "user", content: "Connection test" }],
      maxTokens: Math.min(Math.max(settings.maxTokens, 1), 16),
      temperature: 0,
      context: { requestId: `connection_${randomUUID()}`, module: "chat", operation: "connection_test" }
    });
    if (!call.content.trim()) throw new HttpError(502, "Model connection test returned an empty response");
    const result = { reachable: true, model: call.modelId, checkedAt: new Date().toISOString() };

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
    const providers: unknown[] = Array.isArray(settings.providers) ? settings.providers : [];
    const storedProvider = providers.find(
      (provider): provider is Record<string, unknown> =>
        isRecord(provider) && String(provider.id) === request.params.providerId
    );

    if (body && typeof body === "object" && typeof body.apiBaseUrl === "string") {
      activeProvider = String(body.provider ?? "");
      apiBaseUrl = body.apiBaseUrl;
      if (typeof body.key === "string" && body.key) {
        apiKey = body.key;
      } else if (typeof storedProvider?.key === "string" && storedProvider.key) {
        apiKey = storedProvider.key;
      }
    } else {
      if (!storedProvider) {
        response.status(404).json({ ok: false, error: "Provider not found" });
        return;
      }

      activeProvider = String(storedProvider.provider ?? "");
      apiBaseUrl = String(storedProvider.apiBaseUrl ?? "");
      if (typeof storedProvider.key === "string" && storedProvider.key) {
        apiKey = storedProvider.key;
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
    const existingSettings = serializeSettings(existing);
    const moduleModelPreferences =
      body.moduleModelPreferences ?? existingSettings.moduleModelPreferences;
    const userPersonaPresets = body.userPersonaPresets ?? existingSettings.userPersonaPresets;
    const modelReliability = body.modelReliability ?? existingSettings.modelReliability;
    const usageBudgets = body.usageBudgets ?? existingSettings.usageBudgets;
    const usageTimezone = body.usageTimezone ?? existingSettings.usageTimezone;
    const appearancePreferences = body.appearancePreferences ?? existingSettings.appearancePreferences;

    const moduleModelError = validateModuleModelPreferences(
      body.providers,
      moduleModelPreferences,
      body.activeProviderId,
      body.activeModelId
    );
    if (moduleModelError) {
      throw new HttpError(400, moduleModelError);
    }
    const reliabilityError = validateModelReliabilitySettings(body.providers, modelReliability);
    if (reliabilityError) {
      throw new HttpError(400, reliabilityError);
    }

    const storedProviders = mergeProviderProfiles(
      body.providers as Array<Record<string, unknown>>,
      existing.providers
    );
    const activeProfile = body.providers.find((p) => p.id === body.activeProviderId);
    const storedActiveProfile = storedProviders.find(
      (profile) => String(profile.id) === body.activeProviderId
    );
    const activeModel = activeProfile?.models.find((m) => m.id === body.activeModelId);

    const resolvedProvider = activeProfile?.provider ?? body.activeProvider;
    const resolvedBaseUrl = activeProfile?.apiBaseUrl ?? body.apiBaseUrl;
    const resolvedModel = activeModel?.model ?? body.model;
    const resolvedApiKey =
      (typeof storedActiveProfile?.key === "string" ? storedActiveProfile.key : undefined) ??
      ("apiKey" in body ? encryptApiKey(body.apiKey) : undefined);

    const data: Prisma.UserSettingsUpdateInput = {
      providers: storedProviders as Prisma.JsonArray,
      activeProviderId: body.activeProviderId,
      activeModelId: body.activeModelId,
      moduleModelPreferences: moduleModelPreferences as Prisma.JsonObject,
      userPersonaPresets: userPersonaPresets as Prisma.JsonArray,
      modelReliability: modelReliability as unknown as Prisma.JsonObject,
      usageBudgets: usageBudgets as unknown as Prisma.JsonObject,
      usageTimezone,
      activeProvider: resolvedProvider,
      apiBaseUrl: resolvedBaseUrl,
      model: resolvedModel,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      autoSummarizeUser: body.autoSummarizeUser,
      showMessageAvatars: body.showMessageAvatars,
      showMessageTimestamps: body.showMessageTimestamps,
      appearancePreferences: appearancePreferences as unknown as Prisma.JsonObject,
      ttsVoice: body.ttsVoice,
      ttsPlaybackRate: body.ttsPlaybackRate,
      ttsAutoPlay: body.ttsAutoPlay,
      userProfileSummary: body.userProfileSummary,
      userProfileUpdatedAt:
        typeof body.userProfileSummary === "string" ? new Date() : undefined,
      apiKey: resolvedApiKey
    };

    const settings = await prisma.userSettings.update({
      where: { id: existing.id },
      data
    });

    let memoryEmbeddingSourceChanged = false;
    try {
      memoryEmbeddingSourceChanged =
        getConfiguredMemoryEmbeddingSource(existing) !== getConfiguredMemoryEmbeddingSource(settings);
    } catch {
      memoryEmbeddingSourceChanged = true;
    }
    if (memoryEmbeddingSourceChanged) {
      await prisma.chatMemory.updateMany({
        data: {
          embeddingStatus: "stale",
          embeddingSource: null,
          embeddingDimensions: null,
          embeddingUpdatedAt: null
        }
      });
    }

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
