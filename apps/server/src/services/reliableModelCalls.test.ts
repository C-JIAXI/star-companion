import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { executeReliableTextCompletion, executeReliableTextStream } from "./reliableModelCalls.js";
import { recoverInterruptedModelCalls } from "./modelUsage.js";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await prisma.modelUsageAttempt.deleteMany();
  await prisma.modelRequest.deleteMany();
});

const settings = (overrides: Partial<UserSettings> = {}) => ({
  id: "reliable-test", activeProvider: "openai-compatible", apiBaseUrl: "https://mock.invalid/v1",
  apiKey: null, model: "test-model", temperature: 0.5, maxTokens: 100, topP: 1, language: "en",
  models: [], providers: [{ id: "provider", label: "Provider", provider: "openai-compatible", apiBaseUrl: "https://mock.invalid/v1", models: [{ id: "model", label: "Model", model: "test-model", capabilities: ["text_generation"], pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, currency: "USD", updatedAt: new Date().toISOString(), source: "user" } }] }],
  activeProviderId: "provider", activeModelId: "model", moduleModelPreferences: {},
  modelReliability: { retry: { enabled: true, maxRetries: 2 }, fallback: {} },
  usageBudgets: {}, usageTimezone: "UTC", userPersonaPresets: [], userProfileSummary: "",
  autoSummarizeUser: true, showMessageAvatars: true, showMessageTimestamps: false,
  ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false, userProfileUpdatedAt: null,
  createdAt: new Date(), updatedAt: new Date(), ...overrides
}) as UserSettings;

const invoke = (value: UserSettings, requestId = `req_${randomUUID()}`) => executeReliableTextCompletion({
  settings: value,
  messages: [{ role: "user", content: "safe test input" }],
  context: { requestId, module: "chat", operation: "test" }
});

describe("reliable model execution", () => {
  it("retries 429 with Retry-After and records each actual provider attempt", async () => {
    let calls = 0;
    const retries: number[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }), { status: 200 });
    }) as typeof fetch;
    const requestId = `retry_${randomUUID()}`;
    const result = await executeReliableTextCompletion({
      settings: settings(), messages: [{ role: "user", content: "test" }],
      context: { requestId, module: "chat", operation: "test", onRetry: ({ retryAfterMs }) => retries.push(retryAfterMs) }
    });
    assert.equal(result.content, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(retries, [0]);
    const attempts = await prisma.modelUsageAttempt.findMany({ where: { requestId }, orderBy: { attemptNumber: "asc" } });
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
    assert.equal(attempts[1]?.usageSource, "provider");
    assert.equal(attempts[1]?.estimatedCostMicros, 6);
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "invalid api key secret" } }), { status: 401 }); }) as typeof fetch;
    await assert.rejects(invoke(settings()), (error: unknown) => Boolean(error && typeof error === "object" && "safe" in error && (error as { safe: { code: string } }).safe.code === "authentication"));
    assert.equal(calls, 1);
  });

  it("cancels an exponential-backoff wait without starting another provider attempt", async () => {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "30" } });
    }) as typeof fetch;
    const requestId = `cancel_retry_${randomUUID()}`;
    const pending = executeReliableTextCompletion({
      settings: settings(), messages: [{ role: "user", content: "test" }],
      context: {
        requestId, module: "chat", operation: "test", signal: controller.signal,
        onRetry: () => controller.abort()
      }
    });
    await assert.rejects(pending, (error: unknown) => Boolean(error && typeof error === "object" && "safe" in error && (error as { safe: { code: string } }).safe.code === "cancelled"));
    assert.equal(calls, 1);
    assert.equal((await prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } })).status, "cancelled");
  });

  it("blocks unknown pricing when policy forbids it and never calls the provider", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
    const noPrice = settings({
      providers: [{ id: "provider", label: "Provider", provider: "openai-compatible", apiBaseUrl: "https://mock.invalid/v1", models: [{ id: "model", label: "Model", model: "test-model", capabilities: ["text_generation"] }] }],
      usageBudgets: { allowUnknownPricing: false }
    });
    const requestId = `blocked_${randomUUID()}`;
    await assert.rejects(invoke(noPrice, requestId), (error: unknown) => Boolean(error && typeof error === "object" && "safe" in error && (error as { safe: { code: string } }).safe.code === "budget_blocked"));
    assert.equal(calls, 0);
    assert.equal((await prisma.modelUsageAttempt.findFirstOrThrow({ where: { requestId } })).status, "blocked");
  });

  it("one-time hard-budget override applies only to the named request", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as typeof fetch;
    const limited = settings({ usageBudgets: { dailyHardMicros: 1, allowUnknownPricing: true } });
    await assert.rejects(invoke(limited));
    const requestId = `override_${randomUUID()}`;
    const result = await executeReliableTextCompletion({ settings: limited, messages: [{ role: "user", content: "test" }], context: { requestId, module: "chat", operation: "test", overrideHardBudget: true } });
    assert.equal(result.content, "ok");
    await assert.rejects(invoke(limited));
  });

  it("serializes concurrent reservations so only one request can consume the remaining hard budget", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }), { status: 200 });
    }) as typeof fetch;
    // Each request reserves ~201 micro-USD (input estimate plus max output).
    const limited = settings({ usageBudgets: { dailyHardMicros: 250, allowUnknownPricing: true } });
    const first = invoke(limited, `concurrent_a_${randomUUID()}`);
    const second = invoke(limited, `concurrent_b_${randomUUID()}`);
    const settling = Promise.allSettled([first, second]);
    for (let index = 0; index < 100 && calls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, 1, "the first provider call should remain active while the second reservation is checked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1, "the second request must be blocked before reaching the provider");
    release();
    const settled = await settling;
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(calls, 1);
  });

  it("uses an explicitly enabled compatible fallback without changing the primary preference", async () => {
    const modelsSeen: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      modelsSeen.push(body.model);
      return body.model === "test-model"
        ? new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "fallback ok" } }] }), { status: 200 });
    }) as typeof fetch;
    const configured = settings({
      providers: [
        { id: "provider", label: "Provider", provider: "openai-compatible", apiBaseUrl: "https://mock.invalid/v1", models: [{ id: "model", label: "Primary", model: "test-model", capabilities: ["text_generation"] }, { id: "fallback", label: "Fallback", model: "fallback-model", capabilities: ["text_generation"] }] }
      ],
      modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: { chat: { enabled: true, allowAutomatic: true, chain: [{ providerId: "provider", modelId: "fallback" }] } } }
    });
    const result = await invoke(configured);
    assert.equal(result.content, "fallback ok");
    assert.equal(result.usedFallback, true);
    assert.deepEqual(modelsSeen, ["test-model", "fallback-model"]);
    assert.equal(configured.activeModelId, "model");
  });

  it("keeps the attempt price snapshot when model pricing changes later", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 })) as typeof fetch;
    const configured = settings();
    const requestId = `price_snapshot_${randomUUID()}`;
    await invoke(configured, requestId);
    const before = await prisma.modelUsageAttempt.findFirstOrThrow({ where: { requestId } });
    const providers = configured.providers as Array<{ models: Array<{ pricing?: { inputMicrosPerMillion: number; outputMicrosPerMillion: number } }> }>;
    providers[0]!.models[0]!.pricing = { inputMicrosPerMillion: 99_000_000, outputMicrosPerMillion: 99_000_000 };
    const after = await prisma.modelUsageAttempt.findFirstOrThrow({ where: { requestId } });
    assert.equal(before.inputPriceMicros, 1_000_000);
    assert.equal(before.outputPriceMicros, 2_000_000);
    assert.equal(before.estimatedCostMicros, 20);
    assert.deepEqual(after, before);
  });

  it("marks unfinished calls interrupted and releases reservations after restart recovery", async () => {
    const requestId = `restart_${randomUUID()}`;
    await prisma.modelRequest.create({ data: { id: requestId, module: "chat", operation: "generate", status: "streaming", outputStarted: true } });
    await prisma.modelUsageAttempt.create({ data: {
      id: `att_${randomUUID()}`, requestId, attemptNumber: 1, module: "chat",
      providerId: "provider", providerType: "openai-compatible", modelId: "test-model",
      status: "streaming", reservedCostMicros: 500, reservationDay: "2026-08-12", reservationMonth: "2026-08"
    } });
    assert.deepEqual(await recoverInterruptedModelCalls(), { requests: 1, attempts: 1 });
    const request = await prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    const attempt = await prisma.modelUsageAttempt.findFirstOrThrow({ where: { requestId } });
    assert.equal(request.status, "interrupted");
    assert.equal(attempt.status, "interrupted");
    assert.equal(attempt.reservedCostMicros, 0);
  });

  it("does not retry or fallback after the first streamed token", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      let delivered = false;
      const body = new ReadableStream({ pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(new TypeError("connection lost"));
      } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const claimed = settings();
    const requestId = `stream_${randomUUID()}`;
    await prisma.modelRequest.create({ data: { id: requestId, module: "chat", operation: "generate" } });
    await assert.rejects(async () => {
      for await (const _event of executeReliableTextStream({ settings: claimed, messages: [{ role: "user", content: "test" }], context: { requestId, module: "chat", operation: "generate", requestAlreadyClaimed: true } })) { /* consume */ }
    }, (error: unknown) => Boolean(error && typeof error === "object" && "safe" in error && (error as { safe: { code: string } }).safe.code === "stream_interrupted"));
    assert.equal(calls, 1);
    assert.equal((await prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } })).status, "interrupted");
  });
});
