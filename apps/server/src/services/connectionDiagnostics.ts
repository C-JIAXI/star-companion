import { randomUUID } from "node:crypto";
import type { Prisma, UserSettings } from "@prisma/client";
import { fetchAvailableModels } from "./completions.js";
import {
  createModelError,
  ModelCallError,
  normalizeModelError,
  type ModelErrorCode
} from "./modelErrors.js";
import { normalizeProviderKind, resolveModuleSettings } from "./moduleModels.js";
import { executeReliableTextCompletion } from "./reliableModelCalls.js";
import {
  createConnectionFingerprint,
  loadReadiness,
  setConnectionDiagnostic,
  type ConnectionDiagnosticDTO,
  type ReadinessActionCode
} from "./readiness.js";

type ConnectionTestMode = "metadata" | "inference";

type ActiveTest = {
  testId: string;
  fingerprint: string;
  controller: AbortController;
};

const activeTests = new Map<string, ActiveTest>();
const activeFingerprintTests = new Map<string, string>();

export class ConnectionTestAlreadyRunningError extends Error {
  constructor(readonly testId: string) {
    super("A connection test is already running for this saved configuration.");
  }
}

const actionForError = (code: ModelErrorCode): ReadinessActionCode => {
  if (code === "authentication") return "add_api_key";
  if (code === "invalid_url") return "fix_base_url";
  if (code === "model_not_found" || code === "unsupported_capability") return "select_chat_model";
  if (code === "budget_blocked") return "review_budget";
  if (code === "configuration_incomplete") return "configure_provider";
  return "retry_connection";
};

const normalizeModelId = (value: string) => value.trim().replace(/^models\//, "");

const successDiagnostic = (
  testId: string,
  mode: ConnectionTestMode,
  settings: UserSettings
): ConnectionDiagnosticDTO => ({
  status: "succeeded",
  mode,
  testId,
  providerKind: normalizeProviderKind(settings.activeProvider),
  providerId: settings.activeProviderId || null,
  modelId: settings.activeModelId || settings.model || null,
  checkedAt: new Date().toISOString(),
  errorCode: null,
  diagnosticId: `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  summary: mode === "metadata"
    ? "Provider metadata verified the saved model configuration."
    : "A minimal provider inference completed successfully.",
  retryable: false,
  suggestedAction: "create_chat",
  mayIncurCost: mode === "inference"
});

const failedDiagnostic = (
  testId: string,
  mode: ConnectionTestMode,
  settings: UserSettings,
  error: ModelCallError
): ConnectionDiagnosticDTO => ({
  status: error.safe.code === "cancelled" ? "cancelled" : "failed",
  mode,
  testId,
  providerKind: normalizeProviderKind(settings.activeProvider),
  providerId: settings.activeProviderId || null,
  modelId: settings.activeModelId || settings.model || null,
  checkedAt: new Date().toISOString(),
  errorCode: error.safe.code,
  diagnosticId: error.safe.diagnosticId,
  summary: error.safe.summary,
  retryable: error.safe.retryable,
  suggestedAction: actionForError(error.safe.code),
  mayIncurCost: mode === "inference"
});

export const runConnectionTest = async (input: {
  settings: UserSettings;
  mode: ConnectionTestMode;
  confirmCost?: boolean;
}) => {
  const readiness = await loadReadiness(input.settings);
  if (!readiness.configurationValid) {
    throw createModelError({
      code: "configuration_incomplete",
      provider: input.settings.activeProvider || "openai-compatible",
      modelId: input.settings.model || "unconfigured"
    });
  }
  if (input.mode === "inference" && input.confirmCost !== true) {
    throw createModelError({
      code: "configuration_incomplete",
      provider: input.settings.activeProvider,
      modelId: input.settings.model
    });
  }

  const resolved = resolveModuleSettings(input.settings, "chat");
  const fingerprint = createConnectionFingerprint(input.settings);
  const running = activeFingerprintTests.get(fingerprint);
  if (running) throw new ConnectionTestAlreadyRunningError(running);

  const testId = `connection_${randomUUID()}`;
  const controller = new AbortController();
  activeTests.set(testId, { testId, fingerprint, controller });
  activeFingerprintTests.set(fingerprint, testId);
  setConnectionDiagnostic(input.settings, {
    status: "checking",
    mode: input.mode,
    testId,
    providerKind: normalizeProviderKind(resolved.activeProvider),
    providerId: resolved.activeProviderId || null,
    modelId: resolved.activeModelId || resolved.model || null,
    checkedAt: null,
    errorCode: null,
    diagnosticId: null,
    summary: "Connection check in progress.",
    retryable: false,
    suggestedAction: null,
    mayIncurCost: input.mode === "inference"
  });

  try {
    if (input.mode === "metadata") {
      const result = await fetchAvailableModels(resolved, controller.signal);
      const selected = normalizeModelId(resolved.model);
      if (!result.models.some((model) => normalizeModelId(model) === selected)) {
        throw createModelError({
          code: "model_not_found",
          provider: normalizeProviderKind(resolved.activeProvider),
          modelId: resolved.model
        });
      }
    } else {
      const reliability = input.settings.modelReliability;
      const retry = reliability && typeof reliability === "object" && !Array.isArray(reliability) &&
        reliability.retry && typeof reliability.retry === "object" && !Array.isArray(reliability.retry)
        ? reliability.retry
        : { enabled: false, maxRetries: 0 };
      const isolatedSettings: UserSettings = {
        ...resolved,
        moduleModelPreferences: {} as Prisma.JsonObject,
        modelReliability: { retry, fallback: {} } as Prisma.JsonObject
      };
      const result = await executeReliableTextCompletion({
        settings: isolatedSettings,
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 4,
        temperature: 0,
        context: {
          requestId: testId,
          module: "chat",
          operation: "connection_test",
          signal: controller.signal
        }
      });
      if (!result.content.trim()) {
        throw createModelError({
          code: "malformed_response",
          provider: normalizeProviderKind(resolved.activeProvider),
          modelId: resolved.model
        });
      }
    }
    const diagnostic = successDiagnostic(testId, input.mode, resolved);
    setConnectionDiagnostic(input.settings, diagnostic);
    return diagnostic;
  } catch (caught) {
    const error = caught instanceof ModelCallError
      ? caught
      : normalizeModelError(caught, {
          provider: normalizeProviderKind(resolved.activeProvider),
          modelId: resolved.model,
          cancelled: controller.signal.aborted
        });
    const diagnostic = failedDiagnostic(testId, input.mode, resolved, error);
    setConnectionDiagnostic(input.settings, diagnostic);
    return diagnostic;
  } finally {
    activeTests.delete(testId);
    if (activeFingerprintTests.get(fingerprint) === testId) activeFingerprintTests.delete(fingerprint);
  }
};

export const cancelConnectionTest = (testId: string) => {
  const active = activeTests.get(testId);
  if (!active) return false;
  active.controller.abort(new DOMException("Cancelled", "AbortError"));
  return true;
};
