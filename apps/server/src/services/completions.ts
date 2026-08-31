import type { UserSettings } from "@prisma/client";
import { decryptApiKey } from "./apiKeyVault.js";
import {
  createModelError,
  malformedModelResponse,
  modelErrorFromPayload,
  modelErrorFromResponse,
  normalizeModelError
} from "./modelErrors.js";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: Array<{ mimeType: "image/png" | "image/jpeg"; dataBase64: string }>;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
};

export type ChatCompletionStreamEvent =
  | {
      type: "token";
      content: string;
    }
  | {
      type: "usage";
      usage: TokenUsage;
    };

export type ChatCompletionResult = {
  content: string;
  usage: TokenUsage | null;
};

type ConnectionTestResult = {
  reachable: true;
  model: string;
  checkedAt: string;
};

type AvailableModelsResult = {
  provider: string;
  models: string[];
  checkedAt: string;
};

export type ProviderKind = "openai-compatible" | "anthropic" | "google-gemini";

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export const normalizeProvider = (provider: string): ProviderKind => {
  const normalized = provider.trim().toLowerCase();

  if (["anthropic", "claude", "claude-native"].includes(normalized)) {
    return "anthropic";
  }

  if (["google", "google-gemini", "gemini", "gemini-native"].includes(normalized)) {
    return "google-gemini";
  }

  return "openai-compatible";
};

const authHeaders = (settings: UserSettings, provider = normalizeProvider(settings.activeProvider)) => {
  const apiKey = decryptApiKey(settings.apiKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
  } else if (provider === "google-gemini") {
    if (apiKey) {
      headers["x-goog-api-key"] = apiKey;
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
};

const responseError = (response: Response, settings: UserSettings) => modelErrorFromResponse({
  response,
  provider: normalizeProvider(settings.activeProvider),
  modelId: settings.model
});

const MODEL_CALL_TIMEOUT_MS = 120_000;
const callSignal = (signal?: AbortSignal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS)])
  : AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);

async function* readSseJson(response: Response) {
  if (!response.body) {
    throw new SyntaxError("Missing response stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return null;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      return null;
    }

    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new SyntaxError("Malformed SSE event");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed) {
        yield parsed;
      }
    }
  }

  const parsed = parseLine(buffer);
  if (parsed) {
    yield parsed;
  }
}

export const openAiRequestBody = ({
  settings,
  messages,
  stream,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
}) => ({
  model: settings.model,
  messages: messages.map((message) => ({
    role: message.role,
    content: message.images?.length
      ? [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...message.images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } }))
        ]
      : message.content
  })),
  temperature: temperature ?? settings.temperature,
  max_tokens: maxTokens ?? settings.maxTokens,
  top_p: settings.topP,
  stream,
  ...(stream ? { stream_options: { include_usage: true } } : {})
});

const splitSystemMessages = (messages: ChatCompletionMessage[]) => {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  const conversation = messages.filter((message) => message.role !== "system");

  return { system, conversation };
};

const mergeConversation = <Role extends string, Content = string>(
  entries: Array<{ role: Role; content: Content }>,
  fallbackRole: Role,
  fallbackContent: Content
) => {
  const merged: Array<{ role: Role; content: Content }> = [];

  for (const entry of entries) {
    const content = entry.content;
    if (typeof content === "string" && !content.trim()) {
      continue;
    }

    const last = merged.at(-1);
    if (last?.role === entry.role && typeof last.content === "string" && typeof content === "string") {
      last.content = `${last.content}\n\n${content}` as Content;
    } else if (last?.role === entry.role && Array.isArray(last.content) && Array.isArray(content)) {
      last.content = [...last.content, ...content] as Content;
    } else {
      merged.push({ role: entry.role, content });
    }
  }

  if (!merged.length || merged[0]?.role !== fallbackRole) {
    merged.unshift({ role: fallbackRole, content: fallbackContent });
  }

  return merged;
};

export const toAnthropicPayload = ({
  settings,
  messages,
  stream,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
}) => {
  const { system, conversation } = splitSystemMessages(messages);
  const anthropicMessages = mergeConversation(
    conversation.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: message.images?.length
        ? [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...message.images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType, data: image.dataBase64 } }))
          ]
        : [{ type: "text" as const, text: message.content }]
    })),
    "user",
    [{ type: "text" as const, text: "Continue the conversation." }]
  );

  return {
    model: settings.model,
    max_tokens: maxTokens ?? settings.maxTokens,
    temperature: temperature ?? settings.temperature,
    top_p: settings.topP,
    stream,
    ...(system ? { system } : {}),
    messages: anthropicMessages
  };
};

const normalizeGeminiModel = (model: string) => model.trim().replace(/^models\//, "");

export const toGeminiPayload = ({
  settings,
  messages,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
}) => {
  const { system, conversation } = splitSystemMessages(messages);
  const geminiMessages = mergeConversation(
    conversation.map((message) => ({
      role: message.role === "assistant" ? ("model" as const) : ("user" as const),
      content: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } }))
      ]
    })),
    "user",
    [{ text: "Continue the conversation." }]
  );

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: geminiMessages.map((message) => ({
      role: message.role,
      parts: message.content
    })),
    generationConfig: {
      temperature: temperature ?? settings.temperature,
      topP: settings.topP,
      maxOutputTokens: maxTokens ?? settings.maxTokens
    }
  };
};

const parseUsage = (usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | null): TokenUsage | null => {
  if (!usage) {
    return null;
  }

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    estimated: false
  };
};

const parseGeminiUsage = (usage: unknown): TokenUsage | null => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  const typed = usage as Record<string, unknown>;
  const promptTokens = typeof typed.promptTokenCount === "number" ? typed.promptTokenCount : 0;
  const completionTokens =
    typeof typed.candidatesTokenCount === "number" ? typed.candidatesTokenCount : 0;
  const totalTokens = typeof typed.totalTokenCount === "number"
    ? typed.totalTokenCount
    : promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: false
  };
};

const parseGeminiText = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }

  const candidates = (payload as { candidates?: unknown[] }).candidates;
  const first = candidates?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return "";
  }

  const content = (first as { content?: { parts?: Array<{ text?: string }> } }).content;
  return content?.parts?.map((part) => part.text ?? "").join("") ?? "";
};

export const testModelConnection = async (settings: UserSettings): Promise<ConnectionTestResult> => {
  const content = (
    await completeChatCompletion({
      settings: {
        ...settings,
        temperature: 0,
        maxTokens: Math.min(Math.max(settings.maxTokens, 1), 16)
      },
      messages: [
        {
          role: "system",
          content:
            "/no_think\nYou are testing whether the configured model can generate a chat completion. Reply with exactly OK."
        },
        {
          role: "user",
          content: "Connection test"
        }
      ]
    })
  ).trim();

  if (!content) {
    throw new Error("Model connection test returned an empty response");
  }

  return {
    reachable: true,
    model: settings.model,
    checkedAt: new Date().toISOString()
  };
};

const validateDiagnosticUrl = (value: string, provider: ProviderKind, modelId: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createModelError({ code: "invalid_url", provider, modelId });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => /(?:api[-_]?key|token|secret|authorization|credential|password)/i.test(key))
  ) {
    throw createModelError({ code: "invalid_url", provider, modelId });
  }
  return url;
};

const fetchModelMetadata = async (settings: UserSettings, signal?: AbortSignal) => {
  const provider = normalizeProvider(settings.activeProvider);
  let url = validateDiagnosticUrl(joinApiPath(settings.apiBaseUrl, "models"), provider, settings.model);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: authHeaders(settings, provider),
        redirect: "manual",
        signal: callSignal(signal)
      });
    } catch (error) {
      throw normalizeModelError(error, {
        provider,
        modelId: settings.model,
        cancelled: signal?.aborted
      });
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || redirectCount === 3) {
      throw createModelError({ code: "invalid_url", provider, modelId: settings.model });
    }
    const nextUrl = validateDiagnosticUrl(new URL(location, url).toString(), provider, settings.model);
    if (nextUrl.origin !== url.origin) {
      throw createModelError({ code: "invalid_url", provider, modelId: settings.model });
    }
    url = nextUrl;
  }
  throw createModelError({ code: "invalid_url", provider, modelId: settings.model });
};

export const fetchAvailableModels = async (
  settings: UserSettings,
  signal?: AbortSignal
): Promise<AvailableModelsResult> => {
  const provider = normalizeProvider(settings.activeProvider);
  const response = await fetchModelMetadata(settings, signal);

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  let payload: {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw malformedModelResponse(provider, settings.model);
  }
  const models =
    provider === "google-gemini"
      ? (payload.models ?? [])
          .filter((model) => {
            const methods = model.supportedGenerationMethods;
            return !methods || methods.includes("generateContent") || methods.includes("embedContent");
          })
          .map((model) => model.name?.replace(/^models\//, "") ?? "")
      : (payload.data ?? []).map((model) => model.id ?? "");

  return {
    provider: settings.activeProvider,
    models: [...new Set(models.filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    checkedAt: new Date().toISOString()
  };
};

async function* streamOpenAiChatCompletion({
  settings,
  messages,
  signal
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "chat/completions"), {
      method: "POST",
      headers: authHeaders(settings),
      signal: callSignal(signal),
      body: JSON.stringify(openAiRequestBody({ settings, messages, stream: true }))
    });
  } catch (error) {
    throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model, cancelled: signal.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  try { for await (const parsed of readSseJson(response)) {
    const typed = parsed as {
      error?: unknown;
      choices?: Array<{ delta?: { content?: string }; text?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      } | null;
    };
    if (typed.error) {
      throw modelErrorFromPayload({ body: typed.error, provider: "openai-compatible", modelId: settings.model });
    }
    const usage = parseUsage(typed.usage);
    if (usage) {
      yield { type: "usage", usage } satisfies ChatCompletionStreamEvent;
    }

    const token = typed.choices?.[0]?.delta?.content ?? typed.choices?.[0]?.text ?? "";
    if (token) {
      yield { type: "token", content: token } satisfies ChatCompletionStreamEvent;
    }
  } } catch (error) {
    throw error instanceof SyntaxError
      ? malformedModelResponse("openai-compatible", settings.model)
      : normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model, cancelled: signal.aborted });
  }
}

async function* streamAnthropicChatCompletion({
  settings,
  messages,
  signal
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "messages"), {
      method: "POST",
      headers: authHeaders(settings, "anthropic"),
      signal: callSignal(signal),
      body: JSON.stringify(toAnthropicPayload({ settings, messages, stream: true }))
    });
  } catch (error) {
    throw normalizeModelError(error, { provider: "anthropic", modelId: settings.model, cancelled: signal.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  let promptTokens = 0;
  let completionTokens = 0;

  try { for await (const parsed of readSseJson(response)) {
    const type = parsed.type;
    if (type === "error" || parsed.error) {
      throw modelErrorFromPayload({ body: parsed.error ?? parsed, provider: "anthropic", modelId: settings.model });
    }

    if (type === "message_start") {
      const usage = (parsed.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      promptTokens = usage?.input_tokens ?? promptTokens;
    }

    if (type === "content_block_delta") {
      const delta = parsed.delta as { text?: string } | undefined;
      if (delta?.text) {
        yield { type: "token", content: delta.text } satisfies ChatCompletionStreamEvent;
      }
    }

    if (type === "message_delta") {
      const usage = parsed.usage as { output_tokens?: number } | undefined;
      completionTokens = usage?.output_tokens ?? completionTokens;
    }
  } } catch (error) {
    throw error instanceof SyntaxError
      ? malformedModelResponse("anthropic", settings.model)
      : normalizeModelError(error, { provider: "anthropic", modelId: settings.model, cancelled: signal.aborted });
  }

  if (promptTokens || completionTokens) {
    yield {
      type: "usage",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: false
      }
    } satisfies ChatCompletionStreamEvent;
  }
}

async function* streamGeminiChatCompletion({
  settings,
  messages,
  signal
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(
      joinApiPath(
        settings.apiBaseUrl,
        `models/${encodeURIComponent(normalizeGeminiModel(settings.model))}:streamGenerateContent?alt=sse`
      ),
      {
        method: "POST",
        headers: authHeaders(settings, "google-gemini"),
        signal: callSignal(signal),
        body: JSON.stringify(toGeminiPayload({ settings, messages }))
      }
    );
  } catch (error) {
    throw normalizeModelError(error, { provider: "google-gemini", modelId: settings.model, cancelled: signal.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  let usage: TokenUsage | null = null;
  try { for await (const parsed of readSseJson(response)) {
    if (parsed.error || parsed.promptFeedback) {
      throw modelErrorFromPayload({ body: parsed.error ?? parsed.promptFeedback, provider: "google-gemini", modelId: settings.model });
    }
    const token = parseGeminiText(parsed);
    if (token) {
      yield { type: "token", content: token } satisfies ChatCompletionStreamEvent;
    }

    usage = parseGeminiUsage(parsed.usageMetadata) ?? usage;
  } } catch (error) {
    throw error instanceof SyntaxError
      ? malformedModelResponse("google-gemini", settings.model)
      : normalizeModelError(error, { provider: "google-gemini", modelId: settings.model, cancelled: signal.aborted });
  }

  if (usage) {
    yield { type: "usage", usage } satisfies ChatCompletionStreamEvent;
  }
}

export async function* streamChatCompletion({
  settings,
  messages,
  signal
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
}) {
  const provider = normalizeProvider(settings.activeProvider);

  if (provider === "anthropic") {
    yield* streamAnthropicChatCompletion({ settings, messages, signal });
    return;
  }

  if (provider === "google-gemini") {
    yield* streamGeminiChatCompletion({ settings, messages, signal });
    return;
  }

  yield* streamOpenAiChatCompletion({ settings, messages, signal });
}

const completeOpenAiChatCompletion = async ({
  settings,
  messages,
  signal,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}) => {
  let response: Response;
  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "chat/completions"), {
      method: "POST",
      headers: authHeaders(settings),
      signal: callSignal(signal),
      body: JSON.stringify(
        openAiRequestBody({
          settings,
          messages,
          stream: false,
          temperature: temperature ?? Math.min(settings.temperature, 0.4),
          maxTokens: maxTokens ?? Math.min(settings.maxTokens, 500)
        })
      )
    });
  } catch (error) {
    throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model, cancelled: signal?.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  let payload: {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("openai-compatible", settings.model); }

  return {
    content: (payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "").trim(),
    usage: parseUsage(payload.usage)
  } satisfies ChatCompletionResult;
};

const completeAnthropicChatCompletion = async ({
  settings,
  messages,
  signal,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}) => {
  let response: Response;
  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "messages"), {
      method: "POST",
      headers: authHeaders(settings, "anthropic"),
      signal: callSignal(signal),
      body: JSON.stringify(
        toAnthropicPayload({
          settings,
          messages,
          stream: false,
          temperature: temperature ?? Math.min(settings.temperature, 0.4),
          maxTokens: maxTokens ?? Math.min(settings.maxTokens, 500)
        })
      )
    });
  } catch (error) {
    throw normalizeModelError(error, { provider: "anthropic", modelId: settings.model, cancelled: signal?.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  let payload: {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("anthropic", settings.model); }

  const promptTokens = payload.usage?.input_tokens ?? 0;
  const completionTokens = payload.usage?.output_tokens ?? 0;
  return {
    content: (payload.content ?? []).map((part) => part.text ?? "").join("").trim(),
    usage: payload.usage ? {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: false
    } : null
  } satisfies ChatCompletionResult;
};

const completeGeminiChatCompletion = async ({
  settings,
  messages,
  signal,
  maxTokens,
  temperature
}: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}) => {
  let response: Response;
  try {
    response = await fetch(
      joinApiPath(
        settings.apiBaseUrl,
        `models/${encodeURIComponent(normalizeGeminiModel(settings.model))}:generateContent`
      ),
      {
        method: "POST",
        headers: authHeaders(settings, "google-gemini"),
        signal: callSignal(signal),
        body: JSON.stringify(
          toGeminiPayload({
            settings,
            messages,
            temperature: temperature ?? Math.min(settings.temperature, 0.4),
            maxTokens: maxTokens ?? Math.min(settings.maxTokens, 500)
          })
        )
      }
    );
  } catch (error) {
    throw normalizeModelError(error, { provider: "google-gemini", modelId: settings.model, cancelled: signal?.aborted });
  }

  if (!response.ok) {
    throw await responseError(response, settings);
  }

  try {
    const payload = await response.json() as { usageMetadata?: unknown };
    return { content: parseGeminiText(payload).trim(), usage: parseGeminiUsage(payload.usageMetadata) } satisfies ChatCompletionResult;
  } catch { throw malformedModelResponse("google-gemini", settings.model); }
};

export const completeChatCompletionDetailed = async (input: {
  settings: UserSettings;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}) => {
  const provider = normalizeProvider(input.settings.activeProvider);

  if (provider === "anthropic") {
    return completeAnthropicChatCompletion(input);
  }

  if (provider === "google-gemini") {
    return completeGeminiChatCompletion(input);
  }

  return completeOpenAiChatCompletion(input);
};

export const completeChatCompletion = async (input: Parameters<typeof completeChatCompletionDetailed>[0]) =>
  (await completeChatCompletionDetailed(input)).content;

const estimateTokens = (text: string) => {
  const compact = text.trim();
  if (!compact) {
    return 0;
  }

  return Math.max(1, Math.ceil(compact.length / 2));
};

export const estimateTokenUsage = (
  messages: ChatCompletionMessage[],
  completion: string
): TokenUsage => {
  const promptTokens = messages.reduce((total, message) => total + estimateTokens(message.content) + (message.images?.length ?? 0) * 1024, 0);
  const completionTokens = estimateTokens(completion);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true
  };
};
