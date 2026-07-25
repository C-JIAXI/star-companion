import type { UserSettings } from "@prisma/client";
import { decryptApiKey } from "./apiKeyVault.js";
import { normalizeProviderKind } from "./moduleModels.js";

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const openAiHeaders = (settings: UserSettings, contentType = "application/json") => {
  const apiKey = decryptApiKey(settings.apiKey);
  const headers: Record<string, string> = {};
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
};

const assertOpenAiCompatible = (settings: UserSettings, feature: string) => {
  if (normalizeProviderKind(settings.activeProvider) !== "openai-compatible") {
    throw new Error(`${feature} currently requires an OpenAI-compatible provider.`);
  }
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

export const transcribeAudio = async ({
  settings,
  audioBase64,
  mimeType,
  filename
}: {
  settings: UserSettings;
  audioBase64: string;
  mimeType: string;
  filename?: string;
}) => {
  assertOpenAiCompatible(settings, "Voice transcription");

  const bytes = Buffer.from(audioBase64, "base64");
  if (!bytes.length) {
    throw new Error("Audio payload is empty.");
  }

  const form = new FormData();
  form.set("model", settings.model);
  form.set("file", new Blob([bytes], { type: mimeType }), filename || "recording.webm");

  const response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: openAiHeaders(settings, ""),
    body: form
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as { text?: string };
  return {
    text: payload.text?.trim() ?? "",
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};

export const createSpeechAudio = async ({
  settings,
  text,
  voice,
  format
}: {
  settings: UserSettings;
  text: string;
  voice: string;
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}) => {
  assertOpenAiCompatible(settings, "Text to speech");

  const response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/speech"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      input: text,
      voice,
      response_format: format
    })
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const contentType = response.headers.get("content-type") || `audio/${format}`;
  const audioBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  return {
    audioBase64,
    mimeType: contentType,
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};

export const generateImage = async ({
  settings,
  prompt,
  size
}: {
  settings: UserSettings;
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
}) => {
  assertOpenAiCompatible(settings, "Image generation");

  const response = await fetch(joinApiPath(settings.apiBaseUrl, "images/generations"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      prompt,
      n: 1,
      size,
      response_format: "b64_json"
    })
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  };

  return {
    images: (payload.data ?? []).map((image) => ({
      url: image.url,
      b64Json: image.b64_json,
      mimeType: "image/png"
    })),
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};
