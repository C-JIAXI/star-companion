import cors from "cors";
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  backupExecuteSchema,
  backupPreviewRequestSchema,
  characterBatchDeleteSchema,
  characterBatchFetchSchema,
  characterBatchTagsSchema,
  characterCreateSchema,
  characterDuplicateSchema,
  characterDraftSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUnlockSchema,
  characterUpdateRequestSchema,
  chatAgentDraftSchema,
  chatArchiveImportSchema,
  chatBatchArchiveSchema,
  chatBatchFolderSchema,
  chatRenameFolderSchema,
  chatBatchPermanentDeleteSchema,
  chatBatchTrashSchema,
  chatBranchSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMessageSearchQuerySchema,
  chatMemoryUpdateSchema,
  memoryPurgeSchema,
  memoryRestoreExecuteSchema,
  memoryUndoExecuteSchema,
  profileSummaryRestoreExecuteSchema,
  chatUpdateSchema,
  continueRequestSchema,
  imageGenerationSchema,
  imageAttachmentUploadSchema,
  imageAttachmentReorderSchema,
  imageAttachmentEditDraftSchema,
  generationRequestSchema,
  messageCreateSchema,
  messageListQuerySchema,
  messageUpdateSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema,
  generationStatusRequestSchema,
  userProfileUpdateSchema,
  voiceSpeechSchema,
  voiceTranscriptionSchema,
  settingsUpdateSchema,
  lanSyncRequestSchema
} from "../server-dist/schemas.js";
import { normalizeUploadedImage, validateStoredImage } from "../server-dist/services/imageNormalization.js";
import { buildCharacterDraftMessages, getCharacterDraftMeta, parseCharacterDraftItems } from "../server-dist/services/characterDraftProtocol.js";
import { applyCharacterTagOperation } from "../server-dist/services/characterTags.js";
import {
  decryptApiKey,
  encryptApiKey,
  hasStoredApiKey,
  isEncryptedApiKey
} from "../server-dist/services/apiKeyVault.js";
import {
  completeChatCompletionDetailed,
  estimateTokenUsage,
  fetchAvailableModels,
  streamChatCompletion
} from "../server-dist/services/completions.js";
import { ModelCallError, normalizeModelError } from "../server-dist/services/modelErrors.js";
import { generateEmbeddings } from "../server-dist/services/embeddings.js";
import { buildRegenerationGuidanceMessage } from "../server-dist/services/regeneration.js";
import { getAppInfo } from "../server-dist/services/appInfo.js";
import { generatedBuildInfo } from "../server-dist/generated/buildInfo.js";
import { getUserCustomConfigSegments } from "../server-dist/services/userCustomConfig.js";
import {
  assertCharacterUnlockPassword,
  buildCharacterUpdateData,
  canExportCharacterPublicly,
  createCharacterExportCard,
  importCharacterCard,
  isImportedPrivateCharacter,
  reEncryptImportedCharacter,
  resolveCharacterRecord,
  resolveCharacterPromptFields,
  toCharacterTags,
  toQuickReplies
} from "./privateCharacters.mjs";
import { MobileStore } from "./store.mjs";
import { mobileBuildType, mobileExternalUpdateUrl } from "./build-info.mjs";

const APP_NAME = "Star Companion Mobile Backend";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const port = Number(process.env.MOBILE_BACKEND_PORT ?? process.env.SERVER_PORT ?? 4110);
const host = process.env.MOBILE_BACKEND_HOST ?? "0.0.0.0";
const resolveDataDir = () => {
  if (process.env.MOBILE_BACKEND_DATA_DIR) {
    return process.env.MOBILE_BACKEND_DATA_DIR;
  }
  if (process.env.STAR_COMPANION_DATA_DIR) {
    return process.env.STAR_COMPANION_DATA_DIR;
  }

  try {
    const bridge = require("bridge");
    if (typeof bridge.getDataPath === "function") {
      return path.join(bridge.getDataPath(), "star-companion");
    }
  } catch {
    // The bridge module only exists inside the embedded mobile Node runtime.
  }

  return path.resolve(__dirname, "..", "data");
};
const dataDir = resolveDataDir();
const store = new MobileStore(path.join(dataDir, "mobile-backend.json"));
const exportDir = path.join(dataDir, "exports");

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
    error.status = 400;
    throw error;
  }
  return parsed.data;
};

const parseQuery = (schema, query) => parseBody(schema, query);
const requireParam = (request, name) => {
  const value = request.params[name];
  if (!value) {
    const error = new Error(`Missing route parameter: ${name}`);
    error.status = 400;
    throw error;
  }
  return value;
};

const asyncHandler = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const notFound = (message) => {
  const error = new Error(message);
  error.status = 404;
  return error;
};

const httpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const getActiveChat = (id) => {
  const chat = store.getChat(id);
  return chat && !chat.deletedAt ? chat : null;
};

const toStringArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

const dropUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([_key, entry]) => entry !== undefined));

const KEYWORD_CANDIDATE_LIMIT = 12;
const RERANKED_MEMORY_LIMIT = 5;
const AUTO_MEMORY_THROTTLE_MS = 30_000;
const RECENT_MEMORY_MESSAGE_LIMIT = 6;
const RECENT_PROFILE_MESSAGE_LIMIT = 16;
const EXISTING_MEMORY_LIMIT = 30;
const EMBEDDING_BATCH_SIZE = 64;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.25;
const MAX_PROFILE_LENGTH = 1800;

const uniqueStrings = (values, limit) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
].slice(0, limit);

const extractJsonObject = (raw) => {
  const text = raw.trim();
  if (!text) return null;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const parseJsonObject = (raw) => {
  const json = extractJsonObject(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const tokenize = (value) =>
  uniqueStrings(value.toLowerCase().split(/[^0-9a-z_\u4e00-\u9fff-]+/g), 80)
    .filter((token) => token.length > 1);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const sanitizeExportFilename = (value) => {
  const fallback = `export-${new Date().toISOString().slice(0, 10)}.txt`;
  const filename = typeof value === "string" ? value.trim() : "";
  const safe = filename
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return safe || fallback;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBoundaryKeyword = (value) => /^[a-z0-9][a-z0-9_-]*$/i.test(value);

const matchesKeyword = (key, contextText) => {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) return false;
  if (!isBoundaryKeyword(normalizedKey)) {
    return contextText.includes(normalizedKey);
  }
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedKey)}(?=$|[^a-z0-9_])`, "i").test(contextText);
};

const normalizeLoreTriggerMode = (value) =>
  value === "user" || value === "assistant" ? value : "both";

const normalizeLoreScope = (value) =>
  value === "prefix" || value === "suffix" ? value : "prompt";

const buildLoreContexts = (recentMessages) => {
  const textFor = (roles) =>
    recentMessages
      .filter((message) => roles.includes(message.role))
      .map((message) => message.content ?? "")
      .join("\n")
      .toLowerCase();

  return {
    user: textFor(["user"]),
    assistant: textFor(["assistant"]),
    both: textFor(["user", "assistant"])
  };
};

const findMatchedLoreEntries = (character, promptFields, recentMessages) => {
  const entries = Array.isArray(promptFields?.loreEntries) ? promptFields.loreEntries : [];
  if (!character || entries.length === 0) return [];

  const contexts = buildLoreContexts(recentMessages);
  return entries
    .filter((entry) => entry?.enabled !== false && !entry?.deletedAt)
    .filter((entry) => {
      if (entry.alwaysActive) return true;
      const triggerMode = normalizeLoreTriggerMode(entry.triggerMode);
      return toStringArray(entry.keys).some((key) => matchesKeyword(key, contexts[triggerMode]));
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      characterId: character.id,
      characterName: character.name,
      keys: toStringArray(entry.keys),
      content: entry.content ?? "",
      priority: entry.priority ?? 0,
      scope: normalizeLoreScope(entry.scope),
      triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
      alwaysActive: Boolean(entry.alwaysActive),
      enabled: entry.enabled !== false
    }));
};

const buildCharacterSystemPrompt = (promptFields, loreEntries = []) => {
  if (!promptFields) return "";

  const loreFor = (scope) =>
    loreEntries
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.content.trim())
      .filter(Boolean)
      .join("\n\n");

  return [
    [promptFields.prefix?.trim(), loreFor("prefix")].filter(Boolean).join("\n\n"),
    [promptFields.prompt?.trim(), loreFor("prompt")].filter(Boolean).join("\n\n"),
    [promptFields.suffix?.trim(), loreFor("suffix")].filter(Boolean).join("\n\n")
  ]
    .filter(Boolean)
    .join("\n\n");
};

const estimatePromptTokens = (content) => {
  const compact = String(content ?? "").trim();
  return compact ? Math.max(1, Math.ceil(compact.length / 2)) : 0;
};

const createPromptBreakdownSection = (id, contents, itemCount) => {
  const nonEmptyContents = contents.map((content) => String(content ?? "")).filter((content) => content.trim());
  return {
    id,
    tokenEstimate: nonEmptyContents.reduce(
      (total, content) => total + estimatePromptTokens(content),
      0
    ),
    characterCount: nonEmptyContents.reduce((total, content) => total + content.trim().length, 0),
    itemCount: itemCount ?? nonEmptyContents.length
  };
};

const buildPromptBreakdown = ({
  messages,
  characterPrompt,
  userConfigSegments,
  userProfileSummary,
  matchedLoreEntries,
  memoryPrompt,
  memoryEntryCount,
  historyMessages
}) => {
  const sections = [
    createPromptBreakdownSection("character", [characterPrompt]),
    createPromptBreakdownSection(
      "lore",
      matchedLoreEntries.map((entry) => entry.content),
      matchedLoreEntries.length
    ),
    createPromptBreakdownSection("user_persona", userConfigSegments),
    createPromptBreakdownSection("user_profile", [userProfileSummary]),
    createPromptBreakdownSection("memory", [memoryPrompt], memoryEntryCount),
    createPromptBreakdownSection(
      "history",
      historyMessages.map((message) => message.content),
      historyMessages.length
    )
  ].filter((section) => section.tokenEstimate > 0 || section.itemCount > 0);
  const promptTokens = messages.reduce(
    (total, message) => total + estimatePromptTokens(message.content),
    0
  );
  const allocatedTokens = sections.reduce((total, section) => total + section.tokenEstimate, 0);
  if (promptTokens > allocatedTokens) {
    sections.push({
      id: "formatting",
      tokenEstimate: promptTokens - allocatedTokens,
      characterCount: 0,
      itemCount: 0
    });
  }
  return {
    promptTokens,
    promptTokensEstimated: true,
    includedMessageCount: historyMessages.length,
    sections
  };
};

const appendPromptBreakdownInstruction = (breakdown, content) => {
  const section = createPromptBreakdownSection("generation_instruction", [content]);
  if (!section.tokenEstimate) return breakdown;
  return {
    ...breakdown,
    promptTokens: breakdown.promptTokens + section.tokenEstimate,
    sections: [...breakdown.sections, section]
  };
};

const finalizePromptBreakdown = (breakdown, promptTokens, promptTokensEstimated) => {
  const normalizedTotal = Math.max(0, Math.round(promptTokens));
  const weightTotal = breakdown.sections.reduce(
    (total, section) => total + section.tokenEstimate,
    0
  );
  if (!breakdown.sections.length || weightTotal <= 0) {
    return { ...breakdown, promptTokens: normalizedTotal, promptTokensEstimated };
  }

  const allocations = breakdown.sections.map((section, index) => {
    const exact = (section.tokenEstimate / weightTotal) * normalizedTotal;
    return { index, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = normalizedTotal - allocations.reduce((total, item) => total + item.floor, 0);
  const byFraction = [...allocations].sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    byFraction[index % byFraction.length].floor += 1;
  }
  const allocatedByIndex = new Map(allocations.map((item) => [item.index, item.floor]));
  return {
    ...breakdown,
    promptTokens: normalizedTotal,
    promptTokensEstimated,
    sections: breakdown.sections.map((section, index) => ({
      ...section,
      tokenEstimate: allocatedByIndex.get(index) ?? 0
    }))
  };
};

const scoreMemory = (memory, queryText, queryTokens) => {
  const lowerQuery = queryText.toLowerCase();
  const keywords = toStringArray(memory.keywords).map((keyword) => keyword.toLowerCase());
  const searchable = `${memory.title}\n${memory.content}`.toLowerCase();
  const searchableTokens = new Set(tokenize(searchable));
  const keywordScore = keywords.reduce(
    (total, keyword) => total + (keyword && lowerQuery.includes(keyword) ? 8 : 0),
    0
  );
  const tokenScore = [...queryTokens].reduce(
    (total, token) => total + (searchableTokens.has(token) ? 2 : searchable.includes(token) ? 1 : 0),
    0
  );
  const relevanceScore = keywordScore + tokenScore;
  if (relevanceScore <= 0) return 0;

  const importanceScore = (memory.importance ?? 3) * 1.5;
  const lastMatchedAt = memory.lastMatchedAt ? new Date(memory.lastMatchedAt).getTime() : 0;
  const recentMatchScore = lastMatchedAt
    ? Math.max(0, 2 - (Date.now() - lastMatchedAt) / (1000 * 60 * 60 * 24 * 14))
    : 0;

  return relevanceScore + importanceScore + recentMatchScore;
};

const toNumberArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? value
    : null;

const toMemoryEmbeddingText = (memory) =>
  [
    String(memory.title ?? "").trim(),
    String(memory.content ?? "").trim(),
    toStringArray(memory.keywords).length
      ? `Keywords: ${toStringArray(memory.keywords).join(", ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);

const cosineSimilarity = (left, right) => {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

const toEmbeddingIdentity = (settings) =>
  [
    String(settings.activeProvider ?? "").trim().toLowerCase(),
    String(settings.apiBaseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase(),
    String(settings.model ?? "").trim()
  ].join(":");

const getConfiguredEmbeddingSource = (settings) =>
  toEmbeddingIdentity(resolveModuleSettings(settings, "memory_embedding"));

const ensureMemoryEmbeddings = async (memories, settings, force = false) => {
  let embeddingSettings;
  try {
    embeddingSettings = resolveModuleSettings(settings, "memory_embedding");
  } catch {
    return null;
  }

  const embeddingSource = toEmbeddingIdentity(embeddingSettings);
  const embeddingModel = `${String(embeddingSettings.activeProvider ?? "").trim().toLowerCase()}:${String(embeddingSettings.model ?? "").trim()}`;
  const vectors = new Map();
  const stale = memories.filter((memory) => {
    const vector = toNumberArray(memory.embedding);
    if (
      !force &&
      memory.embeddingStatus === "ready" &&
      memory.embeddingSource === embeddingSource &&
      memory.embeddingDimensions === vector?.length &&
      vector
    ) {
      vectors.set(memory.id, vector);
      return false;
    }
    return true;
  });
  const pendingIds = new Set(stale.map((memory) => memory.id));

  try {
    for (let start = 0; start < stale.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = stale.slice(start, start + EMBEDDING_BATCH_SIZE);
      const result = await executeMobileReliableEmbeddings({
        rootSettings: settings,
        inputs: batch.map(toMemoryEmbeddingText),
        task: "document",
        chatId: batch[0]?.chatId ?? null
      });
      const embeddingUpdatedAt = new Date().toISOString();
      for (let index = 0; index < batch.length; index += 1) {
        const memory = batch[index];
        const vector = result.value.vectors[index];
        vectors.set(memory.id, vector);
        await store.updateMemory(memory.chatId, memory.id, {
          embedding: vector,
          embeddingModel,
          embeddingSource,
          embeddingDimensions: vector.length,
          embeddingStatus: "ready",
          embeddingUpdatedAt
        });
        pendingIds.delete(memory.id);
      }
    }
    const dimensions = vectors.values().next().value?.length;
    if (!dimensions || [...vectors.values()].some((vector) => vector.length !== dimensions)) return null;
    return { settings: embeddingSettings, source: embeddingSource, dimensions, vectors };
  } catch {
    await Promise.all(
      stale
        .filter((memory) => pendingIds.has(memory.id))
        .map((memory) =>
          store.updateMemory(memory.chatId, memory.id, { embeddingStatus: "failed" })
        )
    );
    return null;
  }
};

const toMatchedMemoryEntry = (memory, score) => ({
  ...serializeMemory(memory),
  score
});

const buildMemoryRerankMessages = (queryText, candidates) => [
  {
    role: "system",
    content: [
      "/no_think",
      "Select long-term chat memories that are useful for answering the next roleplay message.",
      "Only choose from the provided candidate IDs.",
      'Return JSON only: {"ids":["memory-id"]}.',
      "Do not write analysis, markdown, or any text outside the JSON object.",
      `Choose at most ${RERANKED_MEMORY_LIMIT} IDs. Return {"ids":[]} if none are relevant.`
    ].join("\n")
  },
  {
    role: "user",
    content: [
      `Current conversation context:\n${queryText}`,
      "",
      "Candidate memories:",
      candidates
        .map(
          (memory, index) =>
            `${index + 1}. id=${memory.id}\ntitle=${memory.title}\nimportance=${memory.importance}\nkeywords=${memory.keywords.join(", ")}\ncontent=${memory.content}`
        )
        .join("\n\n")
    ].join("\n")
  }
];

const parseRerankedIds = (raw, candidateIds) => {
  const parsed = parseJsonObject(raw);
  const ids = parsed ? parsed.ids : null;
  if (!Array.isArray(ids)) return [];
  return uniqueStrings(
    ids.filter((id) => typeof id === "string" && candidateIds.has(id)),
    RERANKED_MEMORY_LIMIT
  );
};

const rerankMemories = async (queryText, candidates, settings) => {
  if (candidates.length === 0) return [];
  const moduleSettings = resolveModuleSettings(settings, "memory");
  if (!moduleSettings.apiKey) return candidates.slice(0, RERANKED_MEMORY_LIMIT);

  try {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const raw = (await executeMobileReliableText({
      rootSettings: settings,
      module: "memory",
      operation: "memory_rerank",
      messages: buildMemoryRerankMessages(queryText, candidates),
      maxTokens: 180,
      temperature: 0
    })).content;
    const ids = parseRerankedIds(raw.trim(), candidateIds);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = ids.map((id) => byId.get(id)).filter(Boolean);
    return selected.length ? selected : candidates.slice(0, RERANKED_MEMORY_LIMIT);
  } catch {
    return candidates.slice(0, RERANKED_MEMORY_LIMIT);
  }
};

const recallChatMemories = async ({ chatId, query, recentMessages, settings }) => {
  const queryText = [query, ...recentMessages.map((message) => `${message.role}: ${message.content}`)]
    .join("\n")
    .trim();
  if (!queryText) return [];

  const queryTokens = new Set(tokenize(queryText));
  const memories = store.listMemories(chatId).filter((memory) => memory.enabled !== false && !memory.deletedAt);
  let embeddingIndex = null;
  try {
    const embeddingSettings = resolveModuleSettings(settings, "memory_embedding");
    const source = toEmbeddingIdentity(embeddingSettings);
    const readyVectors = memories
      .map((memory) => ({ memory, vector: toNumberArray(memory.embedding) }))
      .filter(({ memory, vector }) =>
        memory.embeddingStatus === "ready" &&
        memory.embeddingSource === source &&
        memory.embeddingDimensions === vector?.length &&
        Boolean(vector)
      );
    const dimensions = readyVectors[0]?.vector?.length;
    if (dimensions && readyVectors.every(({ vector }) => vector?.length === dimensions)) {
      embeddingIndex = {
        settings: embeddingSettings,
        source,
        dimensions,
        vectors: new Map(readyVectors.map(({ memory, vector }) => [memory.id, vector]))
      };
    }
  } catch {
    embeddingIndex = null;
  }
  let queryVector = null;
  if (embeddingIndex) {
    try {
      const result = await executeMobileReliableEmbeddings({
        rootSettings: settings,
        inputs: [queryText.slice(0, 6000)],
        task: "query",
        chatId
      });
      queryVector = result.value.vectors[0]?.length === embeddingIndex.dimensions ? result.value.vectors[0] : null;
    } catch {
      queryVector = null;
    }
  }

  const candidates = memories
    .map((memory) => {
      const keywordScore = scoreMemory(memory, queryText, queryTokens);
      if (!queryVector || !embeddingIndex) {
        return toMatchedMemoryEntry(memory, keywordScore);
      }
      const memoryVector = embeddingIndex.vectors.get(memory.id);
      const semanticScore = memoryVector
        ? Math.max(0, cosineSimilarity(queryVector, memoryVector))
        : 0;
      if (keywordScore <= 0 && semanticScore < SEMANTIC_SIMILARITY_THRESHOLD) {
        return toMatchedMemoryEntry(memory, 0);
      }
      const normalizedKeywordScore = Math.min(1, keywordScore / 25);
      const importanceScore = Math.min(1, Math.max(0, (memory.importance ?? 3) / 5));
      const score =
        (semanticScore * 0.72 + normalizedKeywordScore * 0.23 + importanceScore * 0.05) * 100;
      return toMatchedMemoryEntry(memory, Number(score.toFixed(2)));
    })
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_CANDIDATE_LIMIT);
  const selected = await rerankMemories(queryText, candidates, settings);

  if (selected.length) {
    const matchedAt = new Date().toISOString();
    await Promise.all(selected.map((memory) => store.updateMemory(chatId, memory.id, { lastMatchedAt: matchedAt })));
    return selected.map((memory) => ({ ...memory, lastMatchedAt: matchedAt }));
  }

  return [];
};

const formatMemorySystemPrompt = (memories) => {
  if (memories.length === 0) return "";

  return [
    "Relevant long-term chat memories:",
    ...memories.map((memory, index) => {
      const keywords = memory.keywords.length ? ` [${memory.keywords.join(", ")}]` : "";
      return `${index + 1}. ${memory.title}${keywords}\n${memory.content}`;
    })
  ].join("\n\n");
};

const buildUserProfileSummaryMessages = (currentSummary, userMessages) => [
  {
    role: "system",
    content: [
      "You maintain a concise local user profile memory for a roleplay chat app.",
      "Update the profile only with durable facts or habits explicitly supported by user messages.",
      "Include stable preferences, recurring style, boundaries, goals, names/pronouns if stated, and interaction habits.",
      "Do not include API keys, secrets, credentials, private addresses, unsupported guesses, or one-off transient requests.",
      "Keep it short, neutral, and useful for future assistant responses.",
      "Return only the updated profile summary. If there is no durable new information, return the existing summary."
    ].join("\n")
  },
  {
    role: "user",
    content: [
      `Existing user profile:\n${currentSummary || "(empty)"}`,
      "",
      "Recent user messages:",
      userMessages.map((message, index) => `${index + 1}. ${message}`).join("\n")
    ].join("\n")
  }
];

const updateUserProfileFromChat = async ({ chatId, settings }) => {
  if (settings.autoSummarizeUser === false) return null;

  const chat = getActiveChat(chatId);
  if (!chat) return null;

  const recentUserMessages = store
    .listMessages(chatId)
    .filter((message) => message.role === "user")
    .slice(-RECENT_PROFILE_MESSAGE_LIMIT);
  const recentContents = recentUserMessages.map((message) => message.content.trim()).filter(Boolean);
  if (recentContents.length === 0) return null;

  const summary = (
    await executeMobileReliableText({
      rootSettings: settings,
      module: "user_profile",
      operation: "user_profile_summary",
      chatId,
      messages: buildUserProfileSummaryMessages(chat.userProfileSummary ?? "", recentContents),
      maxTokens: 500,
      temperature: 0.2
    })
  ).content
    .trim()
    .slice(0, MAX_PROFILE_LENGTH);

  if (!summary || summary === chat.userProfileSummary) return null;

  const result = await store.updateProfileSummary(chatId, summary, "automatic_memory", recentUserMessages.map((message) => message.id), "automatic_update");
  return result?.chat ?? null;
};

const buildChatMemoryMaintenanceMessages = (existingMemories, recentMessages) => [
  {
    role: "system",
    content: [
      "/no_think",
      "You maintain long-term memories for one local-first single-character roleplay chat.",
      "Extract durable plot facts, relationship changes, stable preferences, boundaries, plans, and recurring interaction patterns.",
      "Do not store API keys, credentials, secrets, exact private addresses, unsupported guesses, or one-off transient requests.",
      "Prefer updating existing memories over creating duplicates.",
      "Do not delete. You may disable a memory only when the conversation clearly makes it obsolete or false.",
      "Do not write analysis, markdown, bullet lists, or explanations.",
      "Return JSON only with this shape:",
      '{"actions":[{"type":"create","title":"...","content":"...","keywords":["..."],"importance":3},{"type":"update","id":"...","title":"...","content":"...","keywords":["..."],"importance":3,"enabled":true}]}'
    ].join("\n")
  },
  {
    role: "user",
    content: [
      "/no_think",
      "Existing memories:",
      existingMemories.length
        ? existingMemories
            .map(
              (memory, index) =>
                `${index + 1}. id=${memory.id}\ntitle=${memory.title}\nenabled=${memory.enabled !== false}\nimportance=${memory.importance ?? 3}\nkeywords=${toStringArray(memory.keywords).join(", ")}\ncontent=${memory.content}`
            )
            .join("\n\n")
        : "(none)",
      "",
      "Recent conversation:",
      recentMessages
        .map((message, index) => `${index + 1}. ${message.role}: ${message.content}`)
        .join("\n")
    ].join("\n")
  }
];

const clampImportance = (value) =>
  Math.min(5, Math.max(1, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3));

const normalizeMemoryAction = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  if (value.type === "create") {
    const title = typeof value.title === "string" ? value.title.trim().slice(0, 80) : "";
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 1200) : "";
    if (!title || !content) return null;
    return {
      type: "create",
      title,
      content,
      keywords: uniqueStrings(
        Array.isArray(value.keywords)
          ? value.keywords.filter((keyword) => typeof keyword === "string")
          : [],
        12
      ),
      importance: clampImportance(value.importance)
    };
  }

  if (value.type === "update") {
    const id = typeof value.id === "string" ? value.id : "";
    if (!id) return null;
    return {
      type: "update",
      id,
      title: typeof value.title === "string" ? value.title.trim().slice(0, 80) : undefined,
      content: typeof value.content === "string" ? value.content.trim().slice(0, 1200) : undefined,
      keywords: Array.isArray(value.keywords)
        ? uniqueStrings(value.keywords.filter((keyword) => typeof keyword === "string"), 12)
        : undefined,
      importance: value.importance === undefined ? undefined : clampImportance(value.importance),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined
    };
  }

  return null;
};

const parseMemoryActions = (raw) => {
  const parsed = parseJsonObject(raw);
  const actions = parsed ? parsed.actions : null;
  if (!Array.isArray(actions)) return null;
  return actions.map(normalizeMemoryAction).filter(Boolean);
};

const updateChatMemoriesFromTurn = async ({ chatId, settings, force = false }) => {
  const chat = getActiveChat(chatId);
  if (!chat?.autoMemoryEnabled) return null;

  if (!force && chat.memoryUpdatedAt && Date.now() - new Date(chat.memoryUpdatedAt).getTime() < AUTO_MEMORY_THROTTLE_MS) {
    return null;
  }

  const recentMessages = store.listMessages(chatId).slice(-RECENT_MEMORY_MESSAGE_LIMIT);
  if (recentMessages.length === 0) return null;

  const existingMemories = store.listMemories(chatId).filter((memory) => !memory.deletedAt).slice(0, EXISTING_MEMORY_LIMIT);
  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const sourceMessageIds = recentMessages.map((message) => message.id);
  const operation = await store.createMemoryOperation({ chatId, type: "automatic_maintenance", actor: "automatic_memory", status: "running", sourceMessageIds });
  let actions;
  try {
    const raw = (await executeMobileReliableText({
      rootSettings: settings, module: "memory", operation: "memory_maintenance", chatId,
      messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages), maxTokens: 1600, temperature: 0.2
    })).content;
    actions = parseMemoryActions(raw.trim());
    if (!actions) {
      const failedAt = new Date().toISOString();
      await store.writeRecord("memoryOperation", { ...operation, status: "failed", completedAt: failedAt, errorCode: "invalid_model_output", updatedAt: failedAt }, true);
      return null;
    }
  } catch (error) {
    const failedAt = new Date().toISOString();
    await store.writeRecord("memoryOperation", { ...operation, status: "failed", completedAt: failedAt, errorCode: "maintenance_failed", updatedAt: failedAt }, true);
    throw error;
  }
  const result = await store.atomicWrite(async () => {
    let created = 0;
    let updated = 0;
    let disabled = 0;
    let unchanged = 0;
    const changedMemoryIds = [];
    const deduped = actions.slice(0, 8).filter((action, index, list) => action.type === "create" || list.findIndex((candidate) => candidate.type === "update" && candidate.id === action.id) === index);
    for (const action of deduped) {
      if (action.type === "create") {
        const entry = await store.createAuditedMemoryInTransaction({ chatId, title: action.title, content: action.content, keywords: action.keywords, importance: action.importance, enabled: true, sourceMessageIds }, { actor: "automatic_memory", action: "automatic_create", reasonCode: "automatic_maintenance", operationId: operation.id });
        changedMemoryIds.push(entry.memory.id); created += 1; continue;
      }
      if (!existingIds.has(action.id)) { unchanged += 1; continue; }
      const current = store.getMemory(chatId, action.id);
      const isDisable = action.enabled === false && current.enabled !== false;
      const entry = await store.updateAuditedMemoryInTransaction(current, dropUndefined({ title: action.title, content: action.content, keywords: action.keywords, importance: action.importance, enabled: action.enabled, sourceMessageIds }), { actor: "automatic_memory", action: isDisable ? "automatic_disable" : "automatic_update", reasonCode: "automatic_maintenance", operationId: operation.id });
      if (entry.changed) { changedMemoryIds.push(entry.memory.id); updated += 1; if (isDisable) disabled += 1; } else unchanged += 1;
    }
    const updatedAt = new Date().toISOString();
    await store.writeRecord("chat", { ...store.getChat(chatId), memoryUpdatedAt: updatedAt, updatedAt });
    await store.writeRecord("memoryOperation", { ...operation, status: unchanged && created + updated ? "partial" : "succeeded", completedAt: updatedAt, created, updated, disabled, unchanged, updatedAt });
    await store.pruneMemoryOperations(chatId);
    return { created, updated, disabled, unchanged, changedMemoryIds, updatedAt };
  });
  const changedMemories = result.changedMemoryIds
    .map((id) => store.getMemory(chatId, id))
    .filter((memory) => memory?.enabled !== false && !memory?.deletedAt);
  if (changedMemories.length) {
    await ensureMemoryEmbeddings(changedMemories, settings);
  }
  return {
    chatId, operationId: operation.id,
    created: result.created, updated: result.updated, disabled: result.disabled,
    memoryUpdatedAt: result.updatedAt
  };
};

const serializeProviderProfiles = (providers) =>
  Array.isArray(providers)
    ? providers
        .filter((provider) => provider && typeof provider === "object" && !Array.isArray(provider))
        .map((provider) => ({
          id: String(provider.id ?? ""),
          label: String(provider.label ?? ""),
          provider: String(provider.provider ?? ""),
          apiBaseUrl: String(provider.apiBaseUrl ?? ""),
          hasKey: typeof provider.key === "string" && Boolean(provider.key.trim()),
          models: Array.isArray(provider.models) ? provider.models : []
        }))
    : [];

const serializeSettings = (settings) => ({
  id: settings.id,
  activeProvider: settings.activeProvider,
  apiBaseUrl: settings.apiBaseUrl,
  model: settings.model,
  temperature: settings.temperature,
  maxTokens: settings.maxTokens,
  topP: settings.topP,
  language: settings.language === "en" ? "en" : "zh-CN",
  providers: serializeProviderProfiles(settings.providers),
  activeProviderId: settings.activeProviderId ?? "",
  activeModelId: settings.activeModelId ?? "",
  moduleModelPreferences:
    settings.moduleModelPreferences && typeof settings.moduleModelPreferences === "object"
      ? settings.moduleModelPreferences
      : {},
  modelReliability: settings.modelReliability && typeof settings.modelReliability === "object"
    ? settings.modelReliability
    : { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
  usageBudgets: settings.usageBudgets && typeof settings.usageBudgets === "object"
    ? settings.usageBudgets
    : { dailySoftMicros: null, dailyHardMicros: null, monthlySoftMicros: null, monthlyHardMicros: null, allowUnknownPricing: true },
  usageTimezone: settings.usageTimezone || "UTC",
  userPersonaPresets: Array.isArray(settings.userPersonaPresets) ? settings.userPersonaPresets : [],
  userProfileSummary: settings.userProfileSummary ?? "",
  autoSummarizeUser: settings.autoSummarizeUser !== false,
  showMessageAvatars: settings.showMessageAvatars !== false,
  showMessageTimestamps: settings.showMessageTimestamps === true,
  ttsVoice: String(settings.ttsVoice || "alloy"),
  ttsPlaybackRate: Number(settings.ttsPlaybackRate) || 1,
  ttsAutoPlay: settings.ttsAutoPlay === true,
  userProfileUpdatedAt: settings.userProfileUpdatedAt ?? null,
  createdAt: settings.createdAt,
  updatedAt: settings.updatedAt
});

const serializeCharacter = (character, password) => {
  const resolved = resolveCharacterRecord(character, password);

  return {
    ...character,
    name: resolved.name,
    avatar: resolved.avatar,
    description: resolved.description,
    tags: toCharacterTags(character.tags),
    prefix: resolved.prefix,
    prompt: resolved.prompt,
    suffix: resolved.suffix,
    htmlCss: resolved.htmlCss,
    openingHtml: resolved.openingHtml,
    loreEntries: resolved.loreEntries,
    quickReplies: toQuickReplies(character.quickReplies),
    isFavorite: character.isFavorite === true,
    visibility: resolved.visibility,
    canViewPrompt: resolved.canViewPrompt
  };
};

const sortCharactersForPage = (characters, chats, sort) => {
  const stats = new Map();
  for (const chat of chats) {
    if (!chat.characterId || chat.deletedAt) continue;
    const current = stats.get(chat.characterId) ?? { count: 0, latestAt: 0 };
    current.count += 1;
    current.latestAt = Math.max(current.latestAt, Date.parse(chat.updatedAt) || 0);
    stats.set(chat.characterId, current);
  }

  const updatedAt = (character) => Date.parse(character.updatedAt) || 0;
  const fallback = (left, right) =>
    updatedAt(right) - updatedAt(left) || String(left.id).localeCompare(String(right.id));

  return [...characters].sort((left, right) => {
    if (sort === "favorites") {
      return Number(right.isFavorite === true) - Number(left.isFavorite === true) || fallback(left, right);
    }
    if (sort === "recently_chatted") {
      return (stats.get(right.id)?.latestAt ?? 0) - (stats.get(left.id)?.latestAt ?? 0) || fallback(left, right);
    }
    if (sort === "most_chats") {
      return (stats.get(right.id)?.count ?? 0) - (stats.get(left.id)?.count ?? 0) || fallback(left, right);
    }
    if (sort === "name_asc" || sort === "name_desc") {
      const difference = String(left.name).localeCompare(String(right.name), undefined, {
        sensitivity: "base",
        numeric: true
      });
      return (sort === "name_asc" ? difference : -difference) || fallback(left, right);
    }
    return fallback(left, right);
  });
};

const serializeChat = (
  chat,
  messageCount = chat.messageCount ?? 0,
  includeUserAvatar = true
) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId ?? null,
  parentChatId: chat.parentChatId ?? null,
  branchSourceMessageId: chat.branchSourceMessageId ?? null,
  isCheckpoint: chat.isCheckpoint === true,
  isPinned: chat.isPinned === true,
  isArchived: chat.isArchived === true,
  folder: chat.folder ?? "",
  deletedAt: chat.deletedAt ?? null,
  backgroundUrl: chat.backgroundUrl ?? "",
  messageCount,
  memoryTurns: chat.memoryTurns ?? 12,
  autoMemoryEnabled: chat.autoMemoryEnabled !== false,
  memoryUpdatedAt: chat.memoryUpdatedAt ?? null,
  userPersona: chat.userPersona ?? "",
  ...(includeUserAvatar ? { userAvatar: chat.userAvatar ?? "" } : {}),
  userProfileSummary: chat.userProfileSummary ?? "",
  userProfileUpdatedAt: chat.userProfileUpdatedAt ?? null,
  profileRevision: chat.profileRevision ?? 0,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt
});

const serializeMemory = (memory) => ({
  id: memory.id,
  chatId: memory.chatId,
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance ?? 3,
  enabled: memory.enabled !== false,
  deletedAt: memory.deletedAt ?? null,
  currentRevision: memory.currentRevision ?? 0,
  lastActor: memory.lastActor ?? null,
  lastAction: memory.lastAction ?? null,
  sourceMessageIds: toStringArray(memory.sourceMessageIds),
  embeddingModel: memory.embeddingModel ?? null,
  embeddingSource: memory.embeddingSource ?? null,
  embeddingDimensions: memory.embeddingDimensions ?? null,
  embeddingStatus: memory.embeddingStatus ?? "stale",
  embeddingUpdatedAt: memory.embeddingUpdatedAt ?? null,
  lastMatchedAt: memory.lastMatchedAt ?? null,
  createdAt: memory.createdAt,
  updatedAt: memory.updatedAt
});

const serializeMessage = (message) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role === "assistant" || message.role === "system" ? message.role : "user",
  characterId: message.characterId ?? null,
  content: message.content ?? "",
  attachments: store.listMessageAttachments(message.id).map((attachment) => serializeMobileAttachment(attachment)),
  contextIncluded: message.contextIncluded !== false,
  isBookmarked: message.isBookmarked === true,
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex ?? 0,
  tokenUsage: message.tokenUsage ?? null,
  generationMetadata: message.generationMetadata ?? null,
  variantMetadata: Array.isArray(message.variantMetadata) ? message.variantMetadata : [],
  promptBreakdown: message.promptBreakdown ?? null,
  loreMatches: Array.isArray(message.loreMatches) ? message.loreMatches : [],
  memoryMatches: Array.isArray(message.memoryMatches) ? message.memoryMatches : [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt
});

const serializeMobileAttachment = (attachment) => {
  const asset = store.getMediaAsset(attachment.assetId);
  if (!asset) throw new Error("Image asset is missing.");
  return {
    id: attachment.id,
    assetId: asset.id,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    contentHash: asset.contentHash,
    sortOrder: attachment.sortOrder,
    originalFilename: attachment.originalFilename ?? null,
    createdAt: attachment.createdAt,
    url: `/api/media/chat-images/${encodeURIComponent(asset.id)}`
  };
};

const buildMessageSearchSnippet = (content, query) => {
  const normalizedContent = String(content ?? "").toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex < 0) return String(content ?? "").slice(0, 160);

  const source = String(content ?? "");
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(source.length, matchIndex + query.length + 100);
  return `${start > 0 ? "..." : ""}${source.slice(start, end)}${end < source.length ? "..." : ""}`;
};

const publicSettings = (settings) => ({
  ...serializeSettings(settings),
  hasApiKey: hasStoredApiKey(settings.apiKey)
});

const normalizeStoredApiKey = (value) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return isEncryptedApiKey(value) ? value : encryptApiKey(value) ?? undefined;
};

const mergeProviderProfiles = (incomingProviders, storedProviders) => {
  const storedKeys = new Map(
    (Array.isArray(storedProviders) ? storedProviders : [])
      .filter((provider) => provider && typeof provider === "object" && !Array.isArray(provider))
      .flatMap((provider) => {
        const key = normalizeStoredApiKey(provider.key);
        return typeof provider.id === "string" && key ? [[provider.id, key]] : [];
      })
  );

  return incomingProviders.map((profile) => {
    const merged = { ...profile };
    const key = hasOwn(profile, "key")
      ? normalizeStoredApiKey(profile.key)
      : storedKeys.get(profile.id);
    if (key) merged.key = key;
    else delete merged.key;
    return merged;
  });
};

const encryptLegacyProviderKeys = async () => {
  const settings = store.getSettings();
  if (!Array.isArray(settings.providers)) return;

  let changed = false;
  const providers = settings.providers.map((provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return provider;
    const key = normalizeStoredApiKey(provider.key);
    if (!key || key === provider.key) return provider;
    changed = true;
    return { ...provider, key };
  });

  if (changed) {
    await store.updateSettings({ providers });
  }
};

const normalizeProviderKind = (provider) => {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (["anthropic", "claude", "claude-native"].includes(normalized)) return "anthropic";
  if (["google", "google-gemini", "gemini", "gemini-native"].includes(normalized)) {
    return "google-gemini";
  }
  return "openai-compatible";
};

const moduleCapabilities = {
  chat: "text_generation",
  agent: "text_generation",
  memory: "text_generation",
  memory_embedding: "text_embedding",
  user_profile: "text_generation",
  voice_transcription: "audio_transcription",
  voice_speech: "text_to_speech",
  image_generation: "image_generation"
};

const inferModelCapabilities = (model) => {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (/(?:^|[-_/])(?:embedding|embed|bge|e5|gte|nomic|jina|mxbai)(?:[-_/]|$)/.test(normalized)) {
    return ["text_embedding"];
  }
  if (/(^|[-_/])(?:whisper|transcribe|stt)(?:[-_/]|$)/.test(normalized)) {
    return ["audio_transcription"];
  }
  if (/(^|[-_/])(?:tts|speech)(?:[-_/]|$)/.test(normalized)) {
    return ["text_to_speech"];
  }
  if (/(?:dall[\-_.]?e|gpt[\-_.]?image|imagegen|stable[\-_.]?diffusion|(?:^|[-_/])sdxl?(?:[-_/]|$)|flux)/.test(normalized)) {
    return ["image_generation"];
  }
  if (/(?:gpt-4(?:o|\.1|\.5)|gpt-5|o[134](?:-|$)|claude-(?:3|sonnet|opus|haiku)|gemini-(?:1\.5|2|3)|qwen(?:2\.5|-)?vl|llava|pixtral|vision)/.test(normalized)) {
    return ["text_generation", "vision_input"];
  }
  return ["text_generation"];
};

const getModelCapabilities = (model) =>
  Array.isArray(model?.capabilities) ? model.capabilities : inferModelCapabilities(model?.model);

const settingsSupportVisionInput = (settings) => {
  const provider = (settings.providers ?? []).find((entry) => entry.id === settings.activeProviderId);
  const model = provider?.models?.find((entry) => entry.id === settings.activeModelId) ?? { model: settings.model };
  return getModelCapabilities(model).includes("vision_input");
};

const supportsModule = (provider, model, moduleId) => {
  const providerKind = normalizeProviderKind(provider?.provider);
  const isMediaModule = ["voice_transcription", "voice_speech", "image_generation"].includes(moduleId);
  if (isMediaModule && providerKind !== "openai-compatible") {
    return false;
  }
  if (moduleId === "memory_embedding" && providerKind === "anthropic") {
    return false;
  }
  return getModelCapabilities(model).includes(moduleCapabilities[moduleId]);
};

const validateModuleModelPreferences = (providers, preferences, activeProviderId, activeModelId) => {
  if (activeProviderId && activeModelId) {
    const provider = (providers ?? []).find((entry) => entry.id === activeProviderId);
    const model = provider?.models?.find((entry) => entry.id === activeModelId);
    if (!provider || !model) return "The selected chat model no longer exists.";
    if (!supportsModule(provider, model, "chat")) {
      return "The selected model does not support chat.";
    }
  }

  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    return null;
  }

  for (const moduleId of Object.keys(moduleCapabilities)) {
    const preference = preferences[moduleId];
    if (!preference || typeof preference !== "object" || Array.isArray(preference)) continue;
    const provider = (providers ?? []).find((entry) => entry.id === preference.providerId);
    const model = provider?.models?.find((entry) => entry.id === preference.modelId);
    if (!provider || !model) return `The selected ${moduleId} model no longer exists.`;
    if (!supportsModule(provider, model, moduleId)) {
      return `The selected model does not support ${moduleId}.`;
    }
  }

  return null;
};

const validateModelReliabilitySettings = (providers, reliability) => {
  const fallback = reliability?.fallback;
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return null;
  for (const moduleId of Object.keys(moduleCapabilities)) {
    const chain = fallback[moduleId]?.chain;
    if (!Array.isArray(chain)) continue;
    const seen = new Set();
    for (const reference of chain.slice(0, 3)) {
      const key = `${reference?.providerId}\0${reference?.modelId}`;
      if (seen.has(key)) return `The ${moduleId} fallback chain contains a duplicate model.`;
      seen.add(key);
      const provider = providers.find((entry) => entry.id === reference?.providerId);
      const model = provider?.models?.find((entry) => entry.id === reference?.modelId);
      if (!provider || !model) return `The selected ${moduleId} fallback model no longer exists.`;
      if (!supportsModule(provider, model, moduleId)) return `A selected fallback model does not support ${moduleId}.`;
    }
  }
  return null;
};

const resolveModuleSettings = (settings, moduleId) => {
  const preference = settings.moduleModelPreferences?.[moduleId];
  if (!preference) {
    const activeProvider =
      (settings.providers ?? []).find((entry) => entry.id === settings.activeProviderId) ?? {
        provider: settings.activeProvider
      };
    const activeModel =
      (settings.providers ?? [])
        .find((entry) => entry.id === settings.activeProviderId)
        ?.models?.find((entry) => entry.id === settings.activeModelId) ?? { model: settings.model };
    if (!supportsModule(activeProvider, activeModel, moduleId)) {
      throw new Error(
        `No compatible model is configured for ${moduleId}. Choose a model with the required capability in Settings.`
      );
    }
    return settings;
  }
  const provider = (settings.providers ?? []).find((entry) => entry.id === preference.providerId);
  const model = provider?.models?.find((entry) => entry.id === preference.modelId);
  if (!provider || !model) {
    throw new Error(`The configured ${moduleId} model no longer exists.`);
  }
  if (!supportsModule(provider, model, moduleId)) {
    throw new Error(`The configured ${moduleId} model does not support this feature.`);
  }
  return {
    ...settings,
    activeProvider: provider.provider,
    apiBaseUrl: provider.apiBaseUrl,
    apiKey: provider.key?.trim() ? provider.key : settings.apiKey,
    model: model.model,
    activeProviderId: provider.id,
    activeModelId: model.id
  };
};

const resolveModelReferenceSettings = (settings, moduleId, reference) => {
  const provider = (settings.providers ?? []).find((entry) => entry.id === reference.providerId);
  const model = provider?.models?.find((entry) => entry.id === reference.modelId);
  if (!provider || !model) throw new Error(`The configured ${moduleId} fallback model no longer exists.`);
  if (!supportsModule(provider, model, moduleId)) throw new Error(`The configured ${moduleId} fallback model does not support this feature.`);
  return { ...settings, activeProvider: provider.provider, apiBaseUrl: provider.apiBaseUrl, apiKey: provider.key?.trim() ? provider.key : settings.apiKey, model: model.model, activeProviderId: provider.id, activeModelId: model.id };
};

const resolveAutomaticFallbackSettings = (settings, moduleId) => {
  const config = settings.modelReliability?.fallback?.[moduleId];
  if (config?.enabled !== true || (moduleId === "chat" && config.allowAutomatic !== true)) return [];
  const primary = resolveModuleSettings(settings, moduleId);
  const seen = new Set([`${primary.activeProviderId}\0${primary.activeModelId}`]);
  return (Array.isArray(config.chain) ? config.chain : []).slice(0, 3).flatMap((reference) => {
    const key = `${reference?.providerId}\0${reference?.modelId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolveModelReferenceSettings(settings, moduleId, reference)];
  });
};

const mobileModelIdentity = (settings) => {
  const provider = (settings.providers ?? []).find((entry) => entry.id === settings.activeProviderId);
  const model = provider?.models?.find((entry) => entry.id === settings.activeModelId);
  return {
    providerId: provider?.id ?? settings.activeProviderId ?? settings.activeProvider,
    providerType: normalizeProviderKind(provider?.provider ?? settings.activeProvider),
    modelId: model?.model ?? settings.model,
    pricing: model?.pricing?.currency === "USD" ? model.pricing : null
  };
};

const mobileRetryDelay = (attempt, retryAfterMs) => retryAfterMs ?? Math.min(30_000, Math.round(500 * 2 ** Math.max(0, attempt - 1) * (0.75 + Math.random() * 0.5)));
const waitMobileRetry = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
});

const mobileEstimatedCost = (usage, pricing) =>
  usage && pricing
    ? Math.ceil(
        (usage.promptTokens * pricing.inputMicrosPerMillion +
          usage.completionTokens * pricing.outputMicrosPerMillion) /
          1_000_000
      )
    : null;

const mobileBudgetBlockedError = (identity, attemptNumber, diagnosticId) =>
  new ModelCallError({
    code: "budget_blocked",
    retryable: false,
    receivedOutputTokens: false,
    provider: identity.providerType,
    modelId: identity.modelId,
    attempt: attemptNumber,
    summary: "The local hard budget prevented this model call.",
    diagnosticId
  });

const executeMobileReliableOperation = async ({
  rootSettings = store.getSettings(),
  module,
  operation,
  chatId = null,
  messageId = null,
  requestId = `req_${randomUUID()}`,
  overrideHardBudget = false,
  signal,
  estimatedInputTokens = 0,
  maxOutputTokens = 0,
  specialTokensUnknown = false,
  invoke
}) => {
  const claimed = await store.beginModelRequest({
    requestId,
    module,
    operation,
    chatId,
    messageId,
    overrideHardBudget
  });
  if (!claimed.created) {
    throw new ModelCallError({
      code: "invalid_request",
      retryable: false,
      receivedOutputTokens: false,
      provider: rootSettings.activeProvider,
      modelId: rootSettings.model,
      attempt: 0,
      summary: "This model request has already been submitted.",
      diagnosticId: `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}`
    });
  }

  const candidates = [
    resolveModuleSettings(rootSettings, module),
    ...resolveAutomaticFallbackSettings(rootSettings, module)
  ];
  const primaryIdentity = mobileModelIdentity(candidates[0]);
  let attemptNumber = 0;
  let lastError = null;

  for (const [candidateIndex, settings] of candidates.entries()) {
    const identity = mobileModelIdentity(settings);
    const retry = settings.modelReliability?.retry;
    const maxAttempts = retry?.enabled === true
      ? 1 + Math.max(0, Math.min(2, Number(retry.maxRetries) || 0))
      : 1;
    for (let candidateAttempt = 1; candidateAttempt <= maxAttempts; candidateAttempt += 1) {
      attemptNumber += 1;
      const pricing = specialTokensUnknown ? null : identity.pricing;
      const attempt = await store.reserveUsageAttempt({
        settings,
        requestId,
        attemptNumber,
        module,
        chatId,
        messageId,
        providerId: identity.providerId,
        providerType: identity.providerType,
        modelId: identity.modelId,
        promptTokens: estimatedInputTokens,
        maxOutputTokens,
        pricing,
        specialTokensUnknown,
        usedFallback: candidateIndex > 0,
        fallbackFromProviderId: candidateIndex > 0 ? primaryIdentity.providerId : null,
        fallbackFromModelId: candidateIndex > 0 ? primaryIdentity.modelId : null
      });
      if (attempt.status === "blocked") {
        throw mobileBudgetBlockedError(identity, attemptNumber, attempt.diagnosticId);
      }

      try {
        const result = await invoke(settings, signal);
        const usage = result.usage ?? null;
        const estimatedCostMicros = mobileEstimatedCost(usage, pricing);
        const timestamp = new Date().toISOString();
        await store.settleModelAttempt({
          attemptId: attempt.id,
          requestId,
          attemptUpdates: {
            status: "succeeded",
            completedAt: timestamp,
            promptTokens: usage?.promptTokens ?? null,
            outputTokens: usage?.completionTokens ?? null,
            totalTokens: usage?.totalTokens ?? null,
            usageSource: usage ? (usage.estimated ? "estimated" : "provider") : null,
            estimatedCostMicros,
            reservedCostMicros: 0,
            specialTokensUnknown
          },
          requestUpdates: { status: "succeeded", messageId, completedAt: timestamp }
        });
        return {
          ...result,
          requestId,
          attemptId: attempt.id,
          attemptNumber,
          identity,
          usedFallback: candidateIndex > 0,
          pricing,
          estimatedCostMicros,
          specialTokensUnknown
        };
      } catch (caught) {
        const error = normalizeModelError(caught, {
          provider: identity.providerType,
          modelId: identity.modelId,
          attempt: attemptNumber,
          cancelled: signal?.aborted
        });
        const canRetry = error.safe.retryable && candidateAttempt < maxAttempts && !signal?.aborted;
        const canFallback = error.safe.retryable && candidateIndex < candidates.length - 1 && !signal?.aborted;
        const final = !canRetry && !canFallback;
        const timestamp = new Date().toISOString();
        await store.settleModelAttempt({
          attemptId: attempt.id,
          requestId,
          attemptUpdates: {
            status: error.safe.code === "cancelled" ? "cancelled" : "failed",
            completedAt: timestamp,
            reservedCostMicros: 0,
            errorCode: error.safe.code,
            diagnosticId: error.safe.diagnosticId,
            specialTokensUnknown
          },
          requestUpdates: final
            ? {
                status: error.safe.code === "cancelled" ? "cancelled" : "failed",
                completedAt: timestamp,
                errorCode: error.safe.code,
                errorSummary: error.safe.summary,
                diagnosticId: error.safe.diagnosticId
              }
            : { status: "queued", activeAttemptId: null }
        });
        lastError = error;
        if (canRetry) {
          try {
            await waitMobileRetry(mobileRetryDelay(candidateAttempt, error.safe.retryAfterMs), signal);
          } catch (waitError) {
            const cancelled = normalizeModelError(waitError, {
              provider: identity.providerType,
              modelId: identity.modelId,
              attempt: attemptNumber,
              cancelled: signal?.aborted
            });
            await store.updateModelRequest(requestId, {
              status: "cancelled",
              activeAttemptId: null,
              completedAt: new Date().toISOString(),
              errorCode: cancelled.safe.code,
              errorSummary: cancelled.safe.summary,
              diagnosticId: cancelled.safe.diagnosticId
            });
            throw cancelled;
          }
          continue;
        }
        if (canFallback) break;
        throw error;
      }
    }
  }
  throw lastError ?? new Error("Model request failed");
};

const executeMobileReliableText = async ({
  rootSettings = store.getSettings(), module, operation, messages, chatId = null,
  messageId = null, requestId, overrideHardBudget, signal, maxTokens, temperature
}) => executeMobileReliableOperation({
  rootSettings,
  module,
  operation,
  chatId,
  messageId,
  requestId,
  overrideHardBudget,
  signal,
  estimatedInputTokens: messages.reduce((total, message) => total + estimatePromptTokens(message.content), 0),
  maxOutputTokens: maxTokens ?? resolveModuleSettings(rootSettings, module).maxTokens,
  invoke: async (settings, attemptSignal) => ({
    ...(await completeChatCompletionDetailed({ settings, messages, signal: attemptSignal, maxTokens, temperature }))
  })
});

const executeMobileReliableEmbeddings = async ({ rootSettings = store.getSettings(), inputs, task, chatId = null }) => {
  const promptTokens = inputs.reduce((total, input) => total + estimatePromptTokens(input), 0);
  return executeMobileReliableOperation({
    rootSettings,
    module: "memory_embedding",
    operation: task === "query" ? "memory_embedding_query" : "memory_embedding_index",
    chatId,
    estimatedInputTokens: promptTokens,
    maxOutputTokens: 0,
    specialTokensUnknown: true,
    invoke: async (settings) => ({
      value: await generateEmbeddings({ settings, inputs, task }),
      usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens, estimated: true }
    })
  });
};

const joinApiPath = (baseUrl, requestPath) =>
  `${baseUrl.replace(/\/+$/, "")}/${requestPath.replace(/^\/+/, "")}`;

const openAiHeaders = (settings, contentType = "application/json") => {
  const apiKey = decryptApiKey(settings.apiKey);
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };
};

const assertOpenAiCompatible = (settings, feature) => {
  if (normalizeProviderKind(settings.activeProvider) !== "openai-compatible") {
    throw new Error(`${feature} currently requires an OpenAI-compatible provider.`);
  }
};

const readModelError = async (response) => {
  const text = await response.text();
  if (!text) return `Model API request failed with status ${response.status}`;
  try {
    const parsed = JSON.parse(text);
    return parsed.error?.message ?? parsed.message ?? parsed.error ?? text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
};

const mobileProviderSignal = (signal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);

const transcribeAudio = async ({ settings, audioBase64, mimeType, filename, signal }) => {
  assertOpenAiCompatible(settings, "Voice transcription");
  const form = new FormData();
  form.set("model", settings.model);
  form.set(
    "file",
    new Blob([Buffer.from(audioBase64, "base64")], { type: mimeType }),
    filename || "recording.webm"
  );
  const response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: openAiHeaders(settings, ""),
    body: form,
    signal: mobileProviderSignal(signal)
  });
  if (!response.ok) throw new Error(await readModelError(response));
  const payload = await response.json();
  return { text: String(payload.text ?? "").trim(), model: settings.model, createdAt: new Date().toISOString() };
};

const createSpeechAudio = async ({ settings, text, voice, format, signal }) => {
  assertOpenAiCompatible(settings, "Text to speech");
  const response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/speech"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({ model: settings.model, input: text, voice, response_format: format }),
    signal: mobileProviderSignal(signal)
  });
  if (!response.ok) throw new Error(await readModelError(response));
  return {
    audioBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
    mimeType: response.headers.get("content-type") || `audio/${format}`,
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};

const generateImage = async ({ settings, prompt, size, signal }) => {
  assertOpenAiCompatible(settings, "Image generation");
  const response = await fetch(joinApiPath(settings.apiBaseUrl, "images/generations"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({ model: settings.model, prompt, n: 1, size, response_format: "b64_json" }),
    signal: mobileProviderSignal(signal)
  });
  if (!response.ok) throw new Error(await readModelError(response));
  const payload = await response.json();
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

const getLanHosts = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index);

const normalizePeerBaseUrl = (raw) => {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw httpError(400, "Peer address must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Peer address must use http or https.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
};

const requestPeer = async (peerBaseUrl, pathName, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${peerBaseUrl}${pathName}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw httpError(response.ok ? 502 : response.status, payload?.error ?? response.statusText ?? "Peer request failed");
    }
    return payload.data;
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    if (error?.name === "AbortError") throw httpError(504, "Peer request timed out.");
    throw httpError(502, error instanceof Error ? `Peer request failed: ${error.message}` : "Peer request failed");
  } finally {
    clearTimeout(timeout);
  }
};

const getPromptContext = async ({ chatId, before, excludeMessageIds = [] }) => {
  const chat = getActiveChat(chatId);
  if (!chat) {
    throw notFound("Chat not found");
  }

  const character = chat.characterId ? store.getCharacter(chat.characterId) : null;
  const recentMessages = store
    .listMessages(chatId)
    .filter((message) => !before || new Date(message.createdAt) < before)
    .filter((message) => message.contextIncluded !== false)
    .filter((message) => !excludeMessageIds.includes(message.id))
    .slice(-(Math.max(1, Math.min(chat.memoryTurns ?? 12, 50)) * 2 + 1));

  const messages = [];
  const characterPromptFields = character ? resolveCharacterPromptFields(character) : null;
  const matchedLoreEntries = findMatchedLoreEntries(character, characterPromptFields, recentMessages);
  const latestMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null;
  const matchedMemoryEntries = await recallChatMemories({
    chatId,
    query: latestMessage?.content ?? "",
    recentMessages,
    settings: resolveModuleSettings(store.getSettings(), "memory")
  });
  const characterPrompt = buildCharacterSystemPrompt(characterPromptFields);
  const characterPromptWithLore = buildCharacterSystemPrompt(
    characterPromptFields,
    matchedLoreEntries
  );
  const userConfigSegments = getUserCustomConfigSegments(chat.userPersona);
  const userProfileSummary = chat.userProfileSummary?.trim() ?? "";
  const memoryPrompt = formatMemorySystemPrompt(matchedMemoryEntries);

  if (characterPromptWithLore) {
    messages.push({ role: "system", content: characterPromptWithLore });
  }
  for (const segment of userConfigSegments) {
    messages.push({ role: "system", content: segment });
  }
  if (userProfileSummary) {
    messages.push({ role: "system", content: `User profile:\n${userProfileSummary}` });
  }
  if (memoryPrompt) {
    messages.push({ role: "system", content: memoryPrompt });
  }
  const historyMessages = [];
  for (const message of recentMessages) {
    if (message.role === "system") continue;
    const historyMessage = {
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      ...(store.listMessageAttachments(message.id).length ? { images: store.listMessageAttachments(message.id).map((attachment) => {
        const asset = store.getMediaAsset(attachment.assetId);
        if (!asset) throw new Error("A referenced image asset is missing.");
        return { mimeType: asset.mimeType, dataBase64: asset.dataBase64 };
      }) } : {})
    };
    historyMessages.push(historyMessage);
    messages.push(historyMessage);
  }

  return {
    chat,
    messages,
    matchedLoreEntries,
    matchedMemoryEntries,
    promptBreakdown: buildPromptBreakdown({
      messages,
      characterPrompt,
      userConfigSegments,
      userProfileSummary,
      matchedLoreEntries,
      memoryPrompt,
      memoryEntryCount: matchedMemoryEntries.length,
      historyMessages
    })
  };
};

const agentModeConfig = {
  scene_summary: {
    title: "Scene Summary",
    instruction: [
      "Summarize the current single-character roleplay scene for the user.",
      "Cover the current situation, relationship state, emotional tone, and unresolved threads.",
      "Keep it concise and practical."
    ].join("\n")
  },
  next_steps: {
    title: "Next Step Suggestions",
    instruction: [
      "Suggest 3 to 5 possible next actions the user can take in this single-character chat.",
      "Each suggestion should be concrete, in-character for the current scene, and easy to send or adapt.",
      "Do not continue the assistant character's reply for the user."
    ].join("\n")
  },
  reply_drafts: {
    title: "Reply Drafts",
    instruction: [
      "Write 2 to 3 alternative user reply drafts for the current single-character chat.",
      "Make each draft ready to paste into the user's message box.",
      "Keep the drafts distinct in tone or strategy.",
      "Wrap every sendable draft exactly in [DRAFT] and [/DRAFT] markers."
    ].join("\n")
  },
  memory_lore_candidates: {
    title: "Memory and Lore Candidates",
    instruction: [
      "Identify candidate notes that the user may later save manually.",
      "Separate durable chat memory candidates from character embedded lore candidates.",
      "Do not claim anything was saved. Do not propose standalone lorebook or worldbook structures.",
      "For a memory candidate, use [MEMORY title | content | comma-separated keywords].",
      "For a character lore candidate, use [LORE comma-separated keys | content]."
    ].join("\n")
  },
  continuity_check: {
    title: "Continuity Check",
    instruction: "Check the current single-character scene for contradictions, unresolved facts, timeline ambiguity, and missing context. Separate confirmed facts from possible inconsistencies."
  },
  character_consistency: {
    title: "Character Consistency",
    instruction: "Assess whether the recent character replies remain consistent with the provided character card, relationship state, and matched lore. Identify only concrete risks and offer a concise repair direction."
  }
};

const splitAgentKeywords = (value) => value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 12);

const extractAgentActions = (mode, content) => {
  if (mode === "reply_drafts") {
    return [...content.matchAll(/\[DRAFT\]([\s\S]*?)\[\/DRAFT\]/gi)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((item, index) => ({ id: randomUUID(), kind: "reply_draft", title: `Draft ${index + 1}`, content: item }));
  }
  if (mode !== "memory_lore_candidates") return [];
  const actions = [];
  for (const match of content.matchAll(/\[(MEMORY|LORE)\s+([^\]]+)\]/gi)) {
    const fields = match[2].split("|").map((item) => item.trim());
    if (match[1].toUpperCase() === "MEMORY" && fields.length >= 2) {
      actions.push({ id: randomUUID(), kind: "memory_candidate", title: fields[0] || "Memory", content: fields[1], keywords: splitAgentKeywords(fields[2] ?? "") });
    }
    if (match[1].toUpperCase() === "LORE" && fields.length >= 2) {
      actions.push({ id: randomUUID(), kind: "lore_candidate", title: fields[0] || "Lore", content: fields[1], keywords: splitAgentKeywords(fields[0]) });
    }
  }
  return actions.slice(0, 8);
};

const buildAgentDraftMessages = (baseMessages, mode, focus) => [
  {
    role: "system",
    content: [
      "/no_think",
      "You are a read-only context assistant inside a local-first single-user, single-character roleplay chat app.",
      "You may inspect the provided chat context and produce a draft for the user.",
      "Do not modify data, claim that data was changed, create background tasks, introduce group chat, or introduce standalone lorebook/worldbook features.",
      "Return Markdown only.",
      agentModeConfig[mode].instruction,
      focus?.trim() ? `User focus:\n${focus.trim()}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  },
  ...baseMessages,
  {
    role: "user",
    content: "Create the requested agent draft from the context above."
  }
];

const createAgentDraft = async ({ chatId, mode, focus }) => {
  if (!getActiveChat(chatId)) {
    throw notFound("Chat not found");
  }

  const rootSettings = store.getSettings();
  const context = await getPromptContext({ chatId });
  const content = (
    await executeMobileReliableText({
      rootSettings,
      module: "agent",
      operation: "agent_draft",
      chatId,
      messages: buildAgentDraftMessages(context.messages, mode, focus),
      maxTokens: Math.min(resolveModuleSettings(rootSettings, "agent").maxTokens, 900),
      temperature: Math.min(resolveModuleSettings(rootSettings, "agent").temperature, 0.4)
    })
  ).content.trim();

  if (!content) {
    throw new Error("Agent returned an empty draft.");
  }

  return {
    mode,
    title: agentModeConfig[mode].title,
    content,
    createdAt: new Date().toISOString(),
    actions: extractAgentActions(mode, content),
    matchedLoreEntries: context.matchedLoreEntries,
    matchedMemoryEntries: context.matchedMemoryEntries,
    sourceMessageIds: store.listMessages(chatId).filter((message) => message.contextIncluded !== false).slice(-20).map((message) => message.id)
  };
};

const MAX_TITLE_LENGTH = 80;
const MAX_TITLE_CONTEXT_MESSAGES = 16;

const normalizeTitleSuggestion = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();

const buildTitleSuggestionMessages = (messages) => [
  {
    role: "system",
    content: [
      "/no_think",
      "Generate a concise title for this local-first single-character roleplay chat.",
      "Use the conversation only. Do not introduce group chat, standalone lorebooks, or worldbooks.",
      "Return only the title, with no quotes, markdown, punctuation-only output, or explanation.",
      `Keep it under ${MAX_TITLE_LENGTH} characters.`
    ].join("\n")
  },
  ...messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_TITLE_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }))
];

const createTitleSuggestion = async (chatId) => {
  if (!getActiveChat(chatId)) {
    throw notFound("Chat not found");
  }

  const messages = store
    .listMessages(chatId)
    .filter((message) => message.contextIncluded !== false);
  if (!messages.length) {
    throw httpError(400, "A chat needs at least one included message before generating a title");
  }

  const rootSettings = store.getSettings();
  const settings = resolveModuleSettings(rootSettings, "chat");
  const title = normalizeTitleSuggestion(
    (await executeMobileReliableText({
      rootSettings,
      module: "chat",
      operation: "chat_title",
      chatId,
      messages: buildTitleSuggestionMessages(messages),
      maxTokens: Math.min(settings.maxTokens, 80),
      temperature: Math.min(settings.temperature, 0.25)
    })).content
  );
  if (!title) throw new Error("Model returned an empty title suggestion");

  return { title, createdAt: new Date().toISOString() };
};

const createAutoTitle = async (chatId) => {
  const current = getActiveChat(chatId);
  if (!current) throw notFound("Chat not found");
  if (current.title !== "New Chat") return null;

  const suggestion = await createTitleSuggestion(chatId);
  const latest = store.getChat(chatId);
  if (!latest || latest.deletedAt || latest.title !== "New Chat") return null;
  return store.updateChat(chatId, { title: suggestion.title });
};

const openingInstruction = {
  role: "user",
  content: [
    "/no_think",
    "Write the first in-character assistant message for this empty single-character roleplay chat.",
    "Start the scene naturally and give the user something concrete to respond to.",
    "Do not speak as the user. Do not introduce group chat, standalone lorebooks, or out-of-character setup instructions.",
    "Return only the message content."
  ].join("\n")
};

const createOpeningMessage = async (chatId) => {
  const chat = getActiveChat(chatId);
  if (!chat) {
    throw notFound("Chat not found");
  }
  if (!chat.characterId) {
    throw httpError(400, "Chat must be bound to a character before generating an opening message");
  }
  if (store.listMessages(chatId).length > 0) {
    throw httpError(409, "Opening message can only be generated for an empty chat");
  }

  const rootSettings = store.getSettings();
  const settings = resolveModuleSettings(rootSettings, "chat");
  const context = await getPromptContext({ chatId });
  const messages = [...context.messages, openingInstruction];
  const content = (
    await executeMobileReliableText({
      rootSettings,
      module: "chat",
      operation: "chat_opening",
      chatId,
      messages,
      maxTokens: Math.min(settings.maxTokens, 700),
      temperature: Math.min(settings.temperature, 0.7)
    })
  ).content.trim();

  if (!content) {
    throw new Error("Model returned an empty opening message");
  }

  const tokenUsage = estimateTokenUsage(messages, content);
  const promptBreakdown = finalizePromptBreakdown(
    appendPromptBreakdownInstruction(context.promptBreakdown, openingInstruction.content),
    tokenUsage.promptTokens,
    tokenUsage.estimated
  );

  const message = await store.createMessage({
    chatId,
    role: "assistant",
    characterId: chat.characterId,
    content,
    variants: [content],
    activeVariantIndex: 0,
    tokenUsage,
    promptBreakdown,
    loreMatches: context.matchedLoreEntries,
    memoryMatches: context.matchedMemoryEntries
  });

  return serializeMessage(message);
};

const exportChatArchive = (chatId) => {
  const chat = getActiveChat(chatId);
  if (!chat) throw notFound("Chat not found");
  const character = chat.characterId ? store.getCharacter(chat.characterId) : null;
  const messages = store.listMessages(chatId);
  const attachments = messages.flatMap((message) => store.listMessageAttachments(message.id)).sort((a, b) => `${a.messageId}:${a.sortOrder}`.localeCompare(`${b.messageId}:${b.sortOrder}`)).map((attachment) => ({ id: attachment.id, messageId: attachment.messageId, assetId: attachment.assetId, sortOrder: attachment.sortOrder, originalFilename: attachment.originalFilename ?? null, createdAt: attachment.createdAt }));
  const assetIds = new Set(attachments.map((attachment) => attachment.assetId));
  const assets = store.readRecords("mediaAsset").filter((asset) => assetIds.has(asset.id)).sort((a, b) => a.id.localeCompare(b.id)).map((asset) => ({ id: asset.id, contentHash: asset.contentHash, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height, dataBase64: asset.dataBase64, createdAt: asset.createdAt }));
  const manifestHash = createHash("sha256").update(JSON.stringify({ assets: assets.map(({ dataBase64: _data, ...asset }) => asset), attachments })).digest("hex");
  return {
    archiveVersion: 1,
    exportedAt: new Date().toISOString(),
    chat: serializeChat(chat, store.listMessages(chatId).length),
    character,
    messages: messages.map(serializeMessage),
    memories: store.listMemories(chatId).map(serializeMemory),
    memoryRevisions: store.listRawMemoryRevisions(chatId),
    memoryOperations: store.listRawMemoryOperations(chatId),
    profileSummaryRevisions: store.listRawProfileSummaryRevisions(chatId),
    ...(assets.length ? { media: { version: 1, manifestHash, assets, attachments } } : {})
  };
};

const importChatArchive = async ({ archive, title }) => {
  if (archive.media) {
    const messageIds = new Set(archive.messages.flatMap((message) => message.id ? [message.id] : []));
    const assetIds = new Set();
    const hashes = new Set();
    for (const asset of archive.media.assets) {
      const bytes = Buffer.from(asset.dataBase64, "base64");
      try { validateStoredImage({ data: bytes, mimeType: asset.mimeType, width: asset.width, height: asset.height }); }
      catch { throw Object.assign(new Error("The chat archive contains damaged or mismatched image data."), { status: 400 }); }
      if (bytes.length !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.contentHash || assetIds.has(asset.id) || hashes.has(asset.contentHash)) throw Object.assign(new Error("The chat archive contains damaged or duplicate image data."), { status: 400 });
      assetIds.add(asset.id);
      hashes.add(asset.contentHash);
    }
    const attachmentIds = new Set();
    const orderKeys = new Set();
    for (const attachment of archive.media.attachments) {
      const orderKey = `${attachment.messageId}:${attachment.sortOrder}`;
      if (!messageIds.has(attachment.messageId) || !assetIds.has(attachment.assetId) || attachmentIds.has(attachment.id) || orderKeys.has(orderKey)) throw Object.assign(new Error("The chat archive contains an invalid image attachment reference."), { status: 400 });
      attachmentIds.add(attachment.id);
      orderKeys.add(orderKey);
    }
    const expected = createHash("sha256").update(JSON.stringify({ assets: archive.media.assets.map(({ dataBase64: _data, ...asset }) => asset), attachments: archive.media.attachments })).digest("hex");
    if (expected !== archive.media.manifestHash) throw Object.assign(new Error("The chat archive image manifest failed integrity validation."), { status: 400 });
  }
  return store.atomicWrite(async () => {
  const importedAt = () => new Date().toISOString();
  let characterId = null;
  if (archive.character) {
    const existing = store.listCharacters().find((character) => character.cardId === archive.character.cardId);
    if (existing) {
      characterId = existing.id;
    } else {
      characterId = (await store.createCharacter(archive.character, false)).id;
    }
  }
  const chat = await store.createChat({
    title: title ?? archive.chat.title,
    characterId,
    isCheckpoint: archive.chat.isCheckpoint === true,
    folder: archive.chat.folder,
    backgroundUrl: archive.chat.backgroundUrl,
    memoryTurns: archive.chat.memoryTurns,
    autoMemoryEnabled: archive.chat.autoMemoryEnabled,
    userPersona: archive.chat.userPersona,
    userAvatar: archive.chat.userAvatar ?? "",
    userProfileSummary: archive.chat.userProfileSummary,
    profileRevision: archive.profileSummaryRevisions.length
      ? archive.chat.profileRevision
      : archive.chat.userProfileSummary ? 1 : 0
  }, false);
  const messageIds = new Map();
  for (const source of archive.messages) {
    const { id: sourceId, ...messageInput } = source;
    const message = await store.createMessage({
      ...messageInput,
      chatId: chat.id,
      characterId: source.characterId ? characterId : null
    }, false);
    if (sourceId) messageIds.set(sourceId, message.id);
  }
  if (archive.media) {
    const importedAssetIds = new Map();
    for (const asset of archive.media.assets) {
      const existing = store.readRecords("mediaAsset").find((item) => item.contentHash === asset.contentHash);
      const stored = existing ?? { ...asset, id: randomUUID(), storageKey: `sha256:${asset.contentHash}` };
      if (!existing) await store.writeRecord("mediaAsset", stored);
      importedAssetIds.set(asset.id, stored.id);
    }
    for (const attachment of archive.media.attachments) {
      const messageId = messageIds.get(attachment.messageId);
      const assetId = importedAssetIds.get(attachment.assetId);
      if (!messageId || !assetId) throw Object.assign(new Error("The chat archive contains an unavailable image reference."), { status: 400 });
      await store.writeRecord("messageAttachment", { ...attachment, id: randomUUID(), messageId, assetId, draftId: null });
    }
  }
  const memoryIds = new Map();
  const operationIds = new Map();
    for (const source of archive.memoryOperations) {
      const id = randomUUID();
      operationIds.set(source.id, id);
      await store.writeRecord("memoryOperation", {
        ...source,
        id,
        chatId: chat.id,
        sourceMessageIds: (source.sourceMessageIds ?? []).map((sourceId) => messageIds.get(sourceId)).filter(Boolean),
        undoOperationId: null,
        createdAt: source.startedAt,
        updatedAt: importedAt()
      });
    }
    for (const source of archive.memoryOperations) {
      if (!source.undoOperationId) continue;
      const id = operationIds.get(source.id);
      const undoOperationId = operationIds.get(source.undoOperationId);
      if (!id || !undoOperationId) continue;
      const operation = store.readRecord("memoryOperation", id);
      if (operation) await store.writeRecord("memoryOperation", { ...operation, undoOperationId });
    }
    for (const source of archive.memories) {
      const id = randomUUID();
      memoryIds.set(source.id, id);
      const mappedSources = (source.sourceMessageIds ?? []).map((sourceId) => messageIds.get(sourceId)).filter(Boolean);
      await store.writeRecord("memory", {
        ...source,
        id,
        chatId: chat.id,
        sourceMessageIds: mappedSources,
        embedding: null,
        embeddingModel: null,
        embeddingSource: null,
        embeddingDimensions: null,
        embeddingStatus: "stale",
        embeddingUpdatedAt: null,
        updatedAt: importedAt()
      });
    }
    for (const source of archive.memoryRevisions) {
      const memoryId = memoryIds.get(source.memoryId);
      if (!memoryId) continue;
      const mapSnapshot = (snapshot) => snapshot ? {
        ...snapshot,
        sourceMessageIds: (snapshot.sourceMessageIds ?? []).map((sourceId) => messageIds.get(sourceId)).filter(Boolean)
      } : null;
      await store.writeRecord("memoryRevision", {
        ...source,
        id: randomUUID(),
        memoryId,
        chatId: chat.id,
        beforeSnapshot: mapSnapshot(source.beforeSnapshot),
        afterSnapshot: mapSnapshot(source.afterSnapshot),
        sourceMessageIds: (source.sourceMessageIds ?? []).map((sourceId) => messageIds.get(sourceId)).filter(Boolean),
        operationId: source.operationId ? operationIds.get(source.operationId) ?? null : null,
        updatedAt: importedAt()
      });
    }
    for (const source of archive.profileSummaryRevisions) {
      await store.writeRecord("profileSummaryRevision", {
        ...source,
        id: randomUUID(),
        chatId: chat.id,
        sourceMessageIds: (source.sourceMessageIds ?? []).map((sourceId) => messageIds.get(sourceId)).filter(Boolean),
        updatedAt: importedAt()
      });
    }
    for (const source of archive.memories) {
      if (archive.memoryRevisions.some((revision) => revision.memoryId === source.id)) continue;
      const memoryId = memoryIds.get(source.id);
      const memory = memoryId ? store.getMemory(chat.id, memoryId) : null;
      if (!memory) continue;
      const baseline = { ...memory, currentRevision: 1, lastActor: "restore", lastAction: "baseline" };
      await store.writeRecord("memory", baseline);
      await store.writeRecord("memoryRevision", {
        id: randomUUID(), memoryId: memory.id, chatId: chat.id, revision: 1,
        action: "baseline", actor: "restore",
        beforeSnapshot: memory.deletedAt ? store.memorySnapshot(baseline) : null,
        afterSnapshot: memory.deletedAt ? null : store.memorySnapshot(baseline),
        sourceMessageIds: baseline.sourceMessageIds ?? [], operationId: null,
        reasonCode: "legacy_archive_baseline", createdAt: baseline.createdAt ?? importedAt(), updatedAt: importedAt()
      });
    }
  const importedChat = store.getChat(chat.id);
  return {
    ...serializeChat(importedChat, store.listMessages(chat.id).length),
    messages: store.listMessages(chat.id).map(serializeMessage),
    memories: store.listMemories(chat.id).map(serializeMemory)
  };
  });
};

const app = express();
let privacyPasscodeDigest = null;
let closeMobileSocketsForPrivacy = () => undefined;
const privacyDigest = (passcode) => createHash("sha256").update(passcode, "utf8").digest();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));

app.get("/api/privacy/status", (_request, response) => response.json({ ok: true, data: { locked: privacyPasscodeDigest !== null } }));
app.post("/api/privacy/lock", (request, response) => {
  const passcode = typeof request.body?.passcode === "string" ? request.body.passcode : "";
  if (passcode.length < 4 || passcode.length > 128) return response.status(400).json({ ok: false, error: "Unlock code must contain 4 to 128 characters." });
  privacyPasscodeDigest = privacyDigest(passcode);
  closeMobileSocketsForPrivacy();
  response.json({ ok: true, data: { locked: true } });
});
app.post("/api/privacy/unlock", (request, response) => {
  const passcode = typeof request.body?.passcode === "string" ? request.body.passcode : "";
  if (privacyPasscodeDigest && !timingSafeEqual(privacyPasscodeDigest, privacyDigest(passcode))) return response.status(401).json({ ok: false, error: "Incorrect unlock code." });
  privacyPasscodeDigest = null;
  response.json({ ok: true, data: { locked: false } });
});
app.use("/api", (_request, response, next) => {
  if (privacyPasscodeDigest) return response.status(423).json({ ok: false, error: "App is locked." });
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    app: APP_NAME,
    database: "sqlite",
    timestamp: new Date().toISOString()
  });
});

const getMobileAppInfo = () => {
  const info = getAppInfo();
  if (store.migrationReport?.schemaVersion) info.schemaVersion = store.migrationReport.schemaVersion;
  if (store.migrationReport?.schemaChecksum) info.schemaChecksum = store.migrationReport.schemaChecksum;
  return info;
};

app.get("/api/app/info", (_request, response) => {
  response.json({ ok: true, data: getMobileAppInfo() });
});

app.get("/api/characters", (_request, response) => {
  response.json({ ok: true, data: store.listCharacters().map(serializeCharacter) });
});

app.get(
  "/api/characters/page",
  asyncHandler(async (request, response) => {
    const query = parseQuery(characterPageQuerySchema, request.query);
    const normalizedQ = query.q.toLowerCase();
    const normalizedTag = query.tag.toLowerCase();
    const searched = store
      .listCharacters()
      .filter((character) => (query.favoriteOnly ? character.isFavorite === true : true))
      .filter((character) =>
        normalizedQ
          ? [character.name, character.description]
              .join("\n")
              .toLowerCase()
              .includes(normalizedQ)
          : true
      );
    const availableTags = [
      ...new Set(
        searched
          .flatMap((character) => toStringArray(character.tags))
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));
    const filtered = searched
      .filter((character) =>
        normalizedTag ? toStringArray(character.tags).some((tag) => tag.toLowerCase() === normalizedTag) : true
      );
    const all = sortCharactersForPage(filtered, store.listChats(), query.sort);
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const start = (page - 1) * query.pageSize;
    response.json({
      ok: true,
      data: {
        items: all.slice(start, start + query.pageSize).map(serializeCharacter),
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
        availableTags
      }
    });
  })
);

app.post(
  "/api/characters",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterCreateSchema, request.body);
    const character = await store.createCharacter(body);
    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

app.post(
  "/api/characters/draft",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterDraftSchema, request.body);
    if (body.characterId) {
      const character = store.getCharacter(body.characterId);
      if (!character) throw notFound("Character not found");
      if (serializeCharacter(character).visibility === "private") {
        if (!body.accessPassword) {
          const error = new Error("Private character password is required for AI drafting");
          error.status = 403;
          throw error;
        }
        assertCharacterUnlockPassword(character, body.accessPassword);
      }
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    const agentSettings = resolveModuleSettings(store.getSettings(), "agent");
    const result = await executeMobileReliableText({
      module: "agent",
      operation: `character_${body.task}`,
      requestId: body.requestId,
      messages: buildCharacterDraftMessages(body),
      signal: controller.signal,
      maxTokens: Math.min(agentSettings.maxTokens, 1200),
      temperature: Math.min(agentSettings.temperature, 0.5)
    });
    const meta = getCharacterDraftMeta(body.task);
    response.json({ ok: true, data: { requestId: body.requestId, task: body.task, title: meta.title, notice: "AI-generated draft. Review it for accuracy before applying or saving.", sentFieldCategories: meta.sentFieldCategories, items: parseCharacterDraftItems(result.content), createdAt: new Date().toISOString() } });
  })
);

app.post(
  "/api/characters/import",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterImportSchema, request.body);
    const character = await store.upsertCharacterByCardId(importCharacterCard(body));
    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

app.post(
  "/api/characters/:id/duplicate",
  asyncHandler(async (request, response) => {
    const source = store.getCharacter(requireParam(request, "id"));
    if (!source) throw notFound("Character not found");
    const body = parseBody(characterDuplicateSchema, request.body);
    const character = await store.createCharacter({
      name: body.name,
      avatar: source.avatar,
      description: source.description,
      tags: source.tags,
      prefix: source.prefix,
      prompt: source.prompt,
      suffix: source.suffix,
      htmlCss: source.htmlCss,
      openingHtml: source.openingHtml,
      loreEntries: source.loreEntries,
      quickReplies: source.quickReplies,
      isFavorite: false
    });
    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

app.post(
  "/api/characters/:id/export",
  asyncHandler(async (request, response) => {
    const character = store.getCharacter(requireParam(request, "id"));
    if (!character) throw notFound("Character not found");
    const body = parseBody(characterExportSchema, request.body);
    if (body.visibility === "public" && !canExportCharacterPublicly(character, body.password)) {
      const error = new Error("Private character password is required to export this character publicly");
      error.status = 403;
      throw error;
    }
    response.json({ ok: true, data: createCharacterExportCard(character, body.visibility, body.password) });
  })
);

app.post(
  "/api/characters/:id/unlock",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterUnlockSchema, request.body);
    const character = store.getCharacter(requireParam(request, "id"));
    if (!character) throw notFound("Character not found");
    assertCharacterUnlockPassword(character, body.password);

    if (isImportedPrivateCharacter(character)) {
      const reEncrypted = reEncryptImportedCharacter(character, body.password);
      const updated = await store.updateCharacter(character.id, { loreEntries: reEncrypted });
      response.json({ ok: true, data: serializeCharacter(updated, body.password) });
      return;
    }

    response.json({ ok: true, data: serializeCharacter(character, body.password) });
  })
);

app.get("/api/characters/:id", (request, response) => {
  const character = store.getCharacter(requireParam(request, "id"));
  if (!character) throw notFound("Character not found");
  response.json({ ok: true, data: serializeCharacter(character) });
});

app.put(
  "/api/characters/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterUpdateRequestSchema, request.body);
    const id = requireParam(request, "id");
    const existing = store.getCharacter(id);
    if (!existing) throw notFound("Character not found");

    const { accessPassword, ...updates } = body;
    const character = await store.updateCharacter(
      id,
      dropUndefined(buildCharacterUpdateData(existing, updates, accessPassword))
    );
    response.json({ ok: true, data: serializeCharacter(character, accessPassword) });
  })
);

app.delete(
  "/api/characters/:id",
  asyncHandler(async (request, response) => {
    const deleted = await store.deleteCharacter(requireParam(request, "id"));
    if (!deleted) throw notFound("Character not found");
    response.status(204).send();
  })
);

app.post(
  "/api/characters/batch-delete",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterBatchDeleteSchema, request.body);
    let deleted = 0;
    for (const id of body.ids) {
      if (await store.deleteCharacter(id)) deleted += 1;
    }
    response.json({ ok: true, data: { deleted } });
  })
);

app.post(
  "/api/characters/batch-tags",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterBatchTagsSchema, request.body);
    let updated;
    try {
      updated = await store.batchUpdateCharacterTags(
        body.ids,
        body.operation,
        body.tags,
        applyCharacterTagOperation
      );
    } catch (error) {
      if (error instanceof RangeError) error.status = 400;
      throw error;
    }
    if (updated === null) throw notFound("One or more characters were not found");
    response.json({ ok: true, data: { updated } });
  })
);

app.post("/api/characters/batch-fetch", (request, response) => {
  const body = parseBody(characterBatchFetchSchema, request.body);
  response.json({
    ok: true,
    data: body.ids.map((id) => store.getCharacter(id)).filter(Boolean).map(serializeCharacter)
  });
});

app.get("/api/chats", (_request, response) => {
  response.json({
    ok: true,
    data: store.listChats().map((chat) => serializeChat(chat, chat.messageCount, false))
  });
});

app.post(
  "/api/chats",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatCreateSchema, request.body);
    if (body.characterId && !store.getCharacter(body.characterId)) throw notFound("Character not found");
    const chat = await store.createChat(body);
    response.status(201).json({ ok: true, data: serializeChat(chat) });
  })
);

app.post(
  "/api/chats/:id/agent-draft",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatAgentDraftSchema, request.body);
    response.json({ ok: true, data: await createAgentDraft({ chatId, ...body }) });
  })
);

app.get("/api/chats/:id/archive", (request, response) => {
  response.json({ ok: true, data: exportChatArchive(requireParam(request, "id")) });
});

app.post(
  "/api/chats/import-archive",
  asyncHandler(async (request, response) => {
    response.status(201).json({ ok: true, data: await importChatArchive(parseBody(chatArchiveImportSchema, request.body)) });
  })
);

app.post(
  "/api/chats/:id/title-suggestion",
  asyncHandler(async (request, response) => {
    response.json({ ok: true, data: await createTitleSuggestion(requireParam(request, "id")) });
  })
);

app.post(
  "/api/chats/:id/auto-title",
  asyncHandler(async (request, response) => {
    const chat = await createAutoTitle(requireParam(request, "id"));
    response.json({ ok: true, data: chat ? serializeChat(chat) : null });
  })
);

app.post(
  "/api/chats/:id/opening-message",
  asyncHandler(async (request, response) => {
    response.status(201).json({ ok: true, data: await createOpeningMessage(requireParam(request, "id")) });
  })
);

app.get("/api/chats/:id/memories", (request, response) => {
  const chatId = requireParam(request, "id");
  if (!getActiveChat(chatId)) throw notFound("Chat not found");
  response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
});

app.post(
  "/api/chats/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const body = parseBody(chatMemoryCreateSchema, request.body);
    const { actor, ...memoryInput } = body;
    const created = await store.createAuditedMemory({ ...memoryInput, chatId }, { actor, action: actor === "agent_confirmed" ? "agent_confirmed_create" : "manual_create", reasonCode: actor === "agent_confirmed" ? "agent_candidate_confirmed" : "user_created" });
    const createdMemory = created.memory;
    await ensureMemoryEmbeddings([createdMemory], store.getSettings());
    response.status(201).json({
      ok: true,
      data: serializeMemory(store.getMemory(chatId, createdMemory.id))
    });
  })
);

app.put(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const result = await store.updateAuditedMemory(chatId, requireParam(request, "memoryId"), body);
    if (!result) throw notFound("Memory not found");
    if (result.memory.enabled !== false) {
      await ensureMemoryEmbeddings([result.memory], store.getSettings());
    }
    response.json({
      ok: true,
      data: serializeMemory(store.getMemory(chatId, result.memory.id))
    });
  })
);

app.delete(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const deleted = await store.tombstoneMemory(chatId, requireParam(request, "memoryId"));
    if (!deleted) throw notFound("Memory not found");
    response.status(204).send();
  })
);

app.get("/api/chats/:id/memories/:memoryId/revisions", (request, response) => {
  const data = store.listMemoryRevisions(requireParam(request, "id"), requireParam(request, "memoryId"));
  if (!data) throw notFound("Memory not found");
  response.json({ ok: true, data });
});

app.get("/api/chats/:id/memories/:memoryId/revisions/:revision/restore-preview", (request, response) => {
  const data = store.previewMemoryRestore(requireParam(request, "id"), requireParam(request, "memoryId"), Number(requireParam(request, "revision")));
  if (!data) throw notFound("Memory revision not found");
  response.json({ ok: true, data });
});

app.post("/api/chats/:id/memories/:memoryId/restore", asyncHandler(async (request, response) => {
  const body = parseBody(memoryRestoreExecuteSchema, request.body);
  const data = await store.restoreMemory(requireParam(request, "id"), requireParam(request, "memoryId"), body.revision, body.expectedCurrentRevision);
  if (!data) throw notFound("Memory revision not found");
  response.json({ ok: true, data: { memory: serializeMemory(data.memory), revision: data.revision } });
}));

app.post("/api/chats/:id/memories/:memoryId/purge", asyncHandler(async (request, response) => {
  parseBody(memoryPurgeSchema, request.body);
  const purged = await store.purgeMemory(requireParam(request, "id"), requireParam(request, "memoryId"));
  if (!purged) { const error = new Error("Only a deleted memory can be permanently purged."); error.status = 409; throw error; }
  response.json({ ok: true, data: { purged: true } });
}));

app.get("/api/chats/:id/memory-operations", (request, response) => response.json({ ok: true, data: store.listMemoryOperations(requireParam(request, "id")) }));

app.post("/api/chats/:id/memory-operations/:operationId/undo-preview", (request, response) => {
  const data = store.previewMemoryOperationUndo(requireParam(request, "id"), requireParam(request, "operationId"));
  if (!data) throw notFound("Memory operation not found");
  response.json({ ok: true, data });
});

app.post("/api/chats/:id/memory-operations/:operationId/undo", asyncHandler(async (request, response) => {
  const body = parseBody(memoryUndoExecuteSchema, request.body);
  const data = await store.executeMemoryOperationUndo(requireParam(request, "id"), requireParam(request, "operationId"), body.resolutions);
  if (!data) throw notFound("Memory operation not found");
  response.json({ ok: true, data });
}));

app.get("/api/chats/:id/profile-summary/revisions", (request, response) => {
  const data = store.listProfileSummaryRevisions(requireParam(request, "id"));
  if (!data) throw notFound("Chat not found");
  response.json({ ok: true, data });
});

app.get("/api/chats/:id/profile-summary/revisions/:revision/restore-preview", (request, response) => {
  const data = store.previewProfileSummaryRestore(requireParam(request, "id"), Number(requireParam(request, "revision")));
  if (!data) throw notFound("Profile summary revision not found");
  response.json({ ok: true, data });
});

app.post("/api/chats/:id/profile-summary/restore", asyncHandler(async (request, response) => {
  const body = parseBody(profileSummaryRestoreExecuteSchema, request.body);
  const data = await store.restoreProfileSummary(requireParam(request, "id"), body.revision, body.expectedCurrentRevision);
  if (!data) throw notFound("Profile summary revision not found");
  response.json({ ok: true, data });
}));

app.post(
  "/api/chats/:id/memories/refresh",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    await updateChatMemoriesFromTurn({
      chatId,
      settings: store.getSettings(),
      force: true
    });
    response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
  })
);

app.post(
  "/api/chats/:id/memories/reindex",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const enabledMemories = store
      .listMemories(chatId)
      .filter((memory) => memory.enabled !== false && !memory.deletedAt);
    if (enabledMemories.length === 0) {
      response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
      return;
    }

    const settings = store.getSettings();
    try {
      resolveModuleSettings(settings, "memory_embedding");
    } catch {
      throw httpError(
        400,
        "Configure a compatible memory embedding model before rebuilding the index."
      );
    }
    const index = await ensureMemoryEmbeddings(enabledMemories, settings, true);
    if (!index) {
      throw httpError(
        502,
        "Memory embedding index rebuild failed. Keyword retrieval remains available."
      );
    }
    response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
  })
);

app.post(
  "/api/chats/:id/branches",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatBranchSchema, request.body);
    const chat = getActiveChat(chatId);
    if (!chat) throw notFound("Chat not found");

    const messages = store.listMessages(chatId);
    const targetIndex = messages.findIndex((message) => message.id === body.messageId);
    if (targetIndex < 0) throw notFound("Branch message not found");

    const isCheckpoint = body.kind === "checkpoint";
    const branch = await store.createChat({
      title: body.title ?? `${chat.title} - ${isCheckpoint ? "Checkpoint" : "Branch"}`,
      characterId: chat.characterId,
      parentChatId: chat.id,
      branchSourceMessageId: messages[targetIndex]?.id ?? null,
      isCheckpoint,
      folder: chat.folder,
      backgroundUrl: chat.backgroundUrl,
      memoryTurns: chat.memoryTurns,
      autoMemoryEnabled: chat.autoMemoryEnabled,
      userPersona: chat.userPersona,
      userAvatar: chat.userAvatar ?? "",
      userProfileSummary: chat.userProfileSummary,
      userProfileUpdatedAt: chat.userProfileUpdatedAt,
      profileBaselineActor: "restore"
    });

    for (const message of messages.slice(0, targetIndex + 1)) {
      const copiedMessage = await store.createMessage({
        chatId: branch.id,
        role: message.role,
        characterId: message.characterId,
        content: message.content,
        contextIncluded: message.contextIncluded !== false,
        isBookmarked: message.isBookmarked === true,
        variants: message.variants,
        activeVariantIndex: message.activeVariantIndex,
        tokenUsage: message.tokenUsage,
        generationMetadata: message.generationMetadata,
        variantMetadata: message.variantMetadata,
        promptBreakdown: message.promptBreakdown,
        loreMatches: message.loreMatches,
        memoryMatches: message.memoryMatches,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      });
      await store.copyMessageAttachments(message.id, copiedMessage.id);
    }

    response.status(201).json({
      ok: true,
      data: {
        ...serializeChat(branch),
        messageCount: targetIndex + 1,
        messages: store.listMessages(branch.id).map(serializeMessage),
        memories: []
      }
    });
  })
);

app.get("/api/chats/message-search", (request, response) => {
  const query = parseQuery(chatMessageSearchQuerySchema, request.query);
  const normalizedQuery = query.q.toLowerCase();
  const indexesByChat = new Map();
  const matches = store.listMessages().flatMap((message) => {
    if (!getActiveChat(message.chatId)) return [];
    const index = indexesByChat.get(message.chatId) ?? 0;
    indexesByChat.set(message.chatId, index + 1);
    if (!String(message.content ?? "").toLowerCase().includes(normalizedQuery)) {
      return [];
    }
    return [{ message, index }];
  });

  matches.sort((a, b) => String(b.message.createdAt).localeCompare(String(a.message.createdAt)));
  response.json({
    ok: true,
    data: {
      query: query.q,
      total: matches.length,
      results: matches.slice(0, query.limit).flatMap(({ message, index }) => {
        const chat = getActiveChat(message.chatId);
        if (!chat) return [];
        return [{
          chat: {
            id: chat.id,
            title: chat.title,
            characterId: chat.characterId ?? null,
            isArchived: chat.isArchived === true
          },
          message: serializeMessage(message),
          index,
          snippet: buildMessageSearchSnippet(message.content, query.q)
        }];
      })
    }
  });
});

app.get("/api/chats/:id/message-search", (request, response) => {
  const chatId = requireParam(request, "id");
  const query = parseQuery(chatMessageSearchQuerySchema, request.query);
  if (!getActiveChat(chatId)) throw notFound("Chat not found");

  const normalizedQuery = query.q.toLowerCase();
  const matches = store
    .listMessages(chatId)
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => String(message.content ?? "").toLowerCase().includes(normalizedQuery));

  response.json({
    ok: true,
    data: {
      query: query.q,
      total: matches.length,
      results: matches.slice(0, query.limit).map(({ message, index }) => ({
        message: serializeMessage(message),
        index,
        snippet: buildMessageSearchSnippet(message.content, query.q)
      }))
    }
  });
});

app.get("/api/chats/:id", (request, response) => {
  const chat = getActiveChat(requireParam(request, "id"));
  if (!chat) throw notFound("Chat not found");
  response.json({
    ok: true,
    data: {
      ...serializeChat(chat),
      messages: store.listMessages(chat.id).map(serializeMessage),
      memories: store.listMemories(chat.id).map(serializeMemory)
    }
  });
});

app.post(
  "/api/chats/batch-archive",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchArchiveSchema, request.body);
    if (!body.ids.every((id) => getActiveChat(id))) {
      throw notFound("One or more chats were not found");
    }
    const updated = await store.updateChats(body.ids, { isArchived: body.isArchived });
    response.json({ ok: true, data: { updated } });
  })
);

app.post(
  "/api/chats/batch-folder",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchFolderSchema, request.body);
    if (!body.ids.every((id) => store.getChat(id))) {
      throw notFound("One or more chats were not found");
    }
    const updated = await store.updateChats(body.ids, { folder: body.folder });
    response.json({ ok: true, data: { updated } });
  })
);

app.post(
  "/api/chats/rename-folder",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatRenameFolderSchema, request.body);
    const ids = store.listChats().filter((chat) => chat.folder === body.from).map((chat) => chat.id);
    const updated = ids.length ? await store.updateChats(ids, { folder: body.to }) : 0;
    response.json({ ok: true, data: { updated } });
  })
);

app.post(
  "/api/chats/batch-trash",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchTrashSchema, request.body);
    const updated = await store.updateChatTrash(body.ids, body.action);
    if (updated === null) {
      throw notFound("One or more chats were not found in the expected history scope");
    }
    response.json({ ok: true, data: { updated } });
  })
);

app.post(
  "/api/chats/batch-permanent-delete",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchPermanentDeleteSchema, request.body);
    const deleted = await store.permanentlyDeleteChats(body.ids);
    if (deleted === null) throw notFound("One or more trashed chats were not found");
    response.json({ ok: true, data: { deleted } });
  })
);

app.put(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    if (!getActiveChat(id)) throw notFound("Chat not found");
    const body = parseBody(chatUpdateSchema, request.body);
    const { userProfileSummary, ...ordinaryUpdates } = body;
    if (typeof userProfileSummary === "string") await store.updateProfileSummary(id, userProfileSummary, "user", []);
    const chat = await store.updateChat(id, ordinaryUpdates);
    if (!chat) throw notFound("Chat not found");
    response.json({ ok: true, data: serializeChat(chat) });
  })
);

app.post(
  "/api/chats/:id/restore",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getChat(id);
    if (!existing?.deletedAt) throw notFound("Trashed chat not found");
    const chat = await store.updateChat(id, { deletedAt: null });
    response.json({ ok: true, data: serializeChat(chat) });
  })
);

app.delete(
  "/api/chats/:id/permanent",
  asyncHandler(async (request, response) => {
    const deleted = await store.permanentlyDeleteChats([requireParam(request, "id")]);
    if (deleted === null) throw notFound("Trashed chat not found");
    response.status(204).send();
  })
);

app.delete(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getChat(id);
    if (!existing) throw notFound("Chat not found");
    if (!existing.deletedAt) {
      await store.updateChat(id, {
        deletedAt: new Date().toISOString(),
        isArchived: false,
        isPinned: false
      });
    }
    response.status(204).send();
  })
);

app.get("/api/messages", (request, response) => {
  const query = parseQuery(messageListQuerySchema, request.query);
  response.json({
    ok: true,
    data: store.listMessages(query.chatId).filter((message) => getActiveChat(message.chatId)).map(serializeMessage)
  });
});

app.post(
  "/api/messages",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageCreateSchema, request.body);
    if (!getActiveChat(body.chatId)) throw notFound("Chat not found");
    const { draftId, ...messageBody } = body;
    const message = draftId ? await store.createMessageWithDraft(messageBody, draftId) : await store.createMessage(messageBody);
    response.status(201).json({ ok: true, data: serializeMessage(message) });
  })
);

app.get("/api/messages/:id", (request, response) => {
  const message = store.getMessage(requireParam(request, "id"));
  if (!message || !getActiveChat(message.chatId)) throw notFound("Message not found");
  response.json({ ok: true, data: serializeMessage(message) });
});

app.put(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getMessage(id);
    if (!existing || !getActiveChat(existing.chatId)) throw notFound("Message not found");
    const body = parseBody(messageUpdateSchema, request.body);
    const { draftId, replaceAttachments, ...ordinaryBody } = body;
    const message = await store.updateMessageWithAttachments(id, ordinaryBody, { draftId, replaceAttachments });
    if (!message) throw notFound("Message not found");
    response.json({ ok: true, data: serializeMessage(message) });
  })
);

app.delete(
  "/api/messages/:id/timeline",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getMessage(id);
    if (!existing || !getActiveChat(existing.chatId)) throw notFound("Message not found");
    const result = await store.deleteMessageTimeline(id);
    if (!result) throw notFound("Message not found");
    response.json({ ok: true, data: result });
  })
);

app.delete(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getMessage(id);
    if (!existing || !getActiveChat(existing.chatId)) throw notFound("Message not found");
    const result = await store.deleteMessageTimeline(id);
    if (!result) throw notFound("Message not found");
    response.status(204).send();
  })
);

app.post(
  "/api/media/chat-images/messages/:messageId/edit-draft",
  asyncHandler(async (request, response) => {
    const { draftId } = parseBody(imageAttachmentEditDraftSchema, request.body);
    const messageId = requireParam(request, "messageId");
    const message = store.getMessage(messageId);
    if (!message || !getActiveChat(message.chatId)) throw notFound("Message not found");
    const attachments = await store.stageMessageAttachmentsForEdit(messageId, draftId);
    response.status(201).json({ ok: true, data: attachments.map((item) => ({ ...serializeMobileAttachment(item), draftId, status: "ready" })) });
  })
);

app.post(
  "/api/media/chat-images/drafts",
  asyncHandler(async (request, response) => {
    const body = parseBody(imageAttachmentUploadSchema, request.body);
    const normalized = normalizeUploadedImage(body);
    const contentHash = createHash("sha256").update(normalized.data).digest("hex");
    const result = await store.createDraftAttachment({
      draftId: body.draftId,
      asset: {
        contentHash,
        mimeType: normalized.mimeType,
        byteSize: normalized.data.length,
        width: normalized.width,
        height: normalized.height,
        dataBase64: normalized.data.toString("base64")
      },
      originalFilename: body.originalFilename?.replace(/[\\/\0-\x1f\x7f<>:"|?*]/g, "_").slice(0, 160) || null
    });
    response.status(201).json({ ok: true, data: { ...serializeMobileAttachment(result.attachment), draftId: body.draftId, status: "ready" } });
  })
);

app.get("/api/media/chat-images/drafts/:draftId", (request, response) => {
  const draftId = requireParam(request, "draftId");
  response.json({ ok: true, data: store.listDraftAttachments(draftId).map((item) => ({ ...serializeMobileAttachment(item), draftId, status: "ready" })) });
});

app.put(
  "/api/media/chat-images/drafts/:draftId/order",
  asyncHandler(async (request, response) => {
    const draftId = requireParam(request, "draftId");
    const body = parseBody(imageAttachmentReorderSchema, request.body);
    const items = await store.reorderDraftAttachments(draftId, body.attachmentIds);
    response.json({ ok: true, data: items.map((item) => ({ ...serializeMobileAttachment(item), draftId, status: "ready" })) });
  })
);

app.delete("/api/media/chat-images/drafts/:draftId/:attachmentId", asyncHandler(async (request, response) => {
  const removed = await store.removeDraftAttachment(requireParam(request, "draftId"), requireParam(request, "attachmentId"));
  if (!removed) throw notFound("Draft image not found");
  response.status(204).send();
}));

app.delete("/api/media/chat-images/drafts/:draftId", asyncHandler(async (request, response) => {
  await store.discardDraftAttachments(requireParam(request, "draftId"));
  response.status(204).send();
}));

app.get("/api/media/chat-images/:assetId", (request, response) => {
  const asset = store.getMediaAsset(requireParam(request, "assetId"));
  if (!asset || !store.readRecords("messageAttachment").some((item) => item.assetId === asset.id)) throw notFound("Image not found");
  response.setHeader("Content-Type", asset.mimeType);
  response.setHeader("Content-Length", String(asset.byteSize));
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.send(Buffer.from(asset.dataBase64, "base64"));
});

app.get("/api/settings", (_request, response) => {
  response.json({ ok: true, data: publicSettings(store.getSettings()) });
});

app.put(
  "/api/settings",
  asyncHandler(async (request, response) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const existingSettings = store.getSettings();
    const moduleModelPreferences =
      body.moduleModelPreferences ?? existingSettings.moduleModelPreferences ?? {};
    const userPersonaPresets = body.userPersonaPresets ?? existingSettings.userPersonaPresets ?? [];
    const modelReliability = body.modelReliability ?? existingSettings.modelReliability;
    const usageBudgets = body.usageBudgets ?? existingSettings.usageBudgets;
    const usageTimezone = body.usageTimezone ?? existingSettings.usageTimezone;
    const moduleModelError = validateModuleModelPreferences(
      body.providers,
      moduleModelPreferences,
      body.activeProviderId,
      body.activeModelId
    );
    if (moduleModelError) throw httpError(400, moduleModelError);
    const reliabilityError = validateModelReliabilitySettings(body.providers, modelReliability);
    if (reliabilityError) throw httpError(400, reliabilityError);
    const providers = mergeProviderProfiles(body.providers, existingSettings.providers);
    const activeProfile = body.providers.find((provider) => provider.id === body.activeProviderId);
    const storedActiveProfile = providers.find((provider) => provider.id === body.activeProviderId);
    const activeModel = activeProfile?.models.find((model) => model.id === body.activeModelId);
    const resolvedApiKey =
      (typeof storedActiveProfile?.key === "string" ? storedActiveProfile.key : undefined) ??
      (hasOwn(body, "apiKey") ? encryptApiKey(body.apiKey) : undefined);
    const settings = await store.updateSettings({
      providers,
      activeProviderId: body.activeProviderId,
      activeModelId: body.activeModelId,
      moduleModelPreferences,
      userPersonaPresets,
      modelReliability,
      usageBudgets,
      usageTimezone,
      activeProvider: activeProfile?.provider ?? body.activeProvider,
      apiBaseUrl: activeProfile?.apiBaseUrl ?? body.apiBaseUrl,
      model: activeModel?.model ?? body.model,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      autoSummarizeUser: body.autoSummarizeUser,
      showMessageAvatars: body.showMessageAvatars,
      showMessageTimestamps: body.showMessageTimestamps,
      ttsVoice: body.ttsVoice,
      ttsPlaybackRate: body.ttsPlaybackRate,
      ttsAutoPlay: body.ttsAutoPlay,
      userProfileSummary: body.userProfileSummary,
      userProfileUpdatedAt:
        typeof body.userProfileSummary === "string" ? new Date().toISOString() : undefined,
      ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {})
    });
    let memoryEmbeddingSourceChanged = true;
    try {
      memoryEmbeddingSourceChanged =
        getConfiguredEmbeddingSource(existingSettings) !== getConfiguredEmbeddingSource(settings);
    } catch {
      memoryEmbeddingSourceChanged = true;
    }
    if (memoryEmbeddingSourceChanged) {
      await store.markMemoryEmbeddingsStale();
    }
    response.json({ ok: true, data: publicSettings(settings) });
  })
);

app.put(
  "/api/settings/user-profile",
  asyncHandler(async (request, response) => {
    const body = parseBody(userProfileUpdateSchema, request.body);
    const summary = body.userProfileSummary.trim();
    const settings = await store.updateSettings({
      userProfileSummary: summary,
      autoSummarizeUser: body.autoSummarizeUser,
      userProfileUpdatedAt: summary ? new Date().toISOString() : null
    });
    response.json({ ok: true, data: publicSettings(settings) });
  })
);

app.post("/api/settings/test", asyncHandler(async (_request, response) => {
  const result = await executeMobileReliableText({
    module: "chat",
    operation: "connection_test",
    messages: [{ role: "user", content: "Connection test" }],
    maxTokens: 8,
    temperature: 0
  });
  response.json({
    ok: true,
    data: {
      reachable: true,
      provider: result.identity.providerType,
      model: result.identity.modelId,
      requestId: result.requestId
    }
  });
}));

const mobileUsageBucket = (rows, keyOf, labelOf = keyOf) => {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const item = map.get(key) ?? { key, label: labelOf(row), attempts: 0, succeeded: 0, failed: 0, retries: 0, fallbacks: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0, unknownCostAttempts: 0 };
    item.attempts += 1; item.succeeded += row.status === "succeeded" ? 1 : 0; item.failed += ["failed", "interrupted"].includes(row.status) ? 1 : 0;
    item.retries += (row.attemptNumber ?? 1) > 1 ? 1 : 0; item.fallbacks += row.usedFallback ? 1 : 0;
    item.promptTokens += row.promptTokens ?? 0; item.outputTokens += row.outputTokens ?? 0; item.totalTokens += row.totalTokens ?? 0;
    item.estimatedCostMicros += row.estimatedCostMicros ?? 0; item.unknownCostAttempts += row.estimatedCostMicros == null ? 1 : 0;
    map.set(key, item);
  }
  return [...map.values()];
};

app.get("/api/usage/summary", (request, response) => {
  const settings = store.getSettings();
  const now = new Date();
  const from = typeof request.query.from === "string" ? new Date(request.query.from) : new Date(now.getTime() - 31 * 86_400_000);
  const to = typeof request.query.to === "string" ? new Date(request.query.to) : new Date(now.getTime() + 1);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 370 * 86_400_000) {
    throw httpError(400, "Usage range must be between 1 and 370 days.");
  }
  const moduleFilter = typeof request.query.module === "string" && Object.hasOwn(moduleCapabilities, request.query.module) ? request.query.module : null;
  const providerFilter = typeof request.query.providerId === "string" && request.query.providerId ? request.query.providerId : null;
  const modelFilter = typeof request.query.modelId === "string" && request.query.modelId ? request.query.modelId : null;
  const chatFilter = typeof request.query.chatId === "string" && request.query.chatId ? request.query.chatId : null;
  const allRows = store.listUsageAttempts();
  const rows = allRows.filter((row) => {
    const startedAt = new Date(row.startedAt).getTime();
    return startedAt >= from.getTime() && startedAt < to.getTime() &&
      (!moduleFilter || row.module === moduleFilter) &&
      (!providerFilter || row.providerId === providerFilter) &&
      (!modelFilter || row.modelId === modelFilter) &&
      (!chatFilter || row.chatId === chatFilter);
  });
  const timezone = settings.usageTimezone || "UTC";
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type) => dateParts.find((entry) => entry.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`; const month = day.slice(0, 7);
  const todayRows = allRows.filter((row) => row.reservationDay === day); const monthRows = allRows.filter((row) => row.reservationMonth === month);
  const sum = (values, key) => values.reduce((total, row) => total + (row[key] ?? 0), 0);
  response.json({ ok: true, data: {
    from: from.toISOString(), to: to.toISOString(),
    todayCostMicros: sum(todayRows, "estimatedCostMicros"), monthCostMicros: sum(monthRows, "estimatedCostMicros"),
    todayTokens: sum(todayRows, "totalTokens"), monthTokens: sum(monthRows, "totalTokens"),
    unknownCostAttempts: rows.filter((row) => row.estimatedCostMicros == null).length,
    budgets: settings.usageBudgets, timezone,
    byModule: mobileUsageBucket(rows, (row) => row.module), byProvider: mobileUsageBucket(rows, (row) => row.providerId), byModel: mobileUsageBucket(rows, (row) => `${row.providerId}/${row.modelId}`),
    byChat: mobileUsageBucket(rows.filter((row) => row.chatId), (row) => row.chatId, (row) => store.getChat(row.chatId)?.title ?? "Local chat"),
    recent: rows.slice(0, 30).map((row) => ({ ...row, specialTokensUnknown: row.specialTokensUnknown === true, attemptId: row.id, chatTitle: row.chatId ? store.getChat(row.chatId)?.title ?? null : null }))
  } });
});

app.post("/api/usage/preview", (request, response) => {
  const moduleId = Object.hasOwn(moduleCapabilities, request.body?.module) ? request.body.module : "chat";
  const settings = resolveModuleSettings(store.getSettings(), moduleId);
  const provider = (settings.providers ?? []).find((entry) => entry.id === settings.activeProviderId);
  const model = provider?.models?.find((entry) => entry.id === settings.activeModelId);
  const pricing = model?.pricing;
  const inputTokens = Number.isInteger(request.body?.inputTokens)
    ? Math.max(0, Math.min(100_000_000, request.body.inputTokens))
    : (Array.isArray(request.body?.texts) ? request.body.texts : []).reduce((total, text) => total + estimatePromptTokens(text), 0);
  const maxOutputTokens = Number.isInteger(request.body?.maxOutputTokens) ? request.body.maxOutputTokens : settings.maxTokens;
  const cost = pricing ? (output) => Math.ceil((inputTokens * pricing.inputMicrosPerMillion + output * pricing.outputMicrosPerMillion) / 1_000_000) : () => null;
  const timezone = settings.usageTimezone || "UTC";
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type) => dateParts.find((entry) => entry.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const month = day.slice(0, 7);
  const rows = store.listUsageAttempts();
  const committed = (key, value) => rows
    .filter((row) => row[key] === value)
    .reduce((total, row) => total + (row.estimatedCostMicros ?? 0) + (row.reservedCostMicros ?? 0), 0);
  const todayCostMicros = rows.filter((row) => row.reservationDay === day).reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0);
  const monthCostMicros = rows.filter((row) => row.reservationMonth === month).reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0);
  const todayCommitted = committed("reservationDay", day);
  const monthCommitted = committed("reservationMonth", month);
  const budgets = settings.usageBudgets ?? {};
  const maximum = cost(maxOutputTokens);
  const remaining = (limit, used) => Number.isSafeInteger(limit) ? Math.max(0, limit - used) : null;
  response.json({ ok: true, data: {
    providerId: settings.activeProviderId || settings.activeProvider, modelId: settings.model, inputTokens, maxOutputTokens,
    minimumCostMicros: cost(0), maximumCostMicros: maximum, currency: pricing?.currency ?? null,
    todayCostMicros, monthCostMicros,
    dailySoftRemainingMicros: remaining(budgets.dailySoftMicros, todayCommitted), dailyHardRemainingMicros: remaining(budgets.dailyHardMicros, todayCommitted),
    monthlySoftRemainingMicros: remaining(budgets.monthlySoftMicros, monthCommitted), monthlyHardRemainingMicros: remaining(budgets.monthlyHardMicros, monthCommitted),
    unknownPricing: !pricing,
    softWarning: maximum !== null && ((Number.isSafeInteger(budgets.dailySoftMicros) && todayCommitted + maximum > budgets.dailySoftMicros) || (Number.isSafeInteger(budgets.monthlySoftMicros) && monthCommitted + maximum > budgets.monthlySoftMicros)),
    hardBlocked: (!pricing && budgets.allowUnknownPricing === false) || (maximum !== null && ((Number.isSafeInteger(budgets.dailyHardMicros) && todayCommitted + maximum > budgets.dailyHardMicros) || (Number.isSafeInteger(budgets.monthlyHardMicros) && monthCommitted + maximum > budgets.monthlyHardMicros))),
    timezone
  } });
});

app.delete("/api/usage/history", asyncHandler(async (request, response) => {
  if (request.body?.confirm !== "DELETE_USAGE_HISTORY") throw httpError(400, "Explicit usage-history confirmation is required.");
  response.json({ ok: true, data: await store.clearUsageHistory() });
}));

app.get("/api/settings/models", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await fetchAvailableModels(store.getSettings()) });
}));

app.post(
  "/api/media/voice/transcriptions",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceTranscriptionSchema, request.body);
    const rootSettings = store.getSettings();
    const result = await executeMobileReliableOperation({
      rootSettings,
      module: "voice_transcription",
      operation: "transcription",
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      specialTokensUnknown: true,
      invoke: async (settings, signal) => ({ value: await transcribeAudio({ settings, ...body, signal }) })
    });
    response.json({ ok: true, data: result.value });
  })
);

app.post(
  "/api/media/voice/speech",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceSpeechSchema, request.body);
    const rootSettings = store.getSettings();
    const result = await executeMobileReliableOperation({
      rootSettings,
      module: "voice_speech",
      operation: "tts",
      estimatedInputTokens: estimatePromptTokens(body.text),
      maxOutputTokens: 0,
      specialTokensUnknown: true,
      invoke: async (settings, signal) => ({ value: await createSpeechAudio({ settings, ...body, signal }) })
    });
    response.json({ ok: true, data: result.value });
  })
);

app.post(
  "/api/media/images/generations",
  asyncHandler(async (request, response) => {
    const body = parseBody(imageGenerationSchema, request.body);
    const rootSettings = store.getSettings();
    const result = await executeMobileReliableOperation({
      rootSettings,
      module: "image_generation",
      operation: "image_generation",
      estimatedInputTokens: estimatePromptTokens(body.prompt),
      maxOutputTokens: 0,
      specialTokensUnknown: true,
      invoke: async (settings, signal) => ({ value: await generateImage({ settings, ...body, signal }) })
    });
    response.json({ ok: true, data: result.value });
  })
);

app.post("/api/settings/providers/:providerId/models", asyncHandler(async (request, response) => {
  const settings = store.getSettings();
  const body = request.body;
  const storedProvider = (settings.providers ?? []).find((entry) => entry.id === request.params.providerId);
  const provider =
    body && typeof body.apiBaseUrl === "string"
      ? {
          provider: body.provider ?? "",
          apiBaseUrl: body.apiBaseUrl,
          key: typeof body.key === "string" && body.key ? body.key : storedProvider?.key
        }
      : storedProvider;
  if (!provider) throw notFound("Provider not found");
  response.json({
    ok: true,
    data: await fetchAvailableModels({
      ...settings,
      activeProvider: provider.provider,
      apiBaseUrl: provider.apiBaseUrl,
      apiKey: provider.key ?? settings.apiKey
    })
  });
}));

app.get("/api/backups/export", (_request, response) => {
  response.json({ ok: true, data: store.exportBackup(serializeSettings(store.getSettings())) });
});

app.post(
  "/api/backups/preview",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupPreviewRequestSchema, request.body);
    response.json({
      ok: true,
      data: store.previewBackup(backup, serializeSettings(store.getSettings()))
    });
  })
);

app.post(
  "/api/backups/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupExecuteSchema, request.body);
    response.json({
      ok: true,
      data: await store.importBackup(backup, serializeSettings(store.getSettings()))
    });
  })
);

app.get("/api/backups/recovery-points", (_request, response) => {
  response.json({ ok: true, data: store.listRecoveryPoints() });
});

app.post(
  "/api/backups/recovery-points/:id/restore",
  asyncHandler(async (request, response) => {
    response.json({
      ok: true,
      data: await store.restoreRecoveryPoint(
        request.params.id,
        serializeSettings(store.getSettings())
      )
    });
  })
);

app.post(
  "/api/exports/text",
  asyncHandler(async (request, response) => {
    const filename = sanitizeExportFilename(request.body?.filename);
    const content = typeof request.body?.content === "string" ? request.body.content : "";
    if (!content.trim()) {
      const error = new Error("Export content is empty");
      error.status = 400;
      throw error;
    }

    await mkdir(exportDir, { recursive: true });
    const filePath = path.join(exportDir, filename);
    await writeFile(filePath, content, "utf8");

    response.json({
      ok: true,
      data: {
        filename,
        path: filePath,
        url: `file://${filePath.replace(/\\/g, "/")}`
      }
    });
  })
);

app.get("/api/sync/info", (request, response) => {
  const localUrl = `http://127.0.0.1:${port}`;
  const lanUrls = host === "127.0.0.1" || host === "localhost"
    ? []
    : getLanHosts().map((address) => `http://${address}:${port}`);

  response.json({
    ok: true,
    data: {
      localUrl,
      lanUrls,
      currentOrigin: `${request.protocol}://${request.get("host") ?? `127.0.0.1:${port}`}`,
      port,
      listeningHost: host,
      lanReachable: lanUrls.length > 0,
      checkedAt: new Date().toISOString()
    }
  });
});

app.post(
  "/api/sync/pull",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const peerBackup = await requestPeer(peerBaseUrl, "/api/backups/export");
    const backup = parseBody(backupPreviewRequestSchema, { ...peerBackup, mode: input.mode });
    const preview = store.previewBackup(backup, serializeSettings(store.getSettings()));
    const summary = input.phase === "execute"
      ? await store.importBackup(
          parseBody(backupExecuteSchema, {
            ...backup,
            previewId: input.previewId,
            conflictResolutions: input.conflictResolutions
          }),
          serializeSettings(store.getSettings())
        )
      : null;

    response.json({
      ok: true,
      data: {
        direction: "pull",
        phase: input.phase,
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: peerBackup.exportedAt ?? null,
        completedAt: summary?.completedAt ?? null,
        preview,
        summary
      }
    });
  })
);

app.post(
  "/api/sync/push",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const localBackup = store.exportBackup(serializeSettings(store.getSettings()));
    const preview = await requestPeer(peerBaseUrl, "/api/backups/preview", {
      method: "POST",
      body: JSON.stringify({ ...localBackup, mode: input.mode })
    });
    const summary = input.phase === "execute"
      ? await requestPeer(peerBaseUrl, "/api/backups/import", {
          method: "POST",
          body: JSON.stringify({
            ...localBackup,
            mode: input.mode,
            previewId: input.previewId,
            conflictResolutions: input.conflictResolutions
          })
        })
      : null;

    response.json({
      ok: true,
      data: {
        direction: "push",
        phase: input.phase,
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: null,
        completedAt: summary?.completedAt ?? null,
        preview,
        summary
      }
    });
  })
);

app.use((error, _request, response, _next) => {
  if (error instanceof ModelCallError) {
    const status = error.safe.code === "authentication" ? 401
      : error.safe.code === "model_not_found" ? 404
        : error.safe.code === "rate_limited" ? 429
          : error.safe.code === "budget_blocked" ? 409
            : ["invalid_request", "context_overflow", "unsupported_capability"].includes(error.safe.code) ? 400 : 502;
    response.status(status).json({ ok: false, error: error.safe.summary, modelError: error.safe });
    return;
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  response.status(status).json({
    ok: false,
    error: status < 500 && error instanceof Error ? error.message : "Internal server error"
  });
});

const controllers = new Map();
const sendJson = (socket, value) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
};

const appendVariant = (value, content) => {
  const variants = toStringArray(value);
  if (!variants.includes(content)) variants.push(content);
  return variants;
};

const joinAssistantContinuation = (existing, continuation) => {
  if (!existing || !continuation || /\s$/.test(existing) || /^\s/.test(continuation)) {
    return `${existing}${continuation}`;
  }

  const needsWordBoundary = /[A-Za-z0-9.!?;:)]$/.test(existing) && /^[A-Za-z0-9]/.test(continuation);
  return `${existing}${needsWordBoundary ? " " : ""}${continuation}`;
};

const claimMobileRequest = async (socket, { requestId, operation, chatId, messageId, overrideHardBudget }) => {
  const claim = await store.beginModelRequest({ requestId, module: "chat", operation, chatId, messageId, overrideHardBudget });
  if (!claim.created) {
    sendJson(socket, { type: "generation_status", request: { ...claim.request, requestId: claim.request.id } });
    return false;
  }
  if (controllers.has(requestId)) return false;
  return true;
};

const sendSafeMobileError = async (socket, requestId, error, settings, receivedOutputTokens = false, cancelled = false) => {
  const normalized = normalizeModelError(error, { provider: settings?.activeProvider ?? "", modelId: settings?.model ?? "", receivedOutputTokens, cancelled });
  await store.updateModelRequest(requestId, {
    status: normalized.safe.code === "cancelled" ? "cancelled" : normalized.safe.receivedOutputTokens ? "interrupted" : normalized.safe.code === "budget_blocked" ? "blocked" : "failed",
    errorCode: normalized.safe.code,
    errorSummary: normalized.safe.summary,
    diagnosticId: normalized.safe.diagnosticId,
    completedAt: new Date().toISOString()
  });
  sendJson(socket, { type: "error", requestId, error: normalized.safe.summary, modelError: normalized.safe });
};

const appendAssistantContinuation = async ({
  targetMessage,
  continuation,
  tokenUsage,
  promptBreakdown,
  loreMatches,
  memoryMatches,
  generationMetadata
}) => {
  const content = joinAssistantContinuation(targetMessage.content, continuation);
  const variants = toStringArray(targetMessage.variants);
  const activeVariantIndex = Math.min(
    Math.max(targetMessage.activeVariantIndex ?? 0, 0),
    Math.max(variants.length - 1, 0)
  );
  if (variants.length === 0) variants.push(content);
  else variants[activeVariantIndex] = content;
  const variantMetadata = Array.isArray(targetMessage.variantMetadata)
    ? [...targetMessage.variantMetadata]
    : [];
  while (variantMetadata.length <= activeVariantIndex) variantMetadata.push(null);
  if (generationMetadata) variantMetadata[activeVariantIndex] = generationMetadata;

  return store.updateMessage(targetMessage.id, {
    content,
    variants,
    activeVariantIndex,
    tokenUsage,
    promptBreakdown,
    loreMatches,
    memoryMatches,
    generationMetadata,
    variantMetadata
  });
};

const createAssistantReply = async ({
  socket,
  requestId,
  chatId,
  targetMessageId,
  excludeMessageIds = [],
  continuationTargetMessageId,
  regenerationGuidance,
  regenerationTargetContent,
  abortController
}) => {
  const targetMessageIdForLookup = continuationTargetMessageId ?? targetMessageId;
  const targetMessage = targetMessageIdForLookup ? store.getMessage(targetMessageIdForLookup) : null;
  const context = await getPromptContext({
    chatId,
    before:
      continuationTargetMessageId || !targetMessage?.createdAt
        ? undefined
        : new Date(targetMessage.createdAt),
    excludeMessageIds
  });
  sendJson(socket, {
    type: "generation_character_started",
    requestId,
    characterId: context.chat.characterId,
    index: 0,
    total: 1
  });
  sendJson(socket, { type: "lore_matches", requestId, entries: context.matchedLoreEntries });
  sendJson(socket, { type: "memory_matches", requestId, entries: context.matchedMemoryEntries });

  const generationInstruction = continuationTargetMessageId
    ? {
        role: "user",
        content:
          "Continue the immediately preceding assistant reply from its exact ending. Return only the continuation, without repeating or summarizing any existing text."
      }
    : regenerationGuidance && regenerationTargetContent
      ? buildRegenerationGuidanceMessage({
          originalResponse: regenerationTargetContent,
          guidance: regenerationGuidance
        })
      : null;
  const completionMessages = generationInstruction
    ? [...context.messages, generationInstruction]
    : context.messages;
  const completionPromptBreakdown = generationInstruction
    ? appendPromptBreakdownInstruction(context.promptBreakdown, generationInstruction.content)
    : context.promptBreakdown;
  let content = "";
  let tokenUsage = null;
  let stopped = false;
  let terminalStreamError = null;
  const rootSettings = store.getSettings();
  const requiresVision = completionMessages.some((message) => message.images?.length);
  const candidates = [resolveModuleSettings(rootSettings, "chat"), ...resolveAutomaticFallbackSettings(rootSettings, "chat")]
    .filter((settings) => !requiresVision || settingsSupportVisionInput(settings));
  if (!candidates.length) throw new ModelCallError({ code: "unsupported_capability", retryable: false, receivedOutputTokens: false, provider: rootSettings.activeProvider, modelId: rootSettings.model, attempt: 0, summary: "The selected chat model does not support image input." });
  const primaryIdentity = mobileModelIdentity(candidates[0]);
  const promptTokenEstimate = completionMessages.reduce((total, message) => total + estimatePromptTokens(message.content) + (message.images?.length ?? 0) * 1024, 0);
  let activeAttempt = null;
  let activeIdentity = primaryIdentity;
  let lastError = null;
  let attemptNumber = 0;
  generation: for (const [candidateIndex, settings] of candidates.entries()) {
    const identity = mobileModelIdentity(settings);
    if (candidateIndex > 0 && lastError) {
      sendJson(socket, { type: "generation_fallback", requestId, fromProviderId: primaryIdentity.providerId, fromModelId: primaryIdentity.modelId, toProviderId: identity.providerId, toModelId: identity.modelId, reason: lastError.safe.code });
    }
    const retry = settings.modelReliability?.retry;
    const maxAttempts = retry?.enabled === true ? 1 + Math.max(0, Math.min(2, Number(retry.maxRetries) || 0)) : 1;
    for (let candidateAttempt = 1; candidateAttempt <= maxAttempts; candidateAttempt += 1) {
      attemptNumber += 1;
      const attempt = await store.reserveUsageAttempt({
        settings,
        requestId,
        attemptNumber,
        module: "chat",
        chatId,
        messageId: targetMessageIdForLookup ?? null,
        providerId: identity.providerId,
        providerType: identity.providerType,
        modelId: identity.modelId,
        promptTokens: promptTokenEstimate,
        maxOutputTokens: settings.maxTokens,
        pricing: identity.pricing,
        usedFallback: candidateIndex > 0,
        fallbackFromProviderId: candidateIndex > 0 ? primaryIdentity.providerId : null,
        fallbackFromModelId: candidateIndex > 0 ? primaryIdentity.modelId : null
        ,specialTokensUnknown: requiresVision
      });
      if (attempt.status === "blocked") {
        throw new ModelCallError({ code: "budget_blocked", retryable: false, receivedOutputTokens: false, provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber, summary: "The local hard budget prevented this model call.", diagnosticId: attempt.diagnosticId });
      }
      activeAttempt = attempt;
      activeIdentity = identity;
      try {
        for await (const event of streamChatCompletion({ settings, messages: completionMessages, signal: abortController.signal })) {
          if (event.type === "usage") {
            tokenUsage = event.usage;
            continue;
          }
          if (!content && event.content) await store.updateModelRequest(requestId, { status: "streaming", outputStarted: true });
          content += event.content;
          sendJson(socket, { type: "token", requestId, content: event.content });
        }
        break generation;
      } catch (caught) {
        const normalized = normalizeModelError(caught, { provider: identity.providerType, modelId: identity.modelId, attempt: attemptNumber, receivedOutputTokens: Boolean(content), cancelled: abortController.signal.aborted });
        const partialUsage = content ? estimateTokenUsage(completionMessages, content) : null;
        await store.updateUsageAttempt(attempt.id, {
          status: normalized.safe.code === "cancelled" ? "cancelled" : content ? "interrupted" : "failed",
          completedAt: new Date().toISOString(),
          promptTokens: partialUsage?.promptTokens ?? null,
          outputTokens: partialUsage?.completionTokens ?? null,
          totalTokens: partialUsage?.totalTokens ?? null,
          usageSource: partialUsage ? "estimated" : null,
          specialTokensUnknown: requiresVision,
          estimatedCostMicros: partialUsage && identity.pricing ? Math.ceil((partialUsage.promptTokens * identity.pricing.inputMicrosPerMillion + partialUsage.completionTokens * identity.pricing.outputMicrosPerMillion) / 1_000_000) : null,
          reservedCostMicros: 0,
          errorCode: normalized.safe.code,
          diagnosticId: normalized.safe.diagnosticId
        });
        if (abortController.signal.aborted) { stopped = true; break generation; }
        if (content) { terminalStreamError = normalized; break generation; }
        const canRetry = normalized.safe.retryable && candidateAttempt < maxAttempts;
        const canFallback = normalized.safe.retryable && candidateIndex < candidates.length - 1;
        if (!canRetry && !canFallback) throw normalized;
        lastError = normalized;
        if (canRetry) {
          const milliseconds = mobileRetryDelay(candidateAttempt, normalized.safe.retryAfterMs);
          sendJson(socket, { type: "generation_retrying", requestId, attempt: attemptNumber + 1, retryAfterMs: milliseconds, error: normalized.safe });
          await waitMobileRetry(milliseconds, abortController.signal);
        } else break;
      }
    }
  }

  const trimmed = content.trim();
  if (!trimmed) {
    if (stopped) {
      if (activeAttempt) await store.updateUsageAttempt(activeAttempt.id, { status: "cancelled", completedAt: new Date().toISOString(), reservedCostMicros: 0, errorCode: "cancelled" });
      await store.updateModelRequest(requestId, { status: "cancelled", completedAt: new Date().toISOString() });
      return { stopped };
    }
    throw new Error("Model returned an empty response");
  }

  tokenUsage ??= estimateTokenUsage(completionMessages, trimmed);
  const estimatedCostMicros = activeIdentity.pricing
    ? Math.ceil((tokenUsage.promptTokens * activeIdentity.pricing.inputMicrosPerMillion + tokenUsage.completionTokens * activeIdentity.pricing.outputMicrosPerMillion) / 1_000_000)
    : null;
  const metadata = activeAttempt ? {
    providerId: activeIdentity.providerId,
    providerType: activeIdentity.providerType,
    modelId: activeIdentity.modelId,
    requestId,
    attemptId: activeAttempt.id,
    usage: tokenUsage,
    usageSource: tokenUsage.estimated ? "estimated" : "provider",
    inputPriceMicros: activeIdentity.pricing?.inputMicrosPerMillion ?? null,
    outputPriceMicros: activeIdentity.pricing?.outputMicrosPerMillion ?? null,
    estimatedCostMicros,
    currency: activeIdentity.pricing?.currency ?? null,
    usedFallback: activeAttempt.usedFallback,
    incomplete: stopped || Boolean(terminalStreamError)
  } : null;
  const promptBreakdown = finalizePromptBreakdown(
    completionPromptBreakdown,
    tokenUsage.promptTokens,
    tokenUsage.estimated
  );
  const message = continuationTargetMessageId
    ? await appendAssistantContinuation({
        targetMessage,
        continuation: trimmed,
        tokenUsage,
        promptBreakdown,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries,
        generationMetadata: metadata
      })
    : targetMessageId
    ? await store.updateMessage(targetMessageId, {
        content: trimmed,
        variants: appendVariant(targetMessage.variants, trimmed),
        activeVariantIndex: appendVariant(targetMessage.variants, trimmed).length - 1,
        tokenUsage,
        promptBreakdown,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
        ,generationMetadata: metadata,
        variantMetadata: metadata ? [...(Array.isArray(targetMessage.variantMetadata) ? targetMessage.variantMetadata : []), metadata] : (Array.isArray(targetMessage.variantMetadata) ? targetMessage.variantMetadata : [])
      })
    : await store.createMessage({
        chatId,
        role: "assistant",
        characterId: context.chat.characterId,
        content: trimmed,
        variants: [trimmed],
        activeVariantIndex: 0,
        tokenUsage,
        promptBreakdown,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
        ,generationMetadata: metadata,
        variantMetadata: metadata ? [metadata] : []
      });

  const completedAt = new Date().toISOString();
  const terminalStatus = stopped ? "cancelled" : terminalStreamError ? "interrupted" : "succeeded";
  await store.settleModelAttempt({
    attemptId: activeAttempt.id,
    requestId,
    attemptUpdates: {
      status: terminalStatus,
      completedAt,
      messageId: message.id,
      promptTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
      usageSource: tokenUsage.estimated ? "estimated" : "provider",
      specialTokensUnknown: requiresVision && tokenUsage.estimated,
      estimatedCostMicros,
      reservedCostMicros: 0,
      errorCode: terminalStreamError?.safe.code ?? (stopped ? "cancelled" : null),
      diagnosticId: terminalStreamError?.safe.diagnosticId ?? null
    },
    requestUpdates: {
      status: terminalStatus,
      messageId: message.id,
      completedAt,
      errorCode: terminalStreamError?.safe.code ?? (stopped ? "cancelled" : null),
      errorSummary: terminalStreamError?.safe.summary ?? null,
      diagnosticId: terminalStreamError?.safe.diagnosticId ?? null
    }
  });

  sendJson(socket, { type: "assistant_message", requestId, message: serializeMessage(message) });
  if (terminalStreamError) throw terminalStreamError;
  return { stopped };
};

const handleGenerate = async (socket, raw) => {
  const parsed = generationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid generation request" });
    return;
  }
  const request = parsed.data;
  const abortController = new AbortController();
  if (!await claimMobileRequest(socket, { requestId: request.requestId, operation: "generate", chatId: request.chatId, overrideHardBudget: request.overrideHardBudget })) return;
  controllers.set(request.requestId, abortController);

  try {
    const chat = getActiveChat(request.chatId);
    if (!chat) throw notFound("Chat not found");
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const userMessage = await store.createMessageWithDraft({
      chatId: request.chatId,
      role: "user",
      content: request.content,
      variants: [],
      activeVariantIndex: 0
    }, request.draftId);
    sendJson(socket, {
      type: "user_message",
      requestId: request.requestId,
      message: serializeMessage(userMessage)
    });
    const result = await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: request.chatId,
      abortController
    });
    if (!result.stopped) try {
      const settings = store.getSettings();
      const updatedChat = await updateUserProfileFromChat({
        chatId: request.chatId,
        settings
      });
      const memorySummary = await updateChatMemoriesFromTurn({
        chatId: request.chatId,
        settings
      });
      if (updatedChat) {
        sendJson(socket, {
          type: "user_profile_updated",
          requestId: request.requestId,
          summary: updatedChat.userProfileSummary,
          updatedAt: updatedChat.userProfileUpdatedAt ?? null
        });
      }
      if (memorySummary && memorySummary.created + memorySummary.updated + memorySummary.disabled > 0) {
        sendJson(socket, {
          type: "chat_memory_updated",
          requestId: request.requestId,
          summary: memorySummary
        });
      }
    } catch {
      // Best-effort memory maintenance must not break chat generation.
    }
    sendJson(socket, { type: result.stopped ? "generation_stopped" : "generation_done", requestId: request.requestId });
  } catch (error) {
    if (abortController.signal.aborted) sendJson(socket, { type: "generation_stopped", requestId: request.requestId });
    else await sendSafeMobileError(socket, request.requestId, error, store.getSettings());
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleRegenerate = async (socket, raw) => {
  const parsed = regenerateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid regenerate request" });
    return;
  }
  const request = parsed.data;
  const target = store.getMessage(request.messageId);
  if (!target || target.role !== "assistant" || !getActiveChat(target.chatId)) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "Assistant message not found" });
    return;
  }
  const abortController = new AbortController();
  if (!await claimMobileRequest(socket, { requestId: request.requestId, operation: "regenerate", messageId: target.id, chatId: target.chatId, overrideHardBudget: request.overrideHardBudget })) return;
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const result = await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      targetMessageId: target.id,
      excludeMessageIds: [target.id],
      regenerationGuidance: request.guidance,
      regenerationTargetContent: target.content,
      abortController
    });
    sendJson(socket, { type: result.stopped ? "generation_stopped" : "generation_done", requestId: request.requestId });
  } catch (error) {
    await sendSafeMobileError(socket, request.requestId, error, store.getSettings(), false, abortController.signal.aborted);
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleContinue = async (socket, raw) => {
  const parsed = continueRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid continue request" });
    return;
  }

  const request = parsed.data;
  const target = store.getMessage(request.messageId);
  if (!target || target.role !== "assistant" || !getActiveChat(target.chatId)) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "Assistant message not found" });
    return;
  }
  if (store.listMessages(target.chatId).at(-1)?.id !== target.id) {
    sendJson(socket, {
      type: "error",
      requestId: request.requestId,
      error: "Only the latest assistant message can be continued"
    });
    return;
  }

  const abortController = new AbortController();
  if (!await claimMobileRequest(socket, { requestId: request.requestId, operation: "continue", messageId: target.id, chatId: target.chatId, overrideHardBudget: request.overrideHardBudget })) return;
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const result = await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      continuationTargetMessageId: target.id,
      abortController
    });
    sendJson(socket, { type: result.stopped ? "generation_stopped" : "generation_done", requestId: request.requestId });
  } catch (error) {
    await sendSafeMobileError(socket, request.requestId, error, store.getSettings(), false, abortController.signal.aborted);
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleResend = async (socket, raw) => {
  const parsed = resendRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid resend request" });
    return;
  }
  const request = parsed.data;
  const target = store.getMessage(request.messageId);
  if (!target || target.role !== "user" || !getActiveChat(target.chatId)) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "User message not found" });
    return;
  }
  const abortController = new AbortController();
  if (!await claimMobileRequest(socket, { requestId: request.requestId, operation: "resend", messageId: target.id, chatId: target.chatId, overrideHardBudget: request.overrideHardBudget })) return;
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const { userMessage } = await store.prepareUserMessageResend(target);
    sendJson(socket, { type: "user_message", requestId: request.requestId, message: serializeMessage(userMessage) });
    const result = await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      abortController
    });
    if (!result.stopped) try {
      const settings = store.getSettings();
      const updatedChat = await updateUserProfileFromChat({
        chatId: target.chatId,
        settings
      });
      const memorySummary = await updateChatMemoriesFromTurn({
        chatId: target.chatId,
        settings
      });
      if (updatedChat) {
        sendJson(socket, {
          type: "user_profile_updated",
          requestId: request.requestId,
          summary: updatedChat.userProfileSummary,
          updatedAt: updatedChat.userProfileUpdatedAt ?? null
        });
      }
      if (memorySummary && memorySummary.created + memorySummary.updated + memorySummary.disabled > 0) {
        sendJson(socket, {
          type: "chat_memory_updated",
          requestId: request.requestId,
          summary: memorySummary
        });
      }
    } catch {
      // Best-effort memory maintenance must not break chat generation.
    }
    sendJson(socket, { type: result.stopped ? "generation_stopped" : "generation_done", requestId: request.requestId });
  } catch (error) {
    await sendSafeMobileError(socket, request.requestId, error, store.getSettings(), false, abortController.signal.aborted);
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleStop = (socket, raw) => {
  const parsed = stopGenerationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid stop request" });
    return;
  }
  controllers.get(parsed.data.requestId)?.abort();
};

const handleMobileStatus = (socket, raw) => {
  const parsed = generationStatusRequestSchema.safeParse(raw);
  if (!parsed.success) return sendJson(socket, { type: "error", error: "Invalid generation status request" });
  const request = store.getModelRequest(parsed.data.requestId);
  if (!request) return sendJson(socket, { type: "error", requestId: parsed.data.requestId, error: "Generation request not found" });
  sendJson(socket, { type: "generation_status", request: { ...request, requestId: request.id } });
};

const startServer = async () => {
  await store.load();
  const draftCleanupTimer = setInterval(() => {
    void store.cleanupExpiredDraftAttachments().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
  draftCleanupTimer.unref();
  process.env.STAR_COMPANION_APP_VERSION = generatedBuildInfo.appVersion;
  process.env.STAR_COMPANION_PLATFORM = "android";
  process.env.STAR_COMPANION_BUILD_TYPE = mobileBuildType;
  if (mobileExternalUpdateUrl) process.env.STAR_COMPANION_ANDROID_STORE_URL = mobileExternalUpdateUrl;
  process.env.STAR_COMPANION_MIGRATION_REPORT = JSON.stringify(store.migrationReport);
  await encryptLegacyProviderKeys();
  const httpServer = createServer(app);
  const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });
  closeMobileSocketsForPrivacy = () => {
    for (const client of wsServer.clients) client.close(4403, "App locked");
  };

  wsServer.on("connection", (socket) => {
    if (privacyPasscodeDigest) { socket.close(4403, "App locked"); return; }
    sendJson(socket, { type: "ready", app: APP_NAME });
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "generate") void handleGenerate(socket, parsed);
        else if (parsed.type === "regenerate") void handleRegenerate(socket, parsed);
        else if (parsed.type === "continue") void handleContinue(socket, parsed);
        else if (parsed.type === "resend") void handleResend(socket, parsed);
        else if (parsed.type === "stop") handleStop(socket, parsed);
        else if (parsed.type === "status") handleMobileStatus(socket, parsed);
        else sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
      } catch {
        sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
      }
    });
  });

  httpServer.on("error", (error) => {
    console.error(`${APP_NAME} server error`, typeof error?.code === "string" ? error.code : "SERVER_ERROR");
  });

  httpServer.listen(port, host, () => {
    console.log(`${APP_NAME} listening on http://${host}:${port}`);
  });
};

startServer().catch((error) => {
  const code = typeof error?.code === "string" ? error.code : error?.name || "STARTUP_FAILED";
  console.error(`${APP_NAME} failed to start`, code);
  process.env.STAR_COMPANION_APP_VERSION = generatedBuildInfo.appVersion;
  process.env.STAR_COMPANION_PLATFORM = "android";
  process.env.STAR_COMPANION_MIGRATION_REPORT = JSON.stringify({
    status: code === "SCHEMA_TOO_NEW" || code === "APP_TOO_OLD" ? "too_new" : "failed",
    previousAppVersion: null,
    previousSchemaVersion: null,
    appliedMigrations: [],
    recoveryCreated: code === "MIGRATION_FAILED"
  });
  const recoveryApp = express();
  recoveryApp.use(cors({ origin: true, credentials: true }));
  recoveryApp.get("/api/health", (_request, response) => response.status(503).json({ ok: false, app: APP_NAME, database: "upgrade_failed", code }));
  recoveryApp.get("/api/app/info", (_request, response) => response.json({ ok: true, data: getAppInfo() }));
  recoveryApp.use("/api", (_request, response) => response.status(503).json({ ok: false, error: "The local database could not be opened safely. Update the app or restore the app-private upgrade-recovery copy." }));
  recoveryApp.listen(port, host, () => console.log(`${APP_NAME} recovery status available on port ${port}`));
});
