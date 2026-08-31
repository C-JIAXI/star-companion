import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultAppearancePreferences,
  type PublicUserSettingsDTO
} from "@local-roleplay/shared";
import { computeReadiness, inspectConfiguration } from "./readiness.js";

const baseSettings = (): PublicUserSettingsDTO => ({
  id: "settings-readiness",
  activeProvider: "",
  apiBaseUrl: "",
  model: "",
  temperature: 0.8,
  maxTokens: 800,
  topP: 1,
  language: "en",
  providers: [],
  activeProviderId: "",
  activeModelId: "",
  moduleModelPreferences: {},
  modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
  usageBudgets: {
    dailySoftMicros: null,
    dailyHardMicros: null,
    monthlySoftMicros: null,
    monthlyHardMicros: null,
    allowUnknownPricing: true
  },
  usageTimezone: "UTC",
  userPersonaPresets: [],
  userProfileSummary: "",
  autoSummarizeUser: false,
  showMessageAvatars: true,
  showMessageTimestamps: false,
  appearancePreferences: defaultAppearancePreferences,
  ttsVoice: "alloy",
  ttsPlaybackRate: 1,
  ttsAutoPlay: false,
  userProfileUpdatedAt: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  hasApiKey: false
});

const configuredSettings = (capabilities = ["text_generation"] as const): PublicUserSettingsDTO => ({
  ...baseSettings(),
  activeProvider: "openai-compatible",
  apiBaseUrl: "https://provider.example/v1",
  model: "model-a",
  activeProviderId: "provider-a",
  activeModelId: "model-a",
  providers: [{
    id: "provider-a",
    label: "Provider A",
    provider: "openai-compatible",
    apiBaseUrl: "https://provider.example/v1",
    hasKey: true,
    models: [{
      id: "model-a",
      label: "Model A",
      model: "model-a",
      capabilities: [...capabilities],
      pricing: {
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
        currency: "USD",
        updatedAt: "2026-08-13T00:00:00.000Z",
        source: "user"
      }
    }]
  }]
});

const readiness = (
  settings: PublicUserSettingsDTO,
  overrides: Partial<Parameters<typeof computeReadiness>[0]> = {}
) => computeReadiness({
  settings,
  characterCount: 0,
  chatCount: 0,
  budgetAllowsChat: true,
  computedAt: "2026-08-13T00:00:00.000Z",
  ...overrides
});

describe("authoritative readiness", () => {
  it("reports a fresh empty database without inventing completed setup", () => {
    const result = readiness(baseSettings());
    assert.equal(result.ready, false);
    assert.equal(result.hasCharacter, false);
    assert.equal(result.nextRecommendedAction, "create_character");
    assert.ok(result.issues.some((entry) => entry.code === "provider_missing"));
  });

  it("keeps a character-only installation blocked on provider configuration", () => {
    const result = readiness(baseSettings(), { characterCount: 1 });
    assert.equal(result.nextRecommendedAction, "configure_provider");
    assert.equal(result.ready, false);
  });

  it("treats configured chat without an existing chat as ready to create one", () => {
    const result = readiness(configuredSettings(), { characterCount: 1 });
    assert.equal(result.ready, true);
    assert.equal(result.hasChat, false);
    assert.equal(result.nextRecommendedAction, "test_connection");
    assert.equal(result.overallStatus, "configuration_untested");
  });

  it("reports complete readiness after an explicit successful test", () => {
    const settings = configuredSettings(["text_generation", "vision_input"]);
    const result = readiness(settings, {
      characterCount: 1,
      chatCount: 1,
      connectionStatus: {
        status: "succeeded",
        mode: "metadata",
        testId: "diag-test",
        providerKind: "openai-compatible",
        providerId: "provider-a",
        modelId: "model-a",
        checkedAt: "2026-08-13T00:00:00.000Z",
        errorCode: null,
        diagnosticId: "mdl_safe",
        summary: "Connection verified.",
        retryable: false,
        suggestedAction: "continue_chat",
        mayIncurCost: false
      }
    });
    assert.equal(result.ready, true);
    assert.equal(result.overallStatus, "ready");
    assert.equal(result.nextRecommendedAction, "continue_chat");
  });

  it("detects a deleted active model", () => {
    const settings = configuredSettings();
    settings.providers[0]!.models = [];
    const result = readiness(settings, { characterCount: 1 });
    assert.equal(result.hasActiveModel, false);
    assert.ok(result.issues.some((entry) => entry.code === "active_model_missing"));
  });

  it("distinguishes missing API key from local unauthenticated services", () => {
    const remote = configuredSettings();
    remote.providers[0]!.hasKey = false;
    assert.ok(inspectConfiguration(remote).some((entry) => entry.code === "api_key_missing"));

    const local = configuredSettings();
    local.providers[0]!.hasKey = false;
    local.providers[0]!.apiBaseUrl = "http://localhost:11434/v1";
    assert.ok(!inspectConfiguration(local).some((entry) => entry.code === "api_key_missing"));
  });

  it("keeps budget blocking distinct from configuration errors", () => {
    const result = readiness(configuredSettings(), { characterCount: 1, budgetAllowsChat: false });
    assert.equal(result.overallStatus, "budget_blocked");
    assert.equal(result.nextRecommendedAction, "review_budget");
  });

  it("keeps app locking distinct and recommends unlock", () => {
    const result = readiness(configuredSettings(), { characterCount: 1, appLocked: true });
    assert.equal(result.overallStatus, "locked");
    assert.equal(result.nextRecommendedAction, "unlock_app");
  });

  it("does not require vision capability for ordinary text chat", () => {
    const result = readiness(configuredSettings(), { characterCount: 1 });
    assert.equal(result.chatModelSupportsText, true);
    assert.equal(result.visionAvailable, false);
    assert.equal(result.ready, true);
  });
});

describe("static configuration diagnostics", () => {
  it("rejects malformed and dangerous base URLs", () => {
    for (const [value, expected] of [
      ["not-a-url", "base_url_invalid"],
      ["file:///tmp/model", "base_url_protocol"],
      ["https://user:pass@example.test/v1", "base_url_credentials"],
      ["https://example.test/v1?api_key=secret", "base_url_sensitive_query"],
      ["https://example.test/v1#secret", "base_url_fragment"]
    ] as const) {
      const settings = configuredSettings();
      settings.providers[0]!.apiBaseUrl = value;
      assert.ok(inspectConfiguration(settings).some((entry) => entry.code === expected));
    }
  });

  it("detects missing models and dangling module preferences", () => {
    const settings = configuredSettings();
    settings.moduleModelPreferences.chat = { providerId: "missing", modelId: "missing" };
    const codes = inspectConfiguration(settings).map((entry) => entry.code);
    assert.ok(codes.includes("chat_model_missing"));
    assert.ok(codes.includes("module_preference_dangling"));
  });

  it("detects duplicate and self-referencing fallback candidates", () => {
    const settings = configuredSettings();
    const ref = { providerId: "provider-a", modelId: "model-a" };
    settings.modelReliability.fallback.chat = { enabled: true, allowAutomatic: true, chain: [ref, ref] };
    const codes = inspectConfiguration(settings).map((entry) => entry.code);
    assert.ok(codes.includes("fallback_duplicate"));
    assert.ok(codes.includes("fallback_self_reference"));
  });

  it("marks missing price as unknown rather than zero", () => {
    const settings = configuredSettings();
    delete settings.providers[0]!.models[0]!.pricing;
    assert.ok(inspectConfiguration(settings).some((entry) => entry.code === "pricing_unknown"));
  });
});
