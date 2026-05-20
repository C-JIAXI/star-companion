import type { UserSettings } from "@prisma/client";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ConnectionTestResult = {
  reachable: true;
  model: string;
  checkedAt: string;
};

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const authHeaders = (settings: UserSettings) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
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
        stream: true
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
      };
      const token = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? "";
      if (token) {
        yield token;
      }
    }
  }
}
