import { randomUUID } from "node:crypto";

export type ModelErrorCode =
  | "authentication"
  | "model_not_found"
  | "unsupported_capability"
  | "rate_limited"
  | "quota_exceeded"
  | "context_overflow"
  | "invalid_request"
  | "safety_blocked"
  | "timeout"
  | "connection_failed"
  | "provider_unavailable"
  | "malformed_response"
  | "stream_interrupted"
  | "cancelled"
  | "budget_blocked"
  | "unknown";

export type SafeModelError = {
  code: ModelErrorCode;
  retryable: boolean;
  receivedOutputTokens: boolean;
  retryAfterMs?: number;
  provider: string;
  modelId: string;
  attempt: number;
  summary: string;
  diagnosticId: string;
};

const retryableCodes = new Set<ModelErrorCode>([
  "rate_limited",
  "timeout",
  "connection_failed",
  "provider_unavailable"
]);

const summaries: Record<ModelErrorCode, string> = {
  authentication: "The model provider rejected the saved credentials. Check the local provider settings.",
  model_not_found: "The selected model is unavailable for this provider account.",
  unsupported_capability: "The selected model does not support this feature.",
  rate_limited: "The model provider is temporarily rate limiting requests.",
  quota_exceeded: "The provider account quota or spending limit has been reached.",
  context_overflow: "This request exceeds the model context limit.",
  invalid_request: "The provider could not accept this request. Check the model settings.",
  safety_blocked: "The provider safety policy blocked this request.",
  timeout: "The model provider did not respond in time.",
  connection_failed: "A secure connection to the model provider could not be established.",
  provider_unavailable: "The model provider is temporarily unavailable.",
  malformed_response: "The model provider returned an unreadable response.",
  stream_interrupted: "The reply stream ended before the response was complete.",
  cancelled: "Generation was stopped.",
  budget_blocked: "The local hard budget prevented this model call.",
  unknown: "The model request failed for an unknown reason."
};

const diagnosticId = () => `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

const retryAfterMs = (response: Response) => {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 3_600_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 3_600_000)) : undefined;
};

const classifyBody = (status: number, provider: string, body: unknown): ModelErrorCode => {
  const serialized = JSON.stringify(body ?? "").toLowerCase().slice(0, 16_000);
  const providerKind = provider.toLowerCase();
  if (/quota|billing|credit|balance|spend|insufficient_quota/.test(serialized)) return "quota_exceeded";
  if (/rate_limit|rate limit|too many requests|resource_exhausted.*(?:rate|request)/.test(serialized)) return "rate_limited";
  if (status === 429) {
    if (/quota|billing|credit|balance|spend|resource_exhausted.*quota/.test(serialized)) return "quota_exceeded";
    return "rate_limited";
  }
  if (status === 401 || status === 403 || /authentication|invalid_api_key|api key|permission_denied/.test(serialized)) {
    return "authentication";
  }
  if (status === 404 || /model_not_found|not found.*model|model.*not found/.test(serialized)) return "model_not_found";
  if (/context_length|context window|maximum context|too many tokens|input token count|prompt is too long/.test(serialized)) {
    return "context_overflow";
  }
  if (/unsupported|not supported|capability|supportedgenerationmethods/.test(serialized)) return "unsupported_capability";
  if (/safety|blocked_reason|block_reason|prohibited_content|recitation|spii|content_filter/.test(serialized)) {
    return "safety_blocked";
  }
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "provider_unavailable";
  if (/overloaded_error|overloaded|temporarily unavailable|unavailable/.test(serialized)) return "provider_unavailable";
  if (status === 400 || status === 422 || (providerKind.includes("gemini") && status === 413)) return "invalid_request";
  return "unknown";
};

export const modelErrorFromPayload = (input: {
  body: unknown;
  provider: string;
  modelId: string;
  attempt?: number;
}) => createModelError({
  code: classifyBody(0, input.provider, input.body),
  provider: input.provider,
  modelId: input.modelId,
  attempt: input.attempt
});

export class ModelCallError extends Error {
  readonly safe: SafeModelError;

  constructor(safe: SafeModelError) {
    super(safe.summary);
    this.name = "ModelCallError";
    this.safe = Object.freeze({ ...safe });
  }
}

export const createModelError = (input: {
  code: ModelErrorCode;
  provider: string;
  modelId: string;
  attempt?: number;
  receivedOutputTokens?: boolean;
  retryAfterMs?: number;
  diagnosticId?: string;
}) => new ModelCallError({
  code: input.code,
  retryable: retryableCodes.has(input.code) && !input.receivedOutputTokens,
  receivedOutputTokens: input.receivedOutputTokens ?? false,
  ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  provider: input.provider,
  modelId: input.modelId,
  attempt: input.attempt ?? 1,
  summary: summaries[input.code],
  diagnosticId: input.diagnosticId ?? diagnosticId()
});

export const modelErrorFromResponse = async (input: {
  response: Response;
  provider: string;
  modelId: string;
  attempt?: number;
}) => {
  let body: unknown = null;
  try {
    const text = (await input.response.text()).slice(0, 64_000);
    body = text ? JSON.parse(text) : null;
  } catch {
    // The body is used only for classification and is intentionally discarded.
  }
  return createModelError({
    code: classifyBody(input.response.status, input.provider, body),
    provider: input.provider,
    modelId: input.modelId,
    attempt: input.attempt,
    retryAfterMs: retryAfterMs(input.response)
  });
};

export const normalizeModelError = (error: unknown, input: {
  provider: string;
  modelId: string;
  attempt?: number;
  receivedOutputTokens?: boolean;
  cancelled?: boolean;
}) => {
  // A user stop always wins over transport classification, including after
  // visible output. It must never be reported as an interrupted provider
  // stream or become eligible for retry/fallback.
  if (input.cancelled) {
    return createModelError({ code: "cancelled", provider: input.provider, modelId: input.modelId, attempt: input.attempt, receivedOutputTokens: input.receivedOutputTokens });
  }
  if (error instanceof ModelCallError) {
    if (!input.receivedOutputTokens) return error;
    if (error.safe.code === "cancelled" || error.safe.code === "stream_interrupted") return error;
    return createModelError({
      code: "stream_interrupted",
      provider: input.provider,
      modelId: input.modelId,
      attempt: input.attempt,
      receivedOutputTokens: true,
      diagnosticId: error.safe.diagnosticId
    });
  }
  if (input.receivedOutputTokens) {
    return createModelError({ code: "stream_interrupted", provider: input.provider, modelId: input.modelId, attempt: input.attempt, receivedOutputTokens: true });
  }
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toUpperCase() : "";
  if (name.includes("timeout") || code === "ETIMEDOUT") {
    return createModelError({ code: "timeout", provider: input.provider, modelId: input.modelId, attempt: input.attempt });
  }
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code) || error instanceof TypeError) {
    return createModelError({ code: "connection_failed", provider: input.provider, modelId: input.modelId, attempt: input.attempt });
  }
  return createModelError({ code: "unknown", provider: input.provider, modelId: input.modelId, attempt: input.attempt });
};

export const malformedModelResponse = (provider: string, modelId: string, attempt = 1) =>
  createModelError({ code: "malformed_response", provider, modelId, attempt });
