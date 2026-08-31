import { createHash } from "node:crypto";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { hasStoredApiKey } from "./apiKeyVault.js";
import {
  inferModelCapabilities,
  normalizeProviderKind,
  resolveModuleSettings,
  supportsModule,
  type AiModuleId
} from "./moduleModels.js";
import {
  calculateCostMicros,
  parseUsageBudgets,
  usagePeriodKeys
} from "./modelUsage.js";
import { getModelIdentity } from "./reliableModelCalls.js";
import type { ModelErrorCode } from "./modelErrors.js";
import { serializeSettings } from "../serializers.js";

export type ReadinessActionCode =
  | "unlock_app" | "create_character" | "select_character" | "configure_provider"
  | "add_api_key" | "fix_base_url" | "select_chat_model" | "configure_model_capabilities"
  | "review_fallbacks" | "review_pricing" | "review_budget" | "test_connection"
  | "retry_connection" | "create_chat" | "continue_chat" | "send_message" | "retry_server";

type ConfigurationDiagnosticCode =
  | "provider_missing" | "active_provider_missing" | "api_key_missing" | "base_url_invalid"
  | "base_url_protocol" | "base_url_credentials" | "base_url_sensitive_query" | "base_url_fragment"
  | "active_model_missing" | "chat_model_missing" | "chat_model_unsupported"
  | "module_preference_dangling" | "fallback_too_many" | "fallback_duplicate"
  | "fallback_self_reference" | "fallback_dangling" | "fallback_unsupported"
  | "fallback_vision_gap" | "pricing_unknown" | "budget_blocked";

export type ConfigurationDiagnosticIssueDTO = {
  code: ConfigurationDiagnosticCode;
  severity: "error" | "warning" | "info";
  field: "provider" | "apiKey" | "apiBaseUrl" | "model" | "capabilities" |
    "modulePreferences" | "fallbacks" | "pricing" | "budget";
  action: ReadinessActionCode;
  providerId?: string;
  modelId?: string;
  module?: AiModuleId;
};

export type ConnectionDiagnosticDTO = {
  status: "untested" | "checking" | "succeeded" | "failed" | "cancelled";
  mode: "metadata" | "inference" | null;
  testId: string | null;
  providerKind: "openai-compatible" | "anthropic" | "google-gemini" | null;
  providerId: string | null;
  modelId: string | null;
  checkedAt: string | null;
  errorCode: ModelErrorCode | null;
  diagnosticId: string | null;
  summary: string | null;
  retryable: boolean;
  suggestedAction: ReadinessActionCode | null;
  mayIncurCost: boolean;
};

type PublicUserSettingsDTO = ReturnType<typeof serializeSettings> & { hasApiKey: boolean };
type ProviderProfile = PublicUserSettingsDTO["providers"][number];

type ConnectionRecord = ConnectionDiagnosticDTO & { fingerprint: string };

let connectionRecord: ConnectionRecord | null = null;

const emptyConnection = (): ConnectionDiagnosticDTO => ({
  status: "untested",
  mode: null,
  testId: null,
  providerKind: null,
  providerId: null,
  modelId: null,
  checkedAt: null,
  errorCode: null,
  diagnosticId: null,
  summary: null,
  retryable: false,
  suggestedAction: "test_connection",
  mayIncurCost: false
});

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const publicSettings = (settings: UserSettings): PublicUserSettingsDTO => ({
  ...serializeSettings(settings),
  hasApiKey: hasStoredApiKey(settings.apiKey)
});

const providerHasKey = (settings: PublicUserSettingsDTO, provider?: ProviderProfile) =>
  Boolean(provider?.hasKey || settings.hasApiKey);

const localServiceHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local")) return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,2})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
};

const issue = (
  code: ConfigurationDiagnosticIssueDTO["code"],
  severity: ConfigurationDiagnosticIssueDTO["severity"],
  field: ConfigurationDiagnosticIssueDTO["field"],
  action: ReadinessActionCode,
  details: Partial<Pick<ConfigurationDiagnosticIssueDTO, "providerId" | "modelId" | "module">> = {}
): ConfigurationDiagnosticIssueDTO => ({ code, severity, field, action, ...details });

const inspectBaseUrl = (value: string, providerId?: string) => {
  const issues: ConfigurationDiagnosticIssueDTO[] = [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [issue("base_url_invalid", "error", "apiBaseUrl", "fix_base_url", { providerId })];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    issues.push(issue("base_url_protocol", "error", "apiBaseUrl", "fix_base_url", { providerId }));
  }
  if (url.username || url.password) {
    issues.push(issue("base_url_credentials", "error", "apiBaseUrl", "fix_base_url", { providerId }));
  }
  if (url.hash) {
    issues.push(issue("base_url_fragment", "error", "apiBaseUrl", "fix_base_url", { providerId }));
  }
  const sensitiveQuery = [...url.searchParams.keys()].some((key) =>
    /(?:api[-_]?key|token|secret|authorization|credential|password)/i.test(key)
  );
  if (sensitiveQuery) {
    issues.push(issue("base_url_sensitive_query", "error", "apiBaseUrl", "fix_base_url", { providerId }));
  }
  return issues;
};

const moduleIds: AiModuleId[] = [
  "chat",
  "agent",
  "memory",
  "memory_embedding",
  "user_profile",
  "voice_transcription",
  "voice_speech",
  "image_generation"
];

export const inspectConfiguration = (
  settings: PublicUserSettingsDTO,
  budgetAllowsChat = true
) => {
  const issues: ConfigurationDiagnosticIssueDTO[] = [];
  const providers = settings.providers;
  if (!providers.length) {
    issues.push(issue("provider_missing", "error", "provider", "configure_provider"));
  }

  const activeProvider = providers.find((provider) => provider.id === settings.activeProviderId);
  if (providers.length && !activeProvider) {
    issues.push(issue("active_provider_missing", "error", "provider", "configure_provider"));
  }
  if (activeProvider) {
    issues.push(...inspectBaseUrl(activeProvider.apiBaseUrl, activeProvider.id));
    let localWithoutKey = false;
    try {
      localWithoutKey = localServiceHost(new URL(activeProvider.apiBaseUrl).hostname);
    } catch {
      // URL diagnostics above owns the actionable error.
    }
    if (!providerHasKey(settings, activeProvider) && !localWithoutKey) {
      issues.push(issue("api_key_missing", "error", "apiKey", "add_api_key", { providerId: activeProvider.id }));
    }
  }

  const activeModel = activeProvider?.models.find((model) => model.id === settings.activeModelId);
  if (activeProvider && !activeModel) {
    issues.push(issue("active_model_missing", "error", "model", "select_chat_model", { providerId: activeProvider.id }));
  }

  const chatPreference = settings.moduleModelPreferences.chat;
  const chatProvider = chatPreference
    ? providers.find((provider) => provider.id === chatPreference.providerId)
    : activeProvider;
  const chatModel = chatPreference
    ? chatProvider?.models.find((model) => model.id === chatPreference.modelId)
    : activeModel;
  if (!chatProvider || !chatModel) {
    issues.push(issue("chat_model_missing", "error", "modulePreferences", "select_chat_model", {
      providerId: chatPreference?.providerId,
      modelId: chatPreference?.modelId,
      module: "chat"
    }));
  } else if (!supportsModule(chatProvider, chatModel, "chat")) {
    issues.push(issue("chat_model_unsupported", "error", "capabilities", "configure_model_capabilities", {
      providerId: chatProvider.id,
      modelId: chatModel.id,
      module: "chat"
    }));
  }

  for (const module of moduleIds) {
    const preference = settings.moduleModelPreferences[module];
    if (!preference) continue;
    const provider = providers.find((entry) => entry.id === preference.providerId);
    const model = provider?.models.find((entry) => entry.id === preference.modelId);
    if (!provider || !model) {
      issues.push(issue("module_preference_dangling", "error", "modulePreferences", "select_chat_model", {
        providerId: preference.providerId,
        modelId: preference.modelId,
        module
      }));
    }
  }

  const fallback = settings.modelReliability.fallback as Partial<Record<AiModuleId, {
    enabled: boolean;
    allowAutomatic?: boolean;
    chain: Array<{ providerId: string; modelId: string }>;
  }>>;
  for (const module of moduleIds) {
    const config = fallback[module];
    if (!config) continue;
    if (config.chain.length > 3) {
      issues.push(issue("fallback_too_many", "error", "fallbacks", "review_fallbacks", { module }));
    }
    const primary = settings.moduleModelPreferences[module] ??
      (settings.activeProviderId && settings.activeModelId
        ? { providerId: settings.activeProviderId, modelId: settings.activeModelId }
        : null);
    const seen = new Set<string>();
    for (const reference of config.chain) {
      const key = `${reference.providerId}\0${reference.modelId}`;
      if (seen.has(key)) {
        issues.push(issue("fallback_duplicate", "error", "fallbacks", "review_fallbacks", {
          providerId: reference.providerId,
          modelId: reference.modelId,
          module
        }));
        continue;
      }
      seen.add(key);
      if (primary && primary.providerId === reference.providerId && primary.modelId === reference.modelId) {
        issues.push(issue("fallback_self_reference", "error", "fallbacks", "review_fallbacks", {
          providerId: reference.providerId,
          modelId: reference.modelId,
          module
        }));
      }
      const provider = providers.find((entry) => entry.id === reference.providerId);
      const model = provider?.models.find((entry) => entry.id === reference.modelId);
      if (!provider || !model) {
        issues.push(issue("fallback_dangling", "error", "fallbacks", "review_fallbacks", {
          providerId: reference.providerId,
          modelId: reference.modelId,
          module
        }));
      } else if (!supportsModule(provider, model, module)) {
        issues.push(issue("fallback_unsupported", "error", "fallbacks", "review_fallbacks", {
          providerId: provider.id,
          modelId: model.id,
          module
        }));
      } else if (module === "chat" && !inferModelCapabilities(model.model).includes("vision_input") &&
        !(model.capabilities ?? []).includes("vision_input")) {
        issues.push(issue("fallback_vision_gap", "warning", "fallbacks", "review_fallbacks", {
          providerId: provider.id,
          modelId: model.id,
          module
        }));
      }
    }
  }

  if (chatModel && !chatModel.pricing) {
    issues.push(issue("pricing_unknown", "warning", "pricing", "review_pricing", {
      providerId: chatProvider?.id,
      modelId: chatModel.id,
      module: "chat"
    }));
  }
  if (!budgetAllowsChat) {
    issues.push(issue("budget_blocked", "error", "budget", "review_budget", { module: "chat" }));
  }
  return issues;
};

export const createConnectionFingerprint = (settings: UserSettings) => {
  let resolved = settings;
  try {
    resolved = resolveModuleSettings(settings, "chat");
  } catch {
    // The static diagnostics will explain the invalid reference.
  }
  const providerValues = Array.isArray(settings.providers) ? settings.providers : [];
  const active = providerValues.find((provider) => record(provider) && provider.id === resolved.activeProviderId);
  const model = record(active) && Array.isArray(active.models)
    ? active.models.find((entry) => record(entry) && entry.id === resolved.activeModelId)
    : null;
  return createHash("sha256").update(JSON.stringify({
    providerKind: normalizeProviderKind(resolved.activeProvider),
    providerId: resolved.activeProviderId,
    baseUrl: resolved.apiBaseUrl.trim(),
    modelId: resolved.activeModelId,
    model: resolved.model.trim(),
    capabilities: record(model) && Array.isArray(model.capabilities) ? model.capabilities : [],
    key: resolved.apiKey ?? ""
  })).digest("hex");
};

export const getConnectionDiagnostic = (settings: UserSettings): ConnectionDiagnosticDTO => {
  if (!connectionRecord || connectionRecord.fingerprint !== createConnectionFingerprint(settings)) {
    return emptyConnection();
  }
  const { fingerprint: _fingerprint, ...diagnostic } = connectionRecord;
  return diagnostic;
};

export const setConnectionDiagnostic = (settings: UserSettings, value: ConnectionDiagnosticDTO) => {
  connectionRecord = { ...value, fingerprint: createConnectionFingerprint(settings) };
};

export const clearConnectionDiagnostic = () => {
  connectionRecord = null;
};

export const budgetAllowsChat = async (settings: UserSettings) => {
  let resolved: UserSettings;
  try {
    resolved = resolveModuleSettings(settings, "chat");
  } catch {
    return true;
  }
  const identity = getModelIdentity(resolved);
  const budgets = parseUsageBudgets(resolved.usageBudgets);
  const projected = calculateCostMicros(1, Math.max(1, resolved.maxTokens), identity.pricing);
  if (projected === null) return budgets.allowUnknownPricing;
  const periods = usagePeriodKeys(new Date(), resolved.usageTimezone || "UTC");
  const [daily, monthly] = await Promise.all([
    prisma.modelUsageAttempt.aggregate({
      where: { reservationDay: periods.day },
      _sum: { estimatedCostMicros: true, reservedCostMicros: true }
    }),
    prisma.modelUsageAttempt.aggregate({
      where: { reservationMonth: periods.month },
      _sum: { estimatedCostMicros: true, reservedCostMicros: true }
    })
  ]);
  const dailyUsed = (daily._sum.estimatedCostMicros ?? 0) + (daily._sum.reservedCostMicros ?? 0);
  const monthlyUsed = (monthly._sum.estimatedCostMicros ?? 0) + (monthly._sum.reservedCostMicros ?? 0);
  return !(
    (budgets.dailyHardMicros !== null && dailyUsed + projected > budgets.dailyHardMicros) ||
    (budgets.monthlyHardMicros !== null && monthlyUsed + projected > budgets.monthlyHardMicros)
  );
};

const actionFromIssues = (issues: ConfigurationDiagnosticIssueDTO[]): ReadinessActionCode =>
  issues.find((entry) => entry.severity === "error")?.action ?? "test_connection";

export const computeReadiness = (input: {
  settings: PublicUserSettingsDTO;
  characterCount: number;
  chatCount: number;
  budgetAllowsChat: boolean;
  connectionStatus?: ConnectionDiagnosticDTO;
  appLocked?: boolean;
  serverReachable?: boolean;
  computedAt?: string;
}) => {
  const issues = inspectConfiguration(input.settings, input.budgetAllowsChat);
  const errors = issues.filter((entry) => entry.severity === "error");
  const activeProvider = input.settings.providers.find((entry) => entry.id === input.settings.activeProviderId);
  const activeModel = activeProvider?.models.find((entry) => entry.id === input.settings.activeModelId);
  const chatPreference = input.settings.moduleModelPreferences.chat;
  const chatProvider = chatPreference
    ? input.settings.providers.find((entry) => entry.id === chatPreference.providerId)
    : activeProvider;
  const chatModel = chatPreference
    ? chatProvider?.models.find((entry) => entry.id === chatPreference.modelId)
    : activeModel;
  const connectionStatus = input.connectionStatus ?? emptyConnection();
  const serverReachable = input.serverReachable !== false;
  const appLocked = input.appLocked === true;
  const hasCharacter = input.characterCount > 0;
  const hasProvider = input.settings.providers.length > 0;
  const hasApiKey = Boolean(activeProvider?.hasKey || input.settings.hasApiKey);
  const hasActiveModel = Boolean(activeModel);
  const chatModuleAssigned = Boolean(chatProvider && chatModel);
  const chatModelSupportsText = Boolean(chatProvider && chatModel && supportsModule(chatProvider, chatModel, "chat"));
  const visionAvailable = Boolean(
    chatModel && (chatModel.capabilities ?? inferModelCapabilities(chatModel.model)).includes("vision_input")
  );
  const configurationValid = errors.length === 0;
  const ready = serverReachable && !appLocked && hasCharacter && configurationValid && input.budgetAllowsChat;

  let overallStatus:
    | "ready" | "ready_with_limited_capabilities" | "needs_configuration"
    | "configuration_untested" | "connection_failed" | "budget_blocked"
    | "locked" | "server_unreachable" = "ready";
  if (!serverReachable) overallStatus = "server_unreachable";
  else if (appLocked) overallStatus = "locked";
  else if (!input.budgetAllowsChat) overallStatus = "budget_blocked";
  else if (!configurationValid || !hasCharacter) overallStatus = "needs_configuration";
  else if (connectionStatus.status === "failed") overallStatus = "connection_failed";
  else if (connectionStatus.status !== "succeeded") overallStatus = "configuration_untested";
  else if (!visionAvailable || issues.some((entry) => entry.severity === "warning")) {
    overallStatus = "ready_with_limited_capabilities";
  }

  let nextRecommendedAction: ReadinessActionCode;
  if (!serverReachable) nextRecommendedAction = "retry_server";
  else if (appLocked) nextRecommendedAction = "unlock_app";
  else if (!hasCharacter) nextRecommendedAction = "create_character";
  else if (errors.length) nextRecommendedAction = actionFromIssues(errors);
  else if (connectionStatus.status === "failed") nextRecommendedAction = "retry_connection";
  else if (connectionStatus.status !== "succeeded") nextRecommendedAction = "test_connection";
  else if (!input.chatCount) nextRecommendedAction = "create_chat";
  else nextRecommendedAction = "continue_chat";

  return {
    serverReachable,
    appLocked,
    hasCharacter,
    hasAvailableCharacter: hasCharacter,
    hasChat: input.chatCount > 0,
    hasProvider,
    hasApiKey,
    hasActiveModel,
    chatModuleAssigned,
    chatModelSupportsText,
    visionAvailable,
    budgetAllowsChat: input.budgetAllowsChat,
    configurationValid,
    ready,
    overallStatus,
    connectionStatus,
    nextRecommendedAction,
    issues,
    characterCount: input.characterCount,
    chatCount: input.chatCount,
    computedAt: input.computedAt ?? new Date().toISOString()
  };
};

export const loadReadiness = async (settings: UserSettings) => {
  const [characterCount, chatCount, allowsChat] = await Promise.all([
    prisma.character.count(),
    prisma.chat.count({ where: { deletedAt: null, isCheckpoint: false } }),
    budgetAllowsChat(settings)
  ]);
  return computeReadiness({
    settings: publicSettings(settings),
    characterCount,
    chatCount,
    budgetAllowsChat: allowsChat,
    connectionStatus: getConnectionDiagnostic(settings)
  });
};
