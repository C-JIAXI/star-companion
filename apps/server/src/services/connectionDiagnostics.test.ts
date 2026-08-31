import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { cancelConnectionTest, runConnectionTest } from "./connectionDiagnostics.js";
import { getConnectionDiagnostic } from "./readiness.js";

const makeSettings = (provider: "openai-compatible" | "anthropic" | "google-gemini") => ({
  id: `settings-${provider}`,
  activeProvider: provider,
  apiBaseUrl: provider === "anthropic"
    ? "https://api.anthropic.test/v1"
    : provider === "google-gemini"
      ? "https://generativelanguage.test/v1beta"
      : "https://openai-compatible.test/v1",
  apiKey: "test-only-key",
  model: "test-model",
  temperature: 0,
  maxTokens: 16,
  topP: 1,
  language: "en",
  models: [],
  providers: [{
    id: `provider-${provider}`,
    label: provider,
    provider,
    apiBaseUrl: provider === "anthropic"
      ? "https://api.anthropic.test/v1"
      : provider === "google-gemini"
        ? "https://generativelanguage.test/v1beta"
        : "https://openai-compatible.test/v1",
    key: "test-only-key",
    models: [{
      id: "model-reference",
      label: "Test model",
      model: "test-model",
      capabilities: ["text_generation"],
      pricing: {
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
        currency: "USD",
        updatedAt: "2026-08-13T00:00:00.000Z",
        source: "user"
      }
    }]
  }],
  activeProviderId: `provider-${provider}`,
  activeModelId: "model-reference",
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
  appearancePreferences: {},
  ttsVoice: "alloy",
  ttsPlaybackRate: 1,
  ttsAutoPlay: false,
  userProfileUpdatedAt: null,
  createdAt: new Date("2026-08-13T00:00:00.000Z"),
  updatedAt: new Date("2026-08-13T00:00:00.000Z")
}) as unknown as UserSettings;

const withMockFetch = async <T>(mock: typeof fetch, work: () => Promise<T>) => {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
};

describe("provider connection diagnostics", () => {
  it("verifies OpenAI-compatible metadata without creating a usage attempt", async () => {
    const settings = makeSettings("openai-compatible");
    const before = await prisma.modelUsageAttempt.count();
    const result = await withMockFetch(
      async () => new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      () => runConnectionTest({ settings, mode: "metadata" })
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.providerKind, "openai-compatible");
    assert.equal(result.mayIncurCost, false);
    assert.equal(await prisma.modelUsageAttempt.count(), before);
  });

  it("classifies OpenAI-compatible authentication failure without returning provider text", async () => {
    const settings = makeSettings("openai-compatible");
    const secretBody = "SENSITIVE_PROVIDER_RESPONSE";
    const result = await withMockFetch(
      async () => new Response(JSON.stringify({ error: { message: secretBody, code: "invalid_api_key" } }), {
        status: 401,
        headers: { "content-type": "application/json" }
      }),
      () => runConnectionTest({ settings, mode: "metadata" })
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "authentication");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secretBody));
  });

  it("verifies Anthropic metadata and reports a missing selected model", async () => {
    const success = await withMockFetch(
      async () => new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200 }),
      () => runConnectionTest({ settings: makeSettings("anthropic"), mode: "metadata" })
    );
    assert.equal(success.status, "succeeded");
    assert.equal(success.providerKind, "anthropic");

    const missing = await withMockFetch(
      async () => new Response(JSON.stringify({ data: [{ id: "different-model" }] }), { status: 200 }),
      () => runConnectionTest({ settings: makeSettings("anthropic"), mode: "metadata" })
    );
    assert.equal(missing.errorCode, "model_not_found");
  });

  it("verifies Gemini metadata and distinguishes quota exhaustion", async () => {
    const success = await withMockFetch(
      async () => new Response(JSON.stringify({
        models: [{ name: "models/test-model", supportedGenerationMethods: ["generateContent"] }]
      }), { status: 200 }),
      () => runConnectionTest({ settings: makeSettings("google-gemini"), mode: "metadata" })
    );
    assert.equal(success.status, "succeeded");
    assert.equal(success.providerKind, "google-gemini");

    const quota = await withMockFetch(
      async () => new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota exhausted" } }), {
        status: 429
      }),
      () => runConnectionTest({ settings: makeSettings("google-gemini"), mode: "metadata" })
    );
    assert.equal(quota.errorCode, "quota_exceeded");
  });

  it("cancels an in-flight metadata test and returns to a retryable UI state", async () => {
    const settings = makeSettings("openai-compatible");
    const previousTestId = getConnectionDiagnostic(settings).testId;
    const running = withMockFetch(
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("Cancelled", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      }),
      () => runConnectionTest({ settings, mode: "metadata" })
    );
    let testId: string | null = null;
    for (let attempt = 0; attempt < 20 && !testId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const diagnostic = getConnectionDiagnostic(settings);
      testId = diagnostic.status === "checking" && diagnostic.testId !== previousTestId
        ? diagnostic.testId
        : null;
    }
    assert.ok(testId);
    assert.equal(cancelConnectionTest(testId), true);
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.errorCode, "cancelled");
  });

  it("cancels an inference test through the usage ledger without creating messages", async () => {
    const settings = makeSettings("openai-compatible");
    const beforeMessages = await prisma.message.count();
    const previousTestId = getConnectionDiagnostic(settings).testId;
    const running = withMockFetch(
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("Cancelled", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      }),
      () => runConnectionTest({ settings, mode: "inference", confirmCost: true })
    );
    let testId: string | null = null;
    for (let attempt = 0; attempt < 20 && !testId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const diagnostic = getConnectionDiagnostic(settings);
      testId = diagnostic.status === "checking" && diagnostic.testId !== previousTestId
        ? diagnostic.testId
        : null;
    }
    assert.ok(testId);
    assert.equal(cancelConnectionTest(testId), true);
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal(result.errorCode, "cancelled");
    assert.equal((await prisma.modelRequest.findUnique({ where: { id: testId } }))?.status, "cancelled");
    assert.equal((await prisma.modelUsageAttempt.findFirst({ where: { requestId: testId } }))?.status, "cancelled");
    assert.equal(await prisma.message.count(), beforeMessages);
  });

  it("distinguishes timeout, TLS, network, rate limit, and temporary provider failures", async () => {
    const cases: Array<{ caught: Error | Response; code: string }> = [
      { caught: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), code: "timeout" },
      { caught: Object.assign(new Error("certificate failed"), { code: "CERT_HAS_EXPIRED" }), code: "tls_failed" },
      { caught: Object.assign(new Error("dns failed"), { code: "ENOTFOUND" }), code: "connection_failed" },
      { caught: new Response(JSON.stringify({ error: { message: "do not expose rate response" } }), { status: 429 }), code: "rate_limited" },
      { caught: new Response(JSON.stringify({ error: { message: "do not expose outage response" } }), { status: 503 }), code: "provider_unavailable" }
    ];
    for (const entry of cases) {
      const result = await withMockFetch(
        async () => {
          if (entry.caught instanceof Response) return entry.caught;
          throw entry.caught;
        },
        () => runConnectionTest({ settings: makeSettings("openai-compatible"), mode: "metadata" })
      );
      assert.equal(result.errorCode, entry.code);
      assert.doesNotMatch(JSON.stringify(result), /do not expose/);
    }
  });

  it("rejects cross-origin and dangerous redirects before credentials can be forwarded", async () => {
    let calls = 0;
    const crossOrigin = await withMockFetch(
      async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://other-origin.test/models" } });
      },
      () => runConnectionTest({ settings: makeSettings("openai-compatible"), mode: "metadata" })
    );
    assert.equal(crossOrigin.errorCode, "invalid_url");
    assert.equal(calls, 1);
    const dangerous = await withMockFetch(
      async () => new Response(null, { status: 302, headers: { location: "file:///private/models" } }),
      () => runConnectionTest({ settings: makeSettings("openai-compatible"), mode: "metadata" })
    );
    assert.equal(dangerous.errorCode, "invalid_url");
  });

  it("runs optional inference through the usage lifecycle without creating messages", async () => {
    const settings = makeSettings("openai-compatible");
    const beforeMessages = await prisma.message.count();
    const result = await withMockFetch(
      async () => new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } }),
      () => runConnectionTest({ settings, mode: "inference", confirmCost: true })
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.mayIncurCost, true);
    const request = await prisma.modelRequest.findUnique({ where: { id: result.testId! } });
    const attempts = await prisma.modelUsageAttempt.findMany({ where: { requestId: result.testId! } });
    assert.equal(request?.operation, "connection_test");
    assert.equal(request?.status, "succeeded");
    assert.equal(attempts.length, 1);
    assert.equal(await prisma.message.count(), beforeMessages);
  });

  it("records inference retries and final failures without creating messages", async () => {
    const settings = makeSettings("openai-compatible");
    settings.modelReliability = { retry: { enabled: true, maxRetries: 1 }, fallback: {} };
    const beforeMessages = await prisma.message.count();
    let calls = 0;
    const result = await withMockFetch(
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "private provider outage" } }), { status: 503 });
      },
      () => runConnectionTest({ settings, mode: "inference", confirmCost: true })
    );
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "provider_unavailable");
    assert.equal(calls, 2);
    assert.equal((await prisma.modelUsageAttempt.findMany({ where: { requestId: result.testId! } })).length, 2);
    assert.equal((await prisma.modelRequest.findUnique({ where: { id: result.testId! } }))?.status, "failed");
    assert.equal(await prisma.message.count(), beforeMessages);
    assert.doesNotMatch(JSON.stringify(result), /private provider outage/);
  });
});
