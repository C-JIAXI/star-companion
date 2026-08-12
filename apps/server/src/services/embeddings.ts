import type { UserSettings } from "@prisma/client";
import { decryptApiKey } from "./apiKeyVault.js";
import { normalizeProviderKind } from "./moduleModels.js";
import { createModelError, malformedModelResponse, modelErrorFromResponse, normalizeModelError } from "./modelErrors.js";

export type EmbeddingTask = "query" | "document";

export type EmbeddingResult = {
  model: string;
  vectors: number[][];
};

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;


const validateVector = (value: unknown): number[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16_384 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw malformedModelResponse("embedding", "unknown");
  }

  return value as number[];
};

const normalizeGeminiModel = (model: string) => model.replace(/^models\//, "");

const generateOpenAiCompatibleEmbeddings = async (
  settings: UserSettings,
  inputs: string[]
): Promise<EmbeddingResult> => {
  const apiKey = decryptApiKey(settings.apiKey);
  let response: Response;

  try {
    response = await fetch(joinApiPath(settings.apiBaseUrl, "embeddings"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ model: settings.model, input: inputs })
    });
  } catch (error) {
    throw normalizeModelError(error, { provider: "openai-compatible", modelId: settings.model });
  }

  if (!response.ok) {
    throw await modelErrorFromResponse({ response, provider: "openai-compatible", modelId: settings.model });
  }

  let payload: {
    model?: string;
    data?: Array<{ index?: number; embedding?: unknown }>;
  };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("openai-compatible", settings.model); }
  const ordered = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const vectors = ordered.map((entry) => validateVector(entry.embedding));
  if (vectors.length !== inputs.length) {
    throw new Error("Embedding API returned an unexpected number of vectors");
  }

  return { model: payload.model?.trim() || settings.model, vectors };
};

const generateGeminiEmbeddings = async (
  settings: UserSettings,
  inputs: string[],
  task: EmbeddingTask
): Promise<EmbeddingResult> => {
  const model = normalizeGeminiModel(settings.model);
  const apiKey = decryptApiKey(settings.apiKey);
  let response: Response;

  try {
    response = await fetch(
      joinApiPath(settings.apiBaseUrl, `models/${encodeURIComponent(model)}:batchEmbedContents`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-goog-api-key": apiKey } : {})
        },
        body: JSON.stringify({
          requests: inputs.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT"
          }))
        })
      }
    );
  } catch (error) {
    throw normalizeModelError(error, { provider: "google-gemini", modelId: settings.model });
  }

  if (!response.ok) {
    throw await modelErrorFromResponse({ response, provider: "google-gemini", modelId: settings.model });
  }

  let payload: {
    embeddings?: Array<{ values?: unknown }>;
  };
  try { payload = await response.json() as typeof payload; } catch { throw malformedModelResponse("google-gemini", settings.model); }
  const vectors = (payload.embeddings ?? []).map((entry) => validateVector(entry.values));
  if (vectors.length !== inputs.length) {
    throw new Error("Embedding API returned an unexpected number of vectors");
  }

  return { model, vectors };
};

export const generateEmbeddings = async ({
  settings,
  inputs,
  task
}: {
  settings: UserSettings;
  inputs: string[];
  task: EmbeddingTask;
}): Promise<EmbeddingResult> => {
  const normalizedInputs = inputs.map((input) => input.trim());
  if (normalizedInputs.length === 0 || normalizedInputs.some((input) => !input)) {
    throw new Error("Embedding input cannot be empty");
  }

  if (normalizeProviderKind(settings.activeProvider) === "anthropic") {
    throw createModelError({ code: "unsupported_capability", provider: "anthropic", modelId: settings.model });
  }

  if (normalizeProviderKind(settings.activeProvider) === "google-gemini") {
    return generateGeminiEmbeddings(settings, normalizedInputs, task);
  }

  return generateOpenAiCompatibleEmbeddings(settings, normalizedInputs);
};
