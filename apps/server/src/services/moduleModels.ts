import type { Prisma, UserSettings } from "@prisma/client";

export type AiModuleId =
  | "chat"
  | "agent"
  | "memory"
  | "memory_embedding"
  | "user_profile"
  | "voice_transcription"
  | "voice_speech"
  | "image_generation";

type ProviderModel = {
  id: string;
  label: string;
  model: string;
  contextWindow?: number;
  capabilities?: AiModelCapability[];
  pricing?: {
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    currency: "USD";
    updatedAt: string;
    source: "user" | "template";
  };
};

type ProviderProfile = {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  key?: string;
  models: ProviderModel[];
};

type AiModelCapability =
  | "text_generation"
  | "text_embedding"
  | "audio_transcription"
  | "text_to_speech"
  | "image_generation";

const moduleCapabilities: Record<AiModuleId, AiModelCapability> = {
  chat: "text_generation",
  agent: "text_generation",
  memory: "text_generation",
  memory_embedding: "text_embedding",
  user_profile: "text_generation",
  voice_transcription: "audio_transcription",
  voice_speech: "text_to_speech",
  image_generation: "image_generation"
};

const validCapabilities = new Set<AiModelCapability>([
  "text_generation",
  "text_embedding",
  "audio_transcription",
  "text_to_speech",
  "image_generation"
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toProviderProfiles = (value: Prisma.JsonValue): ProviderProfile[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[])
    .filter((provider): provider is Record<string, unknown> => isRecord(provider))
    .map((provider) => ({
      id: String(provider.id ?? ""),
      label: String(provider.label ?? ""),
      provider: String(provider.provider ?? ""),
      apiBaseUrl: String(provider.apiBaseUrl ?? ""),
      key: typeof provider.key === "string" ? provider.key : undefined,
      models: Array.isArray(provider.models)
        ? provider.models
            .filter((model): model is Record<string, unknown> => isRecord(model))
            .map((model) => ({
            id: String(model.id ?? ""),
            label: String(model.label ?? ""),
            model: String(model.model ?? ""),
            contextWindow:
              typeof model.contextWindow === "number" && Number.isInteger(model.contextWindow)
                ? model.contextWindow
                : undefined,
            capabilities: Array.isArray(model.capabilities)
              ? model.capabilities.filter(
                  (capability): capability is AiModelCapability =>
                    typeof capability === "string" && validCapabilities.has(capability as AiModelCapability)
                )
              : undefined,
            pricing: isRecord(model.pricing) &&
              typeof model.pricing.inputMicrosPerMillion === "number" &&
              typeof model.pricing.outputMicrosPerMillion === "number" &&
              model.pricing.currency === "USD"
                ? model.pricing as ProviderModel["pricing"]
                : undefined
          }))
        : []
    }));
};

const getModulePreference = (settings: UserSettings, moduleId: AiModuleId) => {
  const raw = settings.moduleModelPreferences;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const entry = (raw as Record<string, unknown>)[moduleId];
  if (!isRecord(entry)) {
    return null;
  }

  const providerId = entry.providerId;
  const modelId = entry.modelId;
  if (typeof providerId !== "string" || typeof modelId !== "string") {
    return null;
  }

  return { providerId, modelId };
};

export const resolveModuleSettings = (
  settings: UserSettings,
  moduleId: AiModuleId
): UserSettings => {
  const preference = getModulePreference(settings, moduleId);
  const providers = toProviderProfiles(settings.providers);

  if (!preference) {
    const activeProvider =
      providers.find((entry) => entry.id === settings.activeProviderId) ?? {
        provider: settings.activeProvider
      };
    const activeModel =
      providers
        .find((entry) => entry.id === settings.activeProviderId)
        ?.models.find((entry) => entry.id === settings.activeModelId) ?? { model: settings.model };

    if (!supportsModule(activeProvider, activeModel, moduleId)) {
      throw new Error(
        `No compatible model is configured for ${moduleId}. Choose a model with the required capability in Settings.`
      );
    }
    return settings;
  }

  const provider = providers.find((entry) => entry.id === preference.providerId);
  const model = provider?.models.find((entry) => entry.id === preference.modelId);

  if (!provider || !model) {
    throw new Error(`The configured ${moduleId} model no longer exists.`);
  }

  if (!supportsModule(provider, model, moduleId)) {
    throw new Error(`The configured ${moduleId} model does not support this feature.`);
  }

  return {
    ...settings,
    activeProvider: provider.provider,
    apiBaseUrl: provider.apiBaseUrl,
    apiKey: provider.key?.trim() ? provider.key : settings.apiKey,
    model: model.model,
    activeProviderId: provider.id,
    activeModelId: model.id
  };
};

export const resolveModelReferenceSettings = (
  settings: UserSettings,
  moduleId: AiModuleId,
  reference: { providerId: string; modelId: string }
) => {
  const providers = toProviderProfiles(settings.providers);
  const provider = providers.find((entry) => entry.id === reference.providerId);
  const model = provider?.models.find((entry) => entry.id === reference.modelId);
  if (!provider || !model) {
    throw new Error(`The configured ${moduleId} fallback model no longer exists.`);
  }
  if (!supportsModule(provider, model, moduleId)) {
    throw new Error(`The configured ${moduleId} fallback model does not support this feature.`);
  }
  return {
    ...settings,
    activeProvider: provider.provider,
    apiBaseUrl: provider.apiBaseUrl,
    apiKey: provider.key?.trim() ? provider.key : settings.apiKey,
    model: model.model,
    activeProviderId: provider.id,
    activeModelId: model.id
  };
};

export const resolveAutomaticFallbackSettings = (settings: UserSettings, moduleId: AiModuleId) => {
  if (!isRecord(settings.modelReliability) || !isRecord(settings.modelReliability.fallback)) return [];
  const moduleFallback = settings.modelReliability.fallback[moduleId];
  if (!isRecord(moduleFallback) || moduleFallback.enabled !== true) return [];
  if (moduleId === "chat" && moduleFallback.allowAutomatic !== true) return [];
  const chain = Array.isArray(moduleFallback.chain) ? moduleFallback.chain : [];
  const primary = resolveModuleSettings(settings, moduleId);
  const seen = new Set([`${primary.activeProviderId}\0${primary.activeModelId}`]);
  const candidates: UserSettings[] = [];
  for (const raw of chain.slice(0, 3)) {
    if (!isRecord(raw) || typeof raw.providerId !== "string" || typeof raw.modelId !== "string") continue;
    const key = `${raw.providerId}\0${raw.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(resolveModelReferenceSettings(settings, moduleId, { providerId: raw.providerId, modelId: raw.modelId }));
  }
  return candidates;
};

export const validateModelReliabilitySettings = (providers: ProviderProfile[], reliability: unknown) => {
  if (!isRecord(reliability) || !isRecord(reliability.fallback)) return null;
  for (const moduleId of Object.keys(moduleCapabilities) as AiModuleId[]) {
    const config = reliability.fallback[moduleId];
    if (!isRecord(config) || !Array.isArray(config.chain)) continue;
    const seen = new Set<string>();
    for (const reference of config.chain) {
      if (!isRecord(reference) || typeof reference.providerId !== "string" || typeof reference.modelId !== "string") continue;
      const key = `${reference.providerId}\0${reference.modelId}`;
      if (seen.has(key)) return `The ${moduleId} fallback chain contains a duplicate model.`;
      seen.add(key);
      const provider = providers.find((entry) => entry.id === reference.providerId);
      const model = provider?.models.find((entry) => entry.id === reference.modelId);
      if (!provider || !model) return `The selected ${moduleId} fallback model no longer exists.`;
      if (!supportsModule(provider, model, moduleId)) return `A selected fallback model does not support ${moduleId}.`;
    }
  }
  return null;
};

export const normalizeProviderKind = (provider: string) => {
  const normalized = provider.trim().toLowerCase();

  if (["anthropic", "claude", "claude-native"].includes(normalized)) {
    return "anthropic";
  }

  if (["google", "google-gemini", "gemini", "gemini-native"].includes(normalized)) {
    return "google-gemini";
  }

  return "openai-compatible";
};

export const inferModelCapabilities = (model: string): AiModelCapability[] => {
  const normalized = model.trim().toLowerCase();

  if (/(?:^|[-_/])(?:embedding|embed|bge|e5|gte|nomic|jina|mxbai)(?:[-_/]|$)/.test(normalized)) {
    return ["text_embedding"];
  }

  if (/(^|[-_/])(?:whisper|transcribe|stt)(?:[-_/]|$)/.test(normalized)) {
    return ["audio_transcription"];
  }
  if (/(^|[-_/])(?:tts|speech)(?:[-_/]|$)/.test(normalized)) {
    return ["text_to_speech"];
  }
  if (/(?:dall[\-_.]?e|gpt[\-_.]?image|imagegen|stable[\-_.]?diffusion|(?:^|[-_/])sdxl?(?:[-_/]|$)|flux)/.test(normalized)) {
    return ["image_generation"];
  }

  return ["text_generation"];
};

export const supportsModule = (
  provider: Pick<ProviderProfile, "provider">,
  model: Pick<ProviderModel, "model" | "capabilities">,
  moduleId: AiModuleId
) => {
  const providerKind = normalizeProviderKind(provider.provider);
  const isMediaModule = ["voice_transcription", "voice_speech", "image_generation"].includes(moduleId);
  if (isMediaModule && providerKind !== "openai-compatible") {
    return false;
  }
  if (moduleId === "memory_embedding" && providerKind === "anthropic") {
    return false;
  }

  const capabilities = Array.isArray(model.capabilities)
    ? model.capabilities
    : inferModelCapabilities(model.model);
  return capabilities.includes(moduleCapabilities[moduleId]);
};

export const validateModuleModelPreferences = (
  providers: ProviderProfile[],
  preferences: unknown,
  activeProviderId?: string,
  activeModelId?: string
) => {
  if (activeProviderId && activeModelId) {
    const provider = providers.find((entry) => entry.id === activeProviderId);
    const model = provider?.models.find((entry) => entry.id === activeModelId);
    if (!provider || !model) {
      return "The selected chat model no longer exists.";
    }
    if (!supportsModule(provider, model, "chat")) {
      return "The selected model does not support chat.";
    }
  }

  if (!isRecord(preferences)) {
    return null;
  }

  for (const moduleId of Object.keys(moduleCapabilities) as AiModuleId[]) {
    const preference = preferences[moduleId];
    if (!isRecord(preference)) {
      continue;
    }

    const providerId = preference.providerId;
    const modelId = preference.modelId;
    const provider = providers.find((entry) => entry.id === providerId);
    const model = provider?.models.find((entry) => entry.id === modelId);
    if (!provider || !model) {
      return `The selected ${moduleId} model no longer exists.`;
    }
    if (!supportsModule(provider, model, moduleId)) {
      return `The selected model does not support ${moduleId}.`;
    }
  }

  return null;
};
