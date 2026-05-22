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

export type ChatCompletionStreamEvent =
  | {
      type: "token";
      content: string;
    }
  | {
      type: "usage";
      usage: TokenUsage;
    };

export type ConnectionTestResult = {
  reachable: true;
  model: string;
  checkedAt: string;
};

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const authHeaders = (settings: UserSettings) => {
  const apiKey = decryptApiKey(settings.apiKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
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

export const testModelConnection = async (settings: UserSettings): Promise<ConnectionTestResult> => {
  let response: Response;
  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "models"), {
      method: "GET",
      headers: authHeaders(settings)
    });
  } catch {
    throw new Error("Unable to reach the configured model API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    reachable: true,
    model: settings.model,
    checkedAt: new Date().toISOString()
  };
};

export async function* streamChatCompletion({
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
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        top_p: settings.topP,
        stream: true,
        stream_options: { include_usage: true }
      })
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

  if (!response.body) {
    throw new Error("Model API did not return a response stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; text?: string }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        } | null;
      };
      if (parsed.usage) {
        const promptTokens = parsed.usage.prompt_tokens ?? 0;
        const completionTokens = parsed.usage.completion_tokens ?? 0;
        yield {
          type: "usage",
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: parsed.usage.total_tokens ?? promptTokens + completionTokens,
            estimated: false
          }
        } satisfies ChatCompletionStreamEvent;
      }

      const token = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? "";
      if (token) {
        yield { type: "token", content: token } satisfies ChatCompletionStreamEvent;
      }
    }
  }
}

export const completeChatCompletion = async ({
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
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: temperature ?? Math.min(settings.temperature, 0.4),
        max_tokens: maxTokens ?? Math.min(settings.maxTokens, 500),
        top_p: settings.topP,
        stream: false
      })
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
