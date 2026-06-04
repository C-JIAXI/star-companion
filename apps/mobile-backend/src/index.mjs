import cors from "cors";
import express from "express";
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
  characterCreateSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUnlockSchema,
  characterUpdateRequestSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMemoryUpdateSchema,
  chatUpdateSchema,
  generationRequestSchema,
  messageCreateSchema,
  messageListQuerySchema,
  messageUpdateSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema,
  userProfileUpdateSchema,
  settingsUpdateSchema,
  lanSyncRequestSchema
} from "../server-dist/schemas.js";
import { encryptApiKey, hasStoredApiKey } from "../server-dist/services/apiKeyVault.js";
import {
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

const toStringArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

const dropUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([_key, entry]) => entry !== undefined));

const serializeSettings = (settings) => ({
  id: settings.id,
  activeProvider: settings.activeProvider,
  apiBaseUrl: settings.apiBaseUrl,
  model: settings.model,
  temperature: settings.temperature,
  maxTokens: settings.maxTokens,
  topP: settings.topP,
  language: settings.language === "en" ? "en" : "zh-CN",
  providers: Array.isArray(settings.providers) ? settings.providers : [],
  activeProviderId: settings.activeProviderId ?? "",
  activeModelId: settings.activeModelId ?? "",
  userProfileSummary: settings.userProfileSummary ?? "",
  autoSummarizeUser: settings.autoSummarizeUser !== false,
  showMessageAvatars: settings.showMessageAvatars !== false,
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
    visibility: resolved.visibility,
    canViewPrompt: resolved.canViewPrompt
  };
};

const serializeChat = (chat, messageCount = chat.messageCount ?? 0) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId ?? null,
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
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex ?? 0,
  tokenUsage: message.tokenUsage ?? null,
  loreMatches: Array.isArray(message.loreMatches) ? message.loreMatches : [],
  memoryMatches: Array.isArray(message.memoryMatches) ? message.memoryMatches : [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt
});

const publicSettings = (settings) => ({
  ...serializeSettings(settings),
  hasApiKey: hasStoredApiKey(settings.apiKey)
});

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

const getPromptContext = ({ chatId, before, excludeMessageIds = [] }) => {
  const chat = store.getChat(chatId);
  if (!chat) {
    throw notFound("Chat not found");
  }

  const character = chat.characterId ? store.getCharacter(chat.characterId) : null;
  const recentMessages = store
    .listMessages(chatId)
    .filter((message) => !before || new Date(message.createdAt) < before)
    .filter((message) => !excludeMessageIds.includes(message.id))
    .slice(-(Math.max(1, Math.min(chat.memoryTurns ?? 12, 50)) * 2 + 1));

  const messages = [];
  const characterPromptFields = character ? resolveCharacterPromptFields(character) : null;
  const characterPrompt = characterPromptFields
    ? [characterPromptFields.prefix, characterPromptFields.prompt, characterPromptFields.suffix]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join("\n\n")
    : "";

  if (characterPrompt) {
    messages.push({ role: "system", content: characterPrompt });
  }
  if (chat.userPersona?.trim()) {
    messages.push({ role: "system", content: chat.userPersona.trim() });
  }
  if (chat.userProfileSummary?.trim()) {
    messages.push({ role: "system", content: `User profile:\n${chat.userProfileSummary.trim()}` });
  }
  for (const message of recentMessages) {
    if (message.role === "system") continue;
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    });
  }

  return { chat, messages, matchedLoreEntries: [], matchedMemoryEntries: [] };
};

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

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
    const all = store
      .listCharacters()
      .filter((character) =>
        normalizedQ
          ? [character.name, character.description, character.prompt]
              .join("\n")
              .toLowerCase()
              .includes(normalizedQ)
          : true
      )
      .filter((character) =>
        normalizedTag ? toStringArray(character.tags).some((tag) => tag.toLowerCase() === normalizedTag) : true
      );
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const start = (page - 1) * query.pageSize;
    const availableTags = [
      ...new Set(
        store
          .listCharacters()
          .flatMap((character) => toStringArray(character.tags))
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));

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

app.get("/api/chats/:id/memories", (request, response) => {
  const chatId = requireParam(request, "id");
  if (!store.getChat(chatId)) throw notFound("Chat not found");
  response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
});

app.post(
  "/api/chats/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!store.getChat(chatId)) throw notFound("Chat not found");
    const body = parseBody(chatMemoryCreateSchema, request.body);
    const memory = await store.createMemory({ ...body, chatId });
    response.status(201).json({ ok: true, data: serializeMemory(memory) });
  })
);

app.put(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const memory = await store.updateMemory(
      requireParam(request, "id"),
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
    const deleted = await store.deleteMemory(requireParam(request, "id"), requireParam(request, "memoryId"));
    if (!deleted) throw notFound("Memory not found");
    response.status(204).send();
  })
);

app.post("/api/chats/:id/memories/refresh", (request, response) => {
  const chatId = requireParam(request, "id");
  if (!store.getChat(chatId)) throw notFound("Chat not found");
  response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
});

app.get("/api/chats/:id", (request, response) => {
  const chat = store.getChat(requireParam(request, "id"));
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

app.put(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatUpdateSchema, request.body);
    const chat = await store.updateChat(requireParam(request, "id"), body);
    if (!chat) throw notFound("Chat not found");
    response.json({ ok: true, data: serializeChat(chat) });
  })
);

app.delete(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const deleted = await store.deleteChat(requireParam(request, "id"));
    if (!deleted) throw notFound("Chat not found");
    response.status(204).send();
  })
);

app.get("/api/messages", (request, response) => {
  const query = parseQuery(messageListQuerySchema, request.query);
  response.json({ ok: true, data: store.listMessages(query.chatId).map(serializeMessage) });
});

app.post(
  "/api/messages",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageCreateSchema, request.body);
    if (!store.getChat(body.chatId)) throw notFound("Chat not found");
    const message = await store.createMessage(body);
    response.status(201).json({ ok: true, data: serializeMessage(message) });
  })
);

app.get("/api/messages/:id", (request, response) => {
  const message = store.getMessage(requireParam(request, "id"));
  if (!message) throw notFound("Message not found");
  response.json({ ok: true, data: serializeMessage(message) });
});

app.put(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageUpdateSchema, request.body);
    const message = await store.updateMessage(requireParam(request, "id"), body);
    if (!message) throw notFound("Message not found");
    response.json({ ok: true, data: serializeMessage(message) });
  })
);

app.delete(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const message = await store.deleteMessage(requireParam(request, "id"));
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
    const activeProfile = body.providers.find((provider) => provider.id === body.activeProviderId);
    const activeModel = activeProfile?.models.find((model) => model.id === body.activeModelId);
    const resolvedApiKey =
      activeProfile?.key ?? (Object.hasOwn(body, "apiKey") ? body.apiKey : undefined);
    const settings = await store.updateSettings({
      providers: body.providers,
      activeProviderId: body.activeProviderId,
      activeModelId: body.activeModelId,
      activeProvider: activeProfile?.provider ?? body.activeProvider,
      apiBaseUrl: activeProfile?.apiBaseUrl ?? body.apiBaseUrl,
      model: activeModel?.model ?? body.model,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      autoSummarizeUser: body.autoSummarizeUser,
      showMessageAvatars: body.showMessageAvatars,
      userProfileSummary: body.userProfileSummary,
      userProfileUpdatedAt:
        typeof body.userProfileSummary === "string" ? new Date().toISOString() : undefined,
      ...(resolvedApiKey !== undefined ? { apiKey: encryptApiKey(resolvedApiKey) } : {})
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

app.post("/api/settings/providers/:providerId/models", asyncHandler(async (request, response) => {
  const settings = store.getSettings();
  const body = request.body;
  const provider =
    body && typeof body.apiBaseUrl === "string"
      ? { provider: body.provider ?? "", apiBaseUrl: body.apiBaseUrl, key: body.key }
      : (settings.providers ?? []).find((entry) => entry.id === request.params.providerId);
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

const createAssistantReply = async ({
  socket,
  requestId,
  chatId,
  targetMessageId,
  excludeMessageIds = [],
  abortController
}) => {
  const targetMessage = targetMessageId ? store.getMessage(targetMessageId) : null;
  const context = getPromptContext({
    chatId,
    before: targetMessage?.createdAt ? new Date(targetMessage.createdAt) : undefined,
    excludeMessageIds
  });
  sendJson(socket, { type: "lore_matches", requestId, entries: context.matchedLoreEntries });
  sendJson(socket, { type: "memory_matches", requestId, entries: context.matchedMemoryEntries });

  let content = "";
  let tokenUsage = null;
  for await (const event of streamChatCompletion({
    settings: store.getSettings(),
    messages: context.messages,
    signal: abortController.signal
  })) {
    if (event.type === "usage") {
      tokenUsage = event.usage;
      continue;
    }
    content += event.content;
    sendJson(socket, { type: "token", requestId, content: event.content });
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response");
  }

  tokenUsage ??= estimateTokenUsage(context.messages, trimmed);
  const message = targetMessageId
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
    const chat = store.getChat(request.chatId);
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
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: request.chatId,
      abortController
    });
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
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
  if (!target || target.role !== "assistant") {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "Assistant message not found" });
    return;
  }
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      targetMessageId: target.id,
      excludeMessageIds: [target.id],
      abortController
    });
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
  } catch (error) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: error.message });
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
  if (!target || target.role !== "user") {
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
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      abortController
    });
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
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

await store.load();
const httpServer = createServer(app);
const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });

wsServer.on("connection", (socket) => {
  sendJson(socket, { type: "ready", app: APP_NAME });
  socket.on("message", (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === "generate") void handleGenerate(socket, parsed);
      else if (parsed.type === "regenerate") void handleRegenerate(socket, parsed);
      else if (parsed.type === "resend") void handleResend(socket, parsed);
      else if (parsed.type === "stop") handleStop(socket, parsed);
      else sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
    } catch {
      sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
    }
  });
});

const port = Number(process.env.MOBILE_BACKEND_PORT ?? process.env.SERVER_PORT ?? 4110);
const host = process.env.MOBILE_BACKEND_HOST ?? "0.0.0.0";

httpServer.listen(port, host, () => {
  console.log(`${APP_NAME} listening on http://${host}:${port}`);
});
