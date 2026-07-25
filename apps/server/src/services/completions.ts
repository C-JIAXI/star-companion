import type { UserSettings } from "@prisma/client";
import { decryptApiKey } from "./apiKeyVault.js";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
};

type ChatCompletionStreamEvent =
  | {
      type: "token";
      content: string;
    }
  | {
      type: "usage";
      usage: TokenUsage;
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

type ProviderKind = "openai-compatible" | "anthropic" | "google-gemini";

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const normalizeProvider = (provider: string): ProviderKind => {
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

const readErrorMessage = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return `Model API request failed with status ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    return parsed.error?.message ?? parsed.message ?? `Model API request failed with status ${response.status}`;
  } catch {
    return text.slice(0, 400);
  }
};

async function* readSseJson(response: Response) {
  if (!response.body) {
    throw new Error("Model API did not return a response stream");
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

    return JSON.parse(data) as Record<string, unknown>;
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

const openAiRequestBody = ({
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
  messages,
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

const mergeConversation = <Role extends string>(
  entries: Array<{ role: Role; content: string }>,
  fallbackRole: Role,
  fallbackContent: string
) => {
  const merged: Array<{ role: Role; content: string }> = [];

  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) {
      continue;
    }

    const last = merged.at(-1);
    if (last?.role === entry.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      merged.push({ role: entry.role, content });
    }
  }

  if (!merged.length || merged[0]?.role !== fallbackRole) {
    merged.unshift({ role: fallbackRole, content: fallbackContent });
  }

  return merged;
};

const toAnthropicPayload = ({
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
      content: message.content
    })),
    "user",
    "Continue the conversation."
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

const toGeminiPayload = ({
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
      content: message.content
    })),
    "user",
    "Continue the conversation."
  );

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: geminiMessages.map((message) => ({
      role: message.role,
      parts: [{ text: message.content }]
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

export const fetchAvailableModels = async (settings: UserSettings): Promise<AvailableModelsResult> => {
  const provider = normalizeProvider(settings.activeProvider);
  let response: Response;
  const modelUrl = joinApiPath(settings.apiBaseUrl, "models");

  try {
    response = await fetch(modelUrl, {
      method: "GET",
      headers: authHeaders(settings, provider)
    });
  } catch {
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const models =
    provider === "google-gemini"
      ? (payload.models ?? [])
          .filter((model) => model.supportedGenerationMethods?.includes("generateContent") ?? true)
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
      signal,
      body: JSON.stringify(openAiRequestBody({ settings, messages, stream: true }))
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  for await (const parsed of readSseJson(response)) {
    const typed = parsed as {
      choices?: Array<{ delta?: { content?: string }; text?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      } | null;
    };
    const usage = parseUsage(typed.usage);
    if (usage) {
      yield { type: "usage", usage } satisfies ChatCompletionStreamEvent;
    }

    const token = typed.choices?.[0]?.delta?.content ?? typed.choices?.[0]?.text ?? "";
    if (token) {
      yield { type: "token", content: token } satisfies ChatCompletionStreamEvent;
    }
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
      signal,
      body: JSON.stringify(toAnthropicPayload({ settings, messages, stream: true }))
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  let promptTokens = 0;
  let completionTokens = 0;

  for await (const parsed of readSseJson(response)) {
    const type = parsed.type;

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
        signal,
        body: JSON.stringify(toGeminiPayload({ settings, messages }))
      }
    );
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  let usage: TokenUsage | null = null;
  for await (const parsed of readSseJson(response)) {
    const token = parseGeminiText(parsed);
    if (token) {
      yield { type: "token", content: token } satisfies ChatCompletionStreamEvent;
    }

    usage = parseGeminiUsage(parsed.usageMetadata) ?? usage;
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
      signal,
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
    if (signal?.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };

  return (
    payload.choices?.[0]?.message?.content ??
    payload.choices?.[0]?.text ??
    ""
  ).trim();
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
      signal,
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
    if (signal?.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  return (payload.content ?? []).map((part) => part.text ?? "").join("").trim();
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
        signal,
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
    if (signal?.aborted) {
      throw error;
    }
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return parseGeminiText(await response.json()).trim();
};

export const completeChatCompletion = async (input: {
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
  const promptTokens = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  const completionTokens = estimateTokens(completion);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true
  };
};
