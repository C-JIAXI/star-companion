import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { malformedModelResponse, modelErrorFromResponse, normalizeModelError } from "./modelErrors.js";

const classify = async (status: number, body: unknown, provider = "openai-compatible", retryAfter?: string) =>
  (await modelErrorFromResponse({
    response: new Response(JSON.stringify(body), { status, headers: retryAfter ? { "retry-after": retryAfter } : {} }),
    provider,
    modelId: "safe-model"
  })).safe;

describe("provider-independent model errors", () => {
  it("maps authentication, missing models, throttling, quota, context, safety, and 5xx", async () => {
    assert.equal((await classify(401, { error: { message: "invalid api key secret-value" } })).code, "authentication");
    assert.equal((await classify(404, { error: { type: "model_not_found" } })).code, "model_not_found");
    assert.equal((await classify(429, { error: { type: "rate_limit_error" } }, "anthropic")).code, "rate_limited");
    assert.equal((await classify(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, "google-gemini")).code, "quota_exceeded");
    assert.equal((await classify(400, { error: { code: "context_length_exceeded" } })).code, "context_overflow");
    assert.equal((await classify(400, { promptFeedback: { blockReason: "SAFETY" } }, "google-gemini")).code, "safety_blocked");
    assert.equal((await classify(503, { error: { type: "overloaded_error" } }, "anthropic")).code, "provider_unavailable");
  });

  it("normalizes representative OpenAI-compatible, Anthropic, and Gemini HTTP contracts", async () => {
    const cases: Array<[string, number, unknown, string]> = [
      ["openai-compatible", 401, { error: { code: "invalid_api_key", message: "secret" } }, "authentication"],
      ["anthropic", 403, { error: { type: "permission_error", message: "forbidden" } }, "authentication"],
      ["google-gemini", 403, { error: { status: "PERMISSION_DENIED" } }, "authentication"],
      ["openai-compatible", 404, { error: { code: "model_not_found" } }, "model_not_found"],
      ["anthropic", 404, { error: { type: "not_found_error", message: "model not found" } }, "model_not_found"],
      ["google-gemini", 404, { error: { status: "NOT_FOUND", message: "model not found" } }, "model_not_found"],
      ["openai-compatible", 429, { error: { type: "rate_limit_error" } }, "rate_limited"],
      ["anthropic", 429, { error: { type: "rate_limit_error" } }, "rate_limited"],
      ["google-gemini", 429, { error: { status: "RESOURCE_EXHAUSTED", message: "request rate exceeded" } }, "rate_limited"],
      ["openai-compatible", 400, { error: { code: "context_length_exceeded" } }, "context_overflow"],
      ["anthropic", 400, { error: { type: "invalid_request_error", message: "prompt is too long" } }, "context_overflow"],
      ["google-gemini", 400, { error: { message: "input token count exceeds maximum context" } }, "context_overflow"],
      ["openai-compatible", 500, { error: { message: "internal" } }, "provider_unavailable"],
      ["anthropic", 529, { error: { type: "overloaded_error" } }, "provider_unavailable"],
      ["google-gemini", 503, { error: { status: "UNAVAILABLE" } }, "provider_unavailable"]
    ];
    for (const [provider, status, body, expected] of cases) {
      assert.equal((await classify(status, body, provider)).code, expected, `${provider} ${status}`);
    }
  });

  it("normalizes timeout and malformed responses without provider content", () => {
    const timeout = normalizeModelError(new DOMException("private prompt timed out", "TimeoutError"), {
      provider: "google-gemini", modelId: "safe-model"
    });
    assert.equal(timeout.safe.code, "timeout");
    assert.equal(timeout.safe.summary.includes("private"), false);
    const malformed = malformedModelResponse("anthropic", "safe-model");
    assert.equal(malformed.safe.code, "malformed_response");
    assert.equal(malformed.safe.retryable, false);
  });

  it("honours Retry-After while never exposing the provider body", async () => {
    const error = await classify(429, { error: { message: "secret api key and private prompt" } }, "openai-compatible", "2");
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.retryable, true);
    assert.equal(error.summary.includes("secret"), false);
    assert.match(error.diagnosticId, /^mdl_[a-f0-9]{16}$/);
  });

  it("never retries cancellation or an interrupted stream", () => {
    const interrupted = normalizeModelError(new TypeError("socket"), {
      provider: "openai-compatible", modelId: "safe-model", receivedOutputTokens: true
    });
    assert.equal(interrupted.safe.code, "stream_interrupted");
    assert.equal(interrupted.safe.retryable, false);
    const cancelled = normalizeModelError(new DOMException("Aborted", "AbortError"), {
      provider: "anthropic", modelId: "safe-model", cancelled: true
    });
    assert.equal(cancelled.safe.code, "cancelled");
    assert.equal(cancelled.safe.retryable, false);
  });
});
