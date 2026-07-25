import type { UserSettings } from "@prisma/client";
import { decryptApiKey } from "./apiKeyVault.js";
import { normalizeProviderKind } from "./moduleModels.js";

export type EmbeddingTask = "query" | "document";

export type EmbeddingResult = {
  model: string;
  vectors: number[][];
};

const joinApiPath = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const readErrorMessage = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return `Embedding API request failed with status ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    return parsed.error?.message ?? parsed.message ?? `Embedding API request failed with status ${response.status}`;
  } catch {
    return text.slice(0, 400);
  }
};

const validateVector = (value: unknown): number[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16_384 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new Error("Embedding API returned an invalid vector");
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
  } catch {
    throw new Error("Unable to reach the configured embedding API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    model?: string;
    data?: Array<{ index?: number; embedding?: unknown }>;
  };
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
  } catch {
    throw new Error("Unable to reach the configured embedding API");
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as {
    embeddings?: Array<{ values?: unknown }>;
  };
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
    throw new Error("Anthropic does not provide a native text embedding endpoint");
  }

  if (normalizeProviderKind(settings.activeProvider) === "google-gemini") {
    return generateGeminiEmbeddings(settings, normalizedInputs, task);
  }

  return generateOpenAiCompatibleEmbeddings(settings, normalizedInputs);
};
