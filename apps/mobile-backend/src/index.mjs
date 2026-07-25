import cors from "cors";
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  backupImportSchema,
  characterBatchDeleteSchema,
  characterBatchFetchSchema,
  characterBatchTagsSchema,
  characterCreateSchema,
  characterDuplicateSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUnlockSchema,
  characterUpdateRequestSchema,
  chatAgentDraftSchema,
  chatArchiveImportSchema,
  chatBatchArchiveSchema,
  chatBatchPermanentDeleteSchema,
  chatBatchTrashSchema,
  chatBranchSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMessageSearchQuerySchema,
  chatMemoryUpdateSchema,
  chatUpdateSchema,
  continueRequestSchema,
  imageGenerationSchema,
  generationRequestSchema,
  messageCreateSchema,
  messageListQuerySchema,
  messageUpdateSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema,
  userProfileUpdateSchema,
  voiceSpeechSchema,
  voiceTranscriptionSchema,
  settingsUpdateSchema,
  lanSyncRequestSchema
} from "../server-dist/schemas.js";
import { applyCharacterTagOperation } from "../server-dist/services/characterTags.js";
import {
  decryptApiKey,
  encryptApiKey,
  hasStoredApiKey,
  isEncryptedApiKey
} from "../server-dist/services/apiKeyVault.js";
import {
  completeChatCompletion,
  estimateTokenUsage,
  fetchAvailableModels,
  streamChatCompletion,
  testModelConnection
} from "../server-dist/services/completions.js";
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
    .filter((entry) => entry?.enabled !== false)
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
    const raw = await completeChatCompletion({
      settings: moduleSettings,
      messages: buildMemoryRerankMessages(queryText, candidates),
      maxTokens: 180,
      temperature: 0
    });
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
  const candidates = store
    .listMemories(chatId)
    .filter((memory) => memory.enabled !== false)
    .map((memory) => toMatchedMemoryEntry(memory, scoreMemory(memory, queryText, queryTokens)))
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

  const recentContents = store
    .listMessages(chatId)
    .filter((message) => message.role === "user")
    .slice(-RECENT_PROFILE_MESSAGE_LIMIT)
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (recentContents.length === 0) return null;

  const summary = (
    await completeChatCompletion({
      settings: resolveModuleSettings(settings, "user_profile"),
      messages: buildUserProfileSummaryMessages(chat.userProfileSummary ?? "", recentContents),
      maxTokens: 500,
      temperature: 0.2
    })
  )
    .trim()
    .slice(0, MAX_PROFILE_LENGTH);

  if (!summary || summary === chat.userProfileSummary) return null;

  return store.updateChat(chatId, {
    userProfileSummary: summary,
    userProfileUpdatedAt: new Date().toISOString()
  });
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

  const existingMemories = store.listMemories(chatId).slice(0, EXISTING_MEMORY_LIMIT);
  const raw = await completeChatCompletion({
    settings: resolveModuleSettings(settings, "memory"),
    messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages),
    maxTokens: 1600,
    temperature: 0.2
  });
  const actions = parseMemoryActions(raw.trim());
  if (!actions) return null;
  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const sourceMessageIds = recentMessages.map((message) => message.id);
  let created = 0;
  let updated = 0;
  let disabled = 0;

  for (const action of actions.slice(0, 8)) {
    if (action.type === "create") {
      await store.createMemory({
        chatId,
        title: action.title,
        content: action.content,
        keywords: action.keywords,
        importance: action.importance,
        enabled: true,
        sourceMessageIds
      });
      created += 1;
      continue;
    }

    if (!existingIds.has(action.id)) continue;
    await store.updateMemory(
      chatId,
      action.id,
      dropUndefined({
        title: action.title,
        content: action.content,
        keywords: action.keywords,
        importance: action.importance,
        enabled: action.enabled,
        sourceMessageIds
      })
    );
    updated += 1;
    if (action.enabled === false) disabled += 1;
  }

  const updatedAt = new Date().toISOString();
  await store.updateChat(chatId, { memoryUpdatedAt: updatedAt });
  return {
    chatId,
    created,
    updated,
    disabled,
    memoryUpdatedAt: updatedAt
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

const serializeChat = (chat, messageCount = chat.messageCount ?? 0) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId ?? null,
  parentChatId: chat.parentChatId ?? null,
  branchSourceMessageId: chat.branchSourceMessageId ?? null,
  isCheckpoint: chat.isCheckpoint === true,
  isPinned: chat.isPinned === true,
  isArchived: chat.isArchived === true,
  deletedAt: chat.deletedAt ?? null,
  backgroundUrl: chat.backgroundUrl ?? "",
  messageCount,
  memoryTurns: chat.memoryTurns ?? 12,
  autoMemoryEnabled: chat.autoMemoryEnabled !== false,
  memoryUpdatedAt: chat.memoryUpdatedAt ?? null,
  userPersona: chat.userPersona ?? "",
  userProfileSummary: chat.userProfileSummary ?? "",
  userProfileUpdatedAt: chat.userProfileUpdatedAt ?? null,
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
  sourceMessageIds: toStringArray(memory.sourceMessageIds),
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
  contextIncluded: message.contextIncluded !== false,
  isBookmarked: message.isBookmarked === true,
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex ?? 0,
  tokenUsage: message.tokenUsage ?? null,
  loreMatches: Array.isArray(message.loreMatches) ? message.loreMatches : [],
  memoryMatches: Array.isArray(message.memoryMatches) ? message.memoryMatches : [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt
});

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
  user_profile: "text_generation",
  voice_transcription: "audio_transcription",
  voice_speech: "text_to_speech",
  image_generation: "image_generation"
};

const inferModelCapabilities = (model) => {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (/(^|[-_/])(?:whisper|transcribe|stt)(?:[-_/]|$)/.test(normalized)) {
    return ["audio_transcription"];
  }
  if (/(^|[-_/])(?:tts|speech)(?:[-_/]|$)/.test(normalized)) {
    return ["text_to_speech"];
  }
  if (/(?:dall[\-_.]?e|gpt[\-_.]?image|imagegen|stable[\-_.]?diffusion|(?:^|[-_/])sdxl?(?:[-_/]|$)|flux)/.test(normalized)) {
    return ["image_generation"];
  }
  return ["text_generation"];
};

const getModelCapabilities = (model) =>
  Array.isArray(model?.capabilities) ? model.capabilities : inferModelCapabilities(model?.model);

const supportsModule = (provider, model, moduleId) => {
  const isMediaModule = ["voice_transcription", "voice_speech", "image_generation"].includes(moduleId);
  if (isMediaModule && normalizeProviderKind(provider?.provider) !== "openai-compatible") {
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
  if (!provider || !model) return settings;
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

const transcribeAudio = async ({ settings, audioBase64, mimeType, filename }) => {
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
    body: form
  });
  if (!response.ok) throw new Error(await readModelError(response));
  const payload = await response.json();
  return { text: String(payload.text ?? "").trim(), model: settings.model, createdAt: new Date().toISOString() };
};

const createSpeechAudio = async ({ settings, text, voice, format }) => {
  assertOpenAiCompatible(settings, "Text to speech");
  const response = await fetch(joinApiPath(settings.apiBaseUrl, "audio/speech"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({ model: settings.model, input: text, voice, response_format: format })
  });
  if (!response.ok) throw new Error(await readModelError(response));
  return {
    audioBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
    mimeType: response.headers.get("content-type") || `audio/${format}`,
    model: settings.model,
    createdAt: new Date().toISOString()
  };
};

const generateImage = async ({ settings, prompt, size }) => {
  assertOpenAiCompatible(settings, "Image generation");
  const response = await fetch(joinApiPath(settings.apiBaseUrl, "images/generations"), {
    method: "POST",
    headers: openAiHeaders(settings),
    body: JSON.stringify({ model: settings.model, prompt, n: 1, size, response_format: "b64_json" })
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
  const characterPrompt = buildCharacterSystemPrompt(characterPromptFields, matchedLoreEntries);

  if (characterPrompt) {
    messages.push({ role: "system", content: characterPrompt });
  }
  if (chat.userPersona?.trim()) {
    messages.push({ role: "system", content: chat.userPersona.trim() });
  }
  if (chat.userProfileSummary?.trim()) {
    messages.push({ role: "system", content: `User profile:\n${chat.userProfileSummary.trim()}` });
  }
  const memoryPrompt = formatMemorySystemPrompt(matchedMemoryEntries);
  if (memoryPrompt) {
    messages.push({ role: "system", content: memoryPrompt });
  }
  for (const message of recentMessages) {
    if (message.role === "system") continue;
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    });
  }

  return { chat, messages, matchedLoreEntries, matchedMemoryEntries };
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
      "Keep the drafts distinct in tone or strategy."
    ].join("\n")
  },
  memory_lore_candidates: {
    title: "Memory and Lore Candidates",
    instruction: [
      "Identify candidate notes that the user may later save manually.",
      "Separate durable chat memory candidates from character embedded lore candidates.",
      "Do not claim anything was saved. Do not propose standalone lorebook or worldbook structures."
    ].join("\n")
  }
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

  const settings = resolveModuleSettings(store.getSettings(), "agent");
  const context = await getPromptContext({ chatId });
  const content = (
    await completeChatCompletion({
      settings,
      messages: buildAgentDraftMessages(context.messages, mode, focus),
      maxTokens: Math.min(settings.maxTokens, 900),
      temperature: Math.min(settings.temperature, 0.4)
    })
  ).trim();

  if (!content) {
    throw new Error("Agent returned an empty draft.");
  }

  return {
    mode,
    title: agentModeConfig[mode].title,
    content,
    createdAt: new Date().toISOString(),
    matchedLoreEntries: context.matchedLoreEntries,
    matchedMemoryEntries: context.matchedMemoryEntries
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

  const settings = resolveModuleSettings(store.getSettings(), "chat");
  const title = normalizeTitleSuggestion(
    await completeChatCompletion({
      settings,
      messages: buildTitleSuggestionMessages(messages),
      maxTokens: Math.min(settings.maxTokens, 80),
      temperature: Math.min(settings.temperature, 0.25)
    })
  );
  if (!title) throw new Error("Model returned an empty title suggestion");

  return { title, createdAt: new Date().toISOString() };
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

  const settings = resolveModuleSettings(store.getSettings(), "chat");
  const context = await getPromptContext({ chatId });
  const messages = [...context.messages, openingInstruction];
  const content = (
    await completeChatCompletion({
      settings,
      messages,
      maxTokens: Math.min(settings.maxTokens, 700),
      temperature: Math.min(settings.temperature, 0.7)
    })
  ).trim();

  if (!content) {
    throw new Error("Model returned an empty opening message");
  }

  const message = await store.createMessage({
    chatId,
    role: "assistant",
    characterId: chat.characterId,
    content,
    variants: [content],
    activeVariantIndex: 0,
    tokenUsage: estimateTokenUsage(messages, content),
    loreMatches: context.matchedLoreEntries,
    memoryMatches: context.matchedMemoryEntries
  });

  return serializeMessage(message);
};

const exportChatArchive = (chatId) => {
  const chat = getActiveChat(chatId);
  if (!chat) throw notFound("Chat not found");
  const character = chat.characterId ? store.getCharacter(chat.characterId) : null;
  return {
    archiveVersion: 1,
    exportedAt: new Date().toISOString(),
    chat: serializeChat(chat, store.listMessages(chatId).length),
    character,
    messages: store.listMessages(chatId).map(serializeMessage),
    memories: store.listMemories(chatId).map(serializeMemory)
  };
};

const importChatArchive = async ({ archive, title }) => {
  let characterId = null;
  if (archive.character) {
    const existing = store.listCharacters().find((character) => character.cardId === archive.character.cardId);
    if (existing) {
      characterId = existing.id;
    } else {
      characterId = (await store.createCharacter(archive.character)).id;
    }
  }
  const chat = await store.createChat({
    title: title ?? archive.chat.title,
    characterId,
    isCheckpoint: archive.chat.isCheckpoint === true,
    backgroundUrl: archive.chat.backgroundUrl,
    memoryTurns: archive.chat.memoryTurns,
    autoMemoryEnabled: archive.chat.autoMemoryEnabled,
    userPersona: archive.chat.userPersona,
    userProfileSummary: archive.chat.userProfileSummary
  });
  const messageIds = new Map();
  for (const source of archive.messages) {
    const { id: sourceId, ...messageInput } = source;
    const message = await store.createMessage({
      ...messageInput,
      chatId: chat.id,
      characterId: source.characterId ? characterId : null
    });
    if (sourceId) messageIds.set(sourceId, message.id);
  }
  for (const source of archive.memories) {
    const { id: _sourceId, ...memoryInput } = source;
    await store.createMemory({
      ...memoryInput,
      chatId: chat.id,
      sourceMessageIds: (source.sourceMessageIds ?? []).map((id) => messageIds.get(id)).filter(Boolean)
    });
  }
  return {
    ...serializeChat(chat, store.listMessages(chat.id).length),
    messages: store.listMessages(chat.id).map(serializeMessage),
    memories: store.listMemories(chat.id).map(serializeMemory)
  };
};

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    app: APP_NAME,
    database: "sqlite",
    timestamp: new Date().toISOString()
  });
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
  response.json({ ok: true, data: store.listChats().map((chat) => serializeChat(chat, chat.messageCount)) });
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
    const memory = await store.createMemory({ ...body, chatId });
    response.status(201).json({ ok: true, data: serializeMemory(memory) });
  })
);

app.put(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const memory = await store.updateMemory(
      chatId,
      requireParam(request, "memoryId"),
      body
    );
    if (!memory) throw notFound("Memory not found");
    response.json({ ok: true, data: serializeMemory(memory) });
  })
);

app.delete(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!getActiveChat(chatId)) throw notFound("Chat not found");
    const deleted = await store.deleteMemory(chatId, requireParam(request, "memoryId"));
    if (!deleted) throw notFound("Memory not found");
    response.status(204).send();
  })
);

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
      backgroundUrl: chat.backgroundUrl,
      memoryTurns: chat.memoryTurns,
      autoMemoryEnabled: chat.autoMemoryEnabled,
      userPersona: chat.userPersona,
      userProfileSummary: chat.userProfileSummary,
      userProfileUpdatedAt: chat.userProfileUpdatedAt
    });

    for (const message of messages.slice(0, targetIndex + 1)) {
      await store.createMessage({
        chatId: branch.id,
        role: message.role,
        characterId: message.characterId,
        content: message.content,
        contextIncluded: message.contextIncluded !== false,
        isBookmarked: message.isBookmarked === true,
        variants: message.variants,
        activeVariantIndex: message.activeVariantIndex,
        tokenUsage: message.tokenUsage,
        loreMatches: message.loreMatches,
        memoryMatches: message.memoryMatches,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      });
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
    const chat = await store.updateChat(id, body);
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
    const message = await store.createMessage(body);
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
    const message = await store.updateMessage(id, body);
    if (!message) throw notFound("Message not found");
    response.json({ ok: true, data: serializeMessage(message) });
  })
);

app.delete(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = store.getMessage(id);
    if (!existing || !getActiveChat(existing.chatId)) throw notFound("Message not found");
    const message = await store.deleteMessage(id);
    if (!message) throw notFound("Message not found");
    response.status(204).send();
  })
);

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
    const moduleModelError = validateModuleModelPreferences(
      body.providers,
      moduleModelPreferences,
      body.activeProviderId,
      body.activeModelId
    );
    if (moduleModelError) throw httpError(400, moduleModelError);
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
  response.json({ ok: true, data: await testModelConnection(store.getSettings()) });
}));

app.get("/api/settings/models", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await fetchAvailableModels(store.getSettings()) });
}));

app.post(
  "/api/media/voice/transcriptions",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceTranscriptionSchema, request.body);
    const settings = resolveModuleSettings(store.getSettings(), "voice_transcription");
    response.json({ ok: true, data: await transcribeAudio({ settings, ...body }) });
  })
);

app.post(
  "/api/media/voice/speech",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceSpeechSchema, request.body);
    const settings = resolveModuleSettings(store.getSettings(), "voice_speech");
    response.json({ ok: true, data: await createSpeechAudio({ settings, ...body }) });
  })
);

app.post(
  "/api/media/images/generations",
  asyncHandler(async (request, response) => {
    const body = parseBody(imageGenerationSchema, request.body);
    const settings = resolveModuleSettings(store.getSettings(), "image_generation");
    response.json({ ok: true, data: await generateImage({ settings, ...body }) });
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
  "/api/backups/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupImportSchema, request.body);
    response.json({ ok: true, data: await store.importBackup(backup) });
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
    const backup = parseBody(backupImportSchema, { ...peerBackup, mode: input.mode });
    const summary = await store.importBackup(backup);

    response.json({
      ok: true,
      data: {
        direction: "pull",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: peerBackup.exportedAt ?? null,
        completedAt: new Date().toISOString(),
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
    const summary = await requestPeer(peerBaseUrl, "/api/backups/import", {
      method: "POST",
      body: JSON.stringify({ ...localBackup, mode: input.mode })
    });

    response.json({
      ok: true,
      data: {
        direction: "push",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: null,
        completedAt: new Date().toISOString(),
        summary
      }
    });
  })
);

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  response.status(status).json({
    ok: false,
    error: error instanceof Error ? error.message : "Internal server error"
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

const appendAssistantContinuation = async ({
  targetMessage,
  continuation,
  tokenUsage,
  loreMatches,
  memoryMatches
}) => {
  const content = joinAssistantContinuation(targetMessage.content, continuation);
  const variants = toStringArray(targetMessage.variants);
  const activeVariantIndex = Math.min(
    Math.max(targetMessage.activeVariantIndex ?? 0, 0),
    Math.max(variants.length - 1, 0)
  );
  if (variants.length === 0) variants.push(content);
  else variants[activeVariantIndex] = content;

  return store.updateMessage(targetMessage.id, {
    content,
    variants,
    activeVariantIndex,
    tokenUsage,
    loreMatches,
    memoryMatches
  });
};

const createAssistantReply = async ({
  socket,
  requestId,
  chatId,
  targetMessageId,
  excludeMessageIds = [],
  continuationTargetMessageId,
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

  const completionMessages = continuationTargetMessageId
    ? [
        ...context.messages,
        {
          role: "user",
          content:
            "Continue the immediately preceding assistant reply from its exact ending. Return only the continuation, without repeating or summarizing any existing text."
        }
      ]
    : context.messages;
  let content = "";
  let tokenUsage = null;
  let stopped = false;
  try {
    for await (const event of streamChatCompletion({
      settings: resolveModuleSettings(store.getSettings(), "chat"),
      messages: completionMessages,
      signal: abortController.signal
    })) {
      if (event.type === "usage") {
        tokenUsage = event.usage;
        continue;
      }
      content += event.content;
      sendJson(socket, { type: "token", requestId, content: event.content });
    }
  } catch (error) {
    if (abortController.signal.aborted) stopped = true;
    else throw error;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    if (stopped) return { stopped };
    throw new Error("Model returned an empty response");
  }

  tokenUsage ??= estimateTokenUsage(completionMessages, trimmed);
  const message = continuationTargetMessageId
    ? await appendAssistantContinuation({
        targetMessage,
        continuation: trimmed,
        tokenUsage,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
      })
    : targetMessageId
    ? await store.updateMessage(targetMessageId, {
        content: trimmed,
        variants: appendVariant(targetMessage.variants, trimmed),
        activeVariantIndex: appendVariant(targetMessage.variants, trimmed).length - 1,
        tokenUsage,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
      })
    : await store.createMessage({
        chatId,
        role: "assistant",
        characterId: context.chat.characterId,
        content: trimmed,
        variants: [trimmed],
        activeVariantIndex: 0,
        tokenUsage,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
      });

  sendJson(socket, { type: "assistant_message", requestId, message: serializeMessage(message) });
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
  controllers.set(request.requestId, abortController);

  try {
    const chat = getActiveChat(request.chatId);
    if (!chat) throw notFound("Chat not found");
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const userMessage = await store.createMessage({
      chatId: request.chatId,
      role: "user",
      content: request.content,
      variants: [],
      activeVariantIndex: 0
    });
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
    sendJson(socket, {
      type: abortController.signal.aborted ? "generation_stopped" : "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : "Generation failed"
    });
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
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const result = await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      targetMessageId: target.id,
      excludeMessageIds: [target.id],
      abortController
    });
    sendJson(socket, { type: result.stopped ? "generation_stopped" : "generation_done", requestId: request.requestId });
  } catch (error) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: error.message });
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
    sendJson(socket, {
      type: "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : "Continue failed"
    });
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
  controllers.set(request.requestId, abortController);
  try {
    await store.deleteMessagesAfter(target);
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const userMessage = await store.createMessage({
      chatId: target.chatId,
      role: "user",
      content: target.content,
      variants: [],
      activeVariantIndex: 0
    });
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
    sendJson(socket, { type: "error", requestId: request.requestId, error: error.message });
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

const startServer = async () => {
  await store.load();
  await encryptLegacyProviderKeys();
  const httpServer = createServer(app);
  const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });

  wsServer.on("connection", (socket) => {
    sendJson(socket, { type: "ready", app: APP_NAME });
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "generate") void handleGenerate(socket, parsed);
        else if (parsed.type === "regenerate") void handleRegenerate(socket, parsed);
        else if (parsed.type === "continue") void handleContinue(socket, parsed);
        else if (parsed.type === "resend") void handleResend(socket, parsed);
        else if (parsed.type === "stop") handleStop(socket, parsed);
        else sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
      } catch {
        sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
      }
    });
  });

  httpServer.on("error", (error) => {
    console.error(`${APP_NAME} server error`, error);
  });

  httpServer.listen(port, host, () => {
    console.log(`${APP_NAME} listening on http://${host}:${port}`);
  });
};

startServer().catch((error) => {
  console.error(`${APP_NAME} failed to start`, error);
});
