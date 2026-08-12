import type { UserSettings } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { decryptApiKey } from "./apiKeyVault.js";
import { normalizeProviderKind } from "./moduleModels.js";
import { createModelError, malformedModelResponse, modelErrorFromResponse, normalizeModelError } from "./modelErrors.js";
import { estimateInputTokens } from "./modelUsage.js";
import { executeReliableOperation } from "./reliableModelCalls.js";

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

const assertOpenAiCompatible = (settings: UserSettings, _feature: string) => {
  if (normalizeProviderKind(settings.activeProvider) !== "openai-compatible") {
    throw createModelError({ code: "unsupported_capability", provider: settings.activeProvider, modelId: settings.model });
  }
};


const transcribeAudioOnce = async ({
  settings,
  audioBase64,
  mimeType,
  filename,
  signal
}: {
  settings: UserSettings;
  audioBase64: string;
  mimeType: string;
  filename?: string;
  signal?: AbortSignal;
}) => {
  assertOpenAiCompatible(settings, "Voice transcription");

  const bytes = Buffer.from(audioBase64, "base64");
  if (!bytes.length) {
    throw new Error("Audio payload is empty.");
  }

  const form = new FormData();
  form.set("model", settings.model);
  form.set("file", new Blob([bytes], { type: mimeType }), filename || "recording.webm");

  let response: Response;
  try { response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: openAiHeaders(settings, ""),
    body: form,
    signal
  }); } catch (error) { throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model }); }

  if (!response.ok) {
    throw await modelErrorFromResponse({ response, provider: "openai-compatible", modelId: settings.model });
  }

  let payload: { text?: string };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("openai-compatible", settings.model); }
  return {
    text: payload.text?.trim() ?? "",
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};

const createSpeechAudioOnce = async ({
  settings,
  text,
  voice,
  format,
  signal
}: {
  settings: UserSettings;
  text: string;
  voice: string;
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  signal?: AbortSignal;
}) => {
  assertOpenAiCompatible(settings, "Text to speech");

  let response: Response;
  try { response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/speech"), {
    method: "POST",
    headers: openAiHeaders(settings),
    signal,
    body: JSON.stringify({
      model: settings.model,
      input: text,
      voice,
      response_format: format
    })
  }); } catch (error) { throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model }); }

  if (!response.ok) {
    throw await modelErrorFromResponse({ response, provider: "openai-compatible", modelId: settings.model });
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

const generateImageOnce = async ({
  settings,
  prompt,
  size,
  signal
}: {
  settings: UserSettings;
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  signal?: AbortSignal;
}) => {
  assertOpenAiCompatible(settings, "Image generation");

  let response: Response;
  try { response = await fetch(joinApiPath(settings.apiBaseUrl, "images/generations"), {
    method: "POST",
    headers: openAiHeaders(settings),
    signal,
    body: JSON.stringify({
      model: settings.model,
      prompt,
      n: 1,
      size,
      response_format: "b64_json"
    })
  }); } catch (error) { throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model }); }

  if (!response.ok) {
    throw await modelErrorFromResponse({ response, provider: "openai-compatible", modelId: settings.model });
  }

  let payload: {
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("openai-compatible", settings.model); }

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

export const transcribeAudio = async (input: {
  settings: UserSettings;
  audioBase64: string;
  mimeType: string;
  filename?: string;
  requestId?: string;
  overrideHardBudget?: boolean;
}) => (await executeReliableOperation({
  settings: input.settings,
  context: { requestId: input.requestId ?? `transcription_${randomUUID()}`, module: "voice_transcription", operation: "transcribe", overrideHardBudget: input.overrideHardBudget },
  specialTokensUnknown: true,
  invoke: async (settings, signal) => ({ value: await transcribeAudioOnce({ ...input, settings, signal }) })
})).value;

export const createSpeechAudio = async (input: {
  settings: UserSettings;
  text: string;
  voice: string;
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  requestId?: string;
  overrideHardBudget?: boolean;
}) => (await executeReliableOperation({
  settings: input.settings,
  context: { requestId: input.requestId ?? `speech_${randomUUID()}`, module: "voice_speech", operation: "speak", overrideHardBudget: input.overrideHardBudget },
  estimatedInputTokens: estimateInputTokens([input.text]),
  specialTokensUnknown: true,
  invoke: async (settings, signal) => ({ value: await createSpeechAudioOnce({ ...input, settings, signal }) })
})).value;

export const generateImage = async (input: {
  settings: UserSettings;
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  requestId?: string;
  overrideHardBudget?: boolean;
}) => (await executeReliableOperation({
  settings: input.settings,
  context: { requestId: input.requestId ?? `image_${randomUUID()}`, module: "image_generation", operation: "generate_image", overrideHardBudget: input.overrideHardBudget },
  estimatedInputTokens: estimateInputTokens([input.prompt]),
  specialTokensUnknown: true,
  invoke: async (settings, signal) => ({ value: await generateImageOnce({ ...input, settings, signal }) })
})).value;
