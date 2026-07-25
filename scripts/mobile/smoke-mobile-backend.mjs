import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = 4111;
const modelPort = 4112;
const dataDir = await mkdtemp(path.join(os.tmpdir(), "star-companion-mobile-"));

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const readRawBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const createFakeModelServer = () => {
  let chatCompletionRequests = 0;
  let lastChatCompletionBody = null;

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "fake-mobile-model" }] }));
      return;
    }

    if (request.method === "POST" && request.url === "/audio/transcriptions") {
      await readRawBody(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: "mobile transcribed audio" }));
      return;
    }

    if (request.method === "POST" && request.url === "/audio/speech") {
      await readJsonBody(request);
      response.setHeader("Content-Type", "audio/mpeg");
      response.end(Buffer.from("mobile-audio"));
      return;
    }

    if (request.method === "POST" && request.url === "/images/generations") {
      await readJsonBody(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ b64_json: Buffer.from("mobile-image").toString("base64") }] }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const body = await readJsonBody(request);
    chatCompletionRequests += 1;
    lastChatCompletionBody = body;
    const joinedMessages = (body.messages ?? []).map((message) => message.content ?? "").join("\n\n");

    if (body.stream) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write('data: {"choices":[{"delta":{"content":"Mobile assistant reply."}}]}\n\n');
      response.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    let content = "Mobile assistant reply.";
    if (joinedMessages.includes("read-only context assistant")) {
      content = "Mobile agent draft: ask about the blue door hinge.";
    } else if (joinedMessages.includes("Generate a concise title for this local-first")) {
      content = '"Mobile Blue Door"';
    } else if (joinedMessages.includes("concise local user profile memory")) {
      content = "User likes blue doors.";
    } else if (joinedMessages.includes("long-term memories for one local-first")) {
      const existingId = joinedMessages.match(/id=([^\s]+)/)?.[1];
      content = JSON.stringify({
        actions: [
          existingId
            ? {
                type: "update",
                id: existingId,
                title: "Blue door preference",
                content: "The user wants blue door details remembered for this chat.",
                keywords: ["blue", "door"],
                importance: 4,
                enabled: true
              }
            : {
                type: "create",
                title: "Blue door preference",
                content: "The user wants blue door details remembered for this chat.",
                keywords: ["blue", "door"],
                importance: 4
              }
        ]
      });
    } else if (joinedMessages.includes("Select long-term chat memories")) {
      const id = joinedMessages.match(/id=([^\s]+)/)?.[1];
      content = JSON.stringify({ ids: id ? [id] : [] });
    }

    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(modelPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        close: () => server.close(),
        getChatCompletionRequests: () => chatCompletionRequests,
        getLastChatCompletionBody: () => lastChatCompletionBody
      });
    });
  });
};

const runSocketRequest = (input) =>
  new Promise((resolve, reject) => {
    const requestId = `mobile-smoke-${Date.now()}`;
    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for ${input.type}`));
    }, 10_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ ...input, requestId }));
    });
    socket.addEventListener("message", (raw) => {
      const event = JSON.parse(String(raw.data));
      events.push(event);
      if (event.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(event.error));
      }
      if (
        (event.type === "generation_done" || event.type === "generation_stopped") &&
        event.requestId === requestId
      ) {
        clearTimeout(timeout);
        socket.close();
        resolve(events);
      }
    });
    socket.addEventListener("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const runGeneration = (chatId, content) => runSocketRequest({ type: "generate", chatId, content });

const request = async (pathName, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  return body?.data ?? body;
};

const requestFailure = async (pathName, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (response.ok) {
    throw new Error(`Expected request to fail: ${pathName}`);
  }

  return { status: response.status, body };
};

const permanentlyDeleteChat = async (chatId) => {
  await request(`/api/chats/${chatId}`, { method: "DELETE" });
  await request(`/api/chats/${chatId}/permanent`, { method: "DELETE" });
};

const waitForHealth = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      return await request("/api/health");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for mobile backend health");
};

await new Promise((resolve, reject) => {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run build --prefix apps/server"]
      : ["run", "build", "--prefix", "apps/server"];
  const build = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit"
  });
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`server build failed: ${code}`))));
});

await new Promise((resolve, reject) => {
  const prepare = spawn("node", ["scripts/mobile/prepare-mobile-backend.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      MOBILE_BACKEND_SKIP_WEB_NODE_COPY: "1"
    },
    stdio: "inherit"
  });
  prepare.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`mobile backend prepare failed: ${code}`))
  );
});

const fakeModelServer = await createFakeModelServer();

const child = spawn("node", ["apps/mobile-backend/src/index.mjs"], {
  cwd: rootDir,
  env: {
    ...process.env,
    MOBILE_BACKEND_PORT: String(port),
    MOBILE_BACKEND_DATA_DIR: dataDir,
    API_KEY_ENCRYPTION_SECRET: "mobile-smoke-test-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.database, "sqlite");

  const modelSettings = {
    activeProvider: "openai-compatible",
    apiBaseUrl: `http://127.0.0.1:${modelPort}`,
    apiKey: "fake-mobile-key",
    model: "fake-mobile-model",
    temperature: 0.2,
    maxTokens: 120,
    topP: 1,
    language: "zh-CN",
    providers: [
      {
        id: "mobile-provider",
        label: "Mobile Smoke Provider",
        provider: "openai-compatible",
        apiBaseUrl: `http://127.0.0.1:${modelPort}`,
        key: "mobile-provider-key",
        models: [
          { id: "mobile-chat", label: "Chat", model: "fake-mobile-model", capabilities: ["text_generation"] },
          { id: "mobile-stt", label: "Transcription", model: "fake-mobile-transcribe", capabilities: ["audio_transcription"] },
          { id: "mobile-tts", label: "Speech", model: "fake-mobile-tts", capabilities: ["text_to_speech"] },
          { id: "mobile-image", label: "Image", model: "fake-mobile-image", capabilities: ["image_generation"] }
        ]
      }
    ],
    activeProviderId: "mobile-provider",
    activeModelId: "mobile-chat",
    moduleModelPreferences: {
      voice_transcription: { providerId: "mobile-provider", modelId: "mobile-stt" },
      voice_speech: { providerId: "mobile-provider", modelId: "mobile-tts" },
      image_generation: { providerId: "mobile-provider", modelId: "mobile-image" }
    },
    autoSummarizeUser: true,
    showMessageAvatars: false,
    showMessageTimestamps: true,
    ttsVoice: "nova",
    ttsPlaybackRate: 1.25,
    ttsAutoPlay: true,
    userProfileSummary: "",
    userPersonaPresets: [
      {
        id: "mobile-persona",
        name: "Mobile Persona",
        config: {
          prefix: "Mobile user boundary.",
          prompt: "Mobile user likes stable smoke tests.",
          suffix: "Keep it short."
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  };
  const savedModelSettings = await request("/api/settings", {
    method: "PUT",
    body: modelSettings
  });
  assert.equal(savedModelSettings.showMessageAvatars, false);
  assert.equal(savedModelSettings.showMessageTimestamps, true);
  assert.equal(savedModelSettings.ttsVoice, "nova");
  assert.equal(savedModelSettings.ttsPlaybackRate, 1.25);
  assert.equal(savedModelSettings.ttsAutoPlay, true);
  assert.equal(savedModelSettings.hasApiKey, true);
  assert.equal(savedModelSettings.userPersonaPresets[0]?.name, "Mobile Persona");
  assert.equal("key" in savedModelSettings.providers[0], false);
  assert.equal(savedModelSettings.providers[0]?.hasKey, true);

  const switchedModelSettings = await request("/api/settings", {
    method: "PUT",
    body: {
      ...modelSettings,
      apiKey: undefined,
      model: "fake-mobile-model-2",
      moduleModelPreferences: undefined,
      userPersonaPresets: undefined,
      providers: savedModelSettings.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) =>
          model.id === "mobile-chat" ? { ...model, model: "fake-mobile-model-2" } : model
        )
      })),
      showMessageAvatars: undefined,
      showMessageTimestamps: undefined,
      ttsVoice: undefined,
      ttsPlaybackRate: undefined,
      ttsAutoPlay: undefined,
      autoSummarizeUser: undefined,
      userProfileSummary: undefined
    }
  });
  assert.equal(switchedModelSettings.model, "fake-mobile-model-2");
  assert.equal(switchedModelSettings.showMessageAvatars, false);
  assert.equal(switchedModelSettings.showMessageTimestamps, true);
  assert.equal(switchedModelSettings.ttsVoice, "nova");
  assert.equal(switchedModelSettings.ttsPlaybackRate, 1.25);
  assert.equal(switchedModelSettings.ttsAutoPlay, true);
  assert.equal(switchedModelSettings.autoSummarizeUser, true);
  assert.equal(switchedModelSettings.userPersonaPresets[0]?.config.prompt, "Mobile user likes stable smoke tests.");
  assert.deepEqual(switchedModelSettings.moduleModelPreferences.image_generation, {
    providerId: "mobile-provider",
    modelId: "mobile-image"
  });
  assert.equal("key" in switchedModelSettings.providers[0], false);
  assert.equal(switchedModelSettings.providers[0]?.hasKey, true);

  const importedProviderModels = await request("/api/settings/providers/mobile-provider/models", {
    method: "POST",
    body: {
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${modelPort}`
    }
  });
  assert.deepEqual(importedProviderModels.models, ["fake-mobile-model"]);

  const testRequestCountBefore = fakeModelServer.getChatCompletionRequests();
  const connectionTest = await request("/api/settings/test", { method: "POST" });
  assert.equal(connectionTest.reachable, true);
  assert.equal(connectionTest.model, "fake-mobile-model-2");
  assert.equal(fakeModelServer.getChatCompletionRequests(), testRequestCountBefore + 1);
  assert.equal(fakeModelServer.getLastChatCompletionBody().model, "fake-mobile-model-2");
  assert.equal(fakeModelServer.getLastChatCompletionBody().stream, false);

  const character = await request("/api/characters", {
    method: "POST",
    body: {
      name: "Mobile Smoke Character",
      avatar: "data:image/png;base64,QUJDRA==",
      description: "Created by mobile backend smoke test",
      tags: ["mobile"],
      prefix: "You are concise.",
      prompt: "Reply as a local mobile character.",
      suffix: "",
      htmlCss: "",
      openingHtml: "",
      loreEntries: [],
      quickReplies: []
    }
  });
  assert.equal(character.name, "Mobile Smoke Character");
  assert.equal(character.avatar, "data:image/png;base64,QUJDRA==");

  const privateCard = await request(`/api/characters/${character.id}/export`, {
    method: "POST",
    body: {
      visibility: "private",
      password: "open-sesame"
    }
  });
  assert.equal(privateCard.visibility, "private");
  assert.equal(privateCard.character.avatar, "data:image/png;base64,QUJDRA==");
  assert.equal(privateCard.protectedPayload.algorithm, "aes-256-gcm");

  const importedPrivateCharacter = await request("/api/characters/import", {
    method: "POST",
    body: privateCard
  });
  assert.equal(importedPrivateCharacter.id, character.id);
  assert.equal(importedPrivateCharacter.visibility, "private");
  assert.equal(importedPrivateCharacter.canViewPrompt, false);
  assert.equal(importedPrivateCharacter.prompt, "");

  const duplicatedPrivateCharacter = await request(`/api/characters/${character.id}/duplicate`, {
    method: "POST",
    body: { name: "AAA Mobile Smoke Character Copy" }
  });
  assert.notEqual(duplicatedPrivateCharacter.id, character.id);
  assert.notEqual(duplicatedPrivateCharacter.cardId, character.cardId);
  assert.equal(duplicatedPrivateCharacter.visibility, "private");
  assert.equal(duplicatedPrivateCharacter.canViewPrompt, false);
  assert.equal(duplicatedPrivateCharacter.isFavorite, false);
  const batchTagAdd = await request("/api/characters/batch-tags", {
    method: "POST",
    body: {
      ids: [character.id, duplicatedPrivateCharacter.id],
      operation: "add",
      tags: ["batch-managed", "mobile"]
    }
  });
  assert.equal(batchTagAdd.updated, 2);
  const batchTaggedCharacter = await request(`/api/characters/${character.id}`);
  const batchTaggedPrivateCharacter = await request(
    `/api/characters/${duplicatedPrivateCharacter.id}`
  );
  assert.equal(batchTaggedCharacter.tags.includes("batch-managed"), true);
  assert.equal(batchTaggedCharacter.tags.filter((tag) => tag === "mobile").length, 1);
  assert.equal(batchTaggedPrivateCharacter.tags.includes("batch-managed"), true);
  assert.equal(batchTaggedPrivateCharacter.canViewPrompt, false);
  const batchTagRemove = await request("/api/characters/batch-tags", {
    method: "POST",
    body: {
      ids: [character.id, duplicatedPrivateCharacter.id],
      operation: "remove",
      tags: ["batch-managed"]
    }
  });
  assert.equal(batchTagRemove.updated, 2);
  assert.equal(
    (await request(`/api/characters/${duplicatedPrivateCharacter.id}`)).tags.includes("batch-managed"),
    false
  );
  const nameSortedCharacters = await request("/api/characters/page?q=Mobile%20Smoke%20Character&sort=name_asc");
  assert.equal(nameSortedCharacters.items[0]?.id, duplicatedPrivateCharacter.id);
  await request(`/api/characters/${duplicatedPrivateCharacter.id}`, { method: "DELETE" });

  const favoriteCharacter = await request(`/api/characters/${character.id}`, {
    method: "PUT",
    body: { isFavorite: true }
  });
  assert.equal(favoriteCharacter.isFavorite, true);
  const favoriteCharacters = await request("/api/characters/page?favoriteOnly=true");
  assert.equal(favoriteCharacters.total, 1);
  assert.equal(favoriteCharacters.items[0]?.id, character.id);

  const wrongUnlock = await requestFailure(`/api/characters/${character.id}/unlock`, {
    method: "POST",
    body: {
      password: "wrong-password"
    }
  });
  assert.equal(wrongUnlock.status, 403);

  const unlockedPrivateCharacter = await request(`/api/characters/${character.id}/unlock`, {
    method: "POST",
    body: {
      password: "open-sesame"
    }
  });
  assert.equal(unlockedPrivateCharacter.visibility, "private");
  assert.equal(unlockedPrivateCharacter.canViewPrompt, true);
  assert.equal(unlockedPrivateCharacter.prompt, "Reply as a local mobile character.");

  const publicCard = await request(`/api/characters/${character.id}/export`, {
    method: "POST",
    body: {
      visibility: "public",
      password: "open-sesame"
    }
  });
  assert.equal(publicCard.visibility, "public");
  assert.equal(publicCard.character.prompt, "Reply as a local mobile character.");
  assert.equal("isFavorite" in publicCard.character, false);

  const chat = await request("/api/chats", {
    method: "POST",
    body: {
      title: "Mobile smoke chat",
      characterId: character.id,
      memoryTurns: 12,
      autoMemoryEnabled: true,
      backgroundUrl: "",
      userPersona: "",
      userProfileSummary: ""
    }
  });
  assert.equal(chat.characterId, character.id);

  const pinnedChat = await request(`/api/chats/${chat.id}`, {
    method: "PUT",
    body: { isPinned: true, isArchived: true }
  });
  assert.equal(pinnedChat.isPinned, true);
  assert.equal(pinnedChat.isArchived, true);
  const restoredBatch = await request("/api/chats/batch-archive", {
    method: "POST",
    body: { ids: [chat.id], isArchived: false }
  });
  assert.equal(restoredBatch.updated, 1);
  assert.equal((await request(`/api/chats/${chat.id}`)).isArchived, false);
  const archivedBatch = await request("/api/chats/batch-archive", {
    method: "POST",
    body: { ids: [chat.id], isArchived: true }
  });
  assert.equal(archivedBatch.updated, 1);
  assert.equal((await request(`/api/chats/${chat.id}`)).isArchived, true);
  const chatsAfterPin = await request("/api/chats");
  assert.equal(chatsAfterPin[0]?.id, chat.id);
  assert.equal(chatsAfterPin[0]?.isPinned, true);

  const openingChat = await request("/api/chats", {
    method: "POST",
    body: {
      title: "Mobile smoke opening chat",
      characterId: character.id
    }
  });
  const openingMessage = await request(`/api/chats/${openingChat.id}/opening-message`, {
    method: "POST"
  });
  assert.equal(openingMessage.role, "assistant");
  assert.equal(openingMessage.characterId, character.id);
  assert.match(openingMessage.content, /Mobile assistant reply/);
  const openingChatAfterMessage = await request(`/api/chats/${openingChat.id}`);
  assert.equal(openingChatAfterMessage.messages.length, 1);
  const secondOpening = await requestFailure(`/api/chats/${openingChat.id}/opening-message`, {
    method: "POST"
  });
  assert.equal(secondOpening.status, 409);
  await request(`/api/chats/${openingChat.id}`, { method: "DELETE" });
  const trashedOpening = (await request("/api/chats")).find((entry) => entry.id === openingChat.id);
  assert.ok(trashedOpening?.deletedAt);
  assert.ok((await request("/api/backups/export")).chats.find((entry) => entry.id === openingChat.id)?.deletedAt);
  assert.equal((await requestFailure(`/api/chats/${openingChat.id}`)).status, 404);
  const restoredOpening = await request(`/api/chats/${openingChat.id}/restore`, { method: "POST" });
  assert.equal(restoredOpening.deletedAt, null);
  assert.equal((await request(`/api/chats/${openingChat.id}`)).messages.length, 1);
  await permanentlyDeleteChat(openingChat.id);

  const batchTrashChats = [];
  for (const title of ["Mobile batch trash A", "Mobile batch trash B"]) {
    batchTrashChats.push(await request("/api/chats", {
      method: "POST",
      body: { title, characterId: character.id }
    }));
  }
  const batchTrashIds = batchTrashChats.map((entry) => entry.id);
  assert.equal((await request("/api/chats/batch-trash", {
    method: "POST",
    body: { ids: batchTrashIds, action: "trash" }
  })).updated, 2);
  assert.equal((await request("/api/chats/batch-trash", {
    method: "POST",
    body: { ids: batchTrashIds, action: "restore" }
  })).updated, 2);
  await request("/api/chats/batch-trash", {
    method: "POST",
    body: { ids: batchTrashIds, action: "trash" }
  });
  assert.equal((await request("/api/chats/batch-permanent-delete", {
    method: "POST",
    body: { ids: batchTrashIds }
  })).deleted, 2);

  const generationEvents = await runGeneration(chat.id, "Please remember that I like blue doors.");
  const startedCharacterEvent = generationEvents.find((event) => event.type === "generation_character_started");
  assert.ok(startedCharacterEvent);
  assert.equal(startedCharacterEvent.characterId, character.id);
  assert.ok(generationEvents.some((event) => event.type === "user_profile_updated"));
  const memoryUpdatedEvent = generationEvents.find((event) => event.type === "chat_memory_updated");
  assert.ok(memoryUpdatedEvent);
  assert.equal(memoryUpdatedEvent.summary.created, 1);
  assert.equal(memoryUpdatedEvent.summary.updated, 0);
  assert.equal(memoryUpdatedEvent.summary.disabled, 0);

  const chatAfterGeneration = await request(`/api/chats/${chat.id}`);
  assert.match(chatAfterGeneration.userProfileSummary, /blue doors/i);
  assert.equal(chatAfterGeneration.messages.length, 2);
  assert.equal(chatAfterGeneration.memories.length, 1);
  assert.match(chatAfterGeneration.memories[0].content, /blue door/i);

  const excludedUserMessage = await request(`/api/messages/${chatAfterGeneration.messages[0].id}`, {
    method: "PUT",
    body: { contextIncluded: false, isBookmarked: true }
  });
  assert.equal(excludedUserMessage.contextIncluded, false);
  assert.equal(excludedUserMessage.isBookmarked, true);

  const globalMessageSearch = await request(
    `/api/chats/message-search?${new URLSearchParams({ q: "blue doors", limit: "5" }).toString()}`
  );
  assert.ok(globalMessageSearch.total >= 1);
  assert.equal(globalMessageSearch.results[0]?.chat.id, chat.id);
  assert.equal(globalMessageSearch.results[0]?.chat.isArchived, true);
  assert.match(globalMessageSearch.results[0]?.snippet ?? "", /blue doors/i);

  const lastAssistantMessage = chatAfterGeneration.messages.at(-1);
  assert.equal(lastAssistantMessage?.role, "assistant");
  const continuationEvents = await runSocketRequest({
    type: "continue",
    messageId: lastAssistantMessage.id
  });
  const continuedMessage = continuationEvents.find((event) => event.type === "assistant_message")?.message;
  assert.equal(continuedMessage?.id, lastAssistantMessage.id);
  assert.equal(continuedMessage?.content, "Mobile assistant reply. Mobile assistant reply.");
  assert.equal(continuedMessage?.variants.length, 1);
  const chatAfterContinuation = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterContinuation.messages.length, 2);
  assert.equal(chatAfterContinuation.messages[1]?.content, "Mobile assistant reply. Mobile assistant reply.");

  const messageSearch = await request(
    `/api/chats/${chat.id}/message-search?${new URLSearchParams({
      q: "blue doors",
      limit: "5"
    }).toString()}`
  );
  assert.ok(messageSearch.total >= 1);
  assert.match(messageSearch.results[0]?.snippet ?? "", /blue doors/i);

  const memoryRefresh = await request(`/api/chats/${chat.id}/memories/refresh`, {
    method: "POST"
  });
  assert.ok(memoryRefresh.length >= 1);

  const recallEvents = await runGeneration(chat.id, "What did I say about blue doors?");
  const memoryMatchEvent = recallEvents.find((event) => event.type === "memory_matches");
  assert.ok(memoryMatchEvent);
  assert.equal(memoryMatchEvent.entries.length, 1);
  assert.equal(memoryMatchEvent.entries[0].id, chatAfterGeneration.memories[0].id);

  const titleSuggestion = await request(`/api/chats/${chat.id}/title-suggestion`, { method: "POST" });
  assert.equal(titleSuggestion.title, "Mobile Blue Door");
  const chatAfterTitleSuggestion = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterTitleSuggestion.title, chat.title);
  assert.equal(chatAfterTitleSuggestion.messages.length, 4);

  const agentDraft = await request(`/api/chats/${chat.id}/agent-draft`, {
    method: "POST",
    body: {
      mode: "reply_drafts",
      focus: "blue doors"
    }
  });
  assert.equal(agentDraft.mode, "reply_drafts");
  assert.match(agentDraft.content, /Mobile agent draft/);
  assert.equal(Array.isArray(agentDraft.matchedLoreEntries), true);
  assert.equal(Array.isArray(agentDraft.matchedMemoryEntries), true);
  const chatAfterAgentDraft = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterAgentDraft.messages.length, 4);
  assert.ok(chatAfterAgentDraft.memories.length >= 1);

  const chatArchive = await request(`/api/chats/${chat.id}/archive`);
  assert.equal(chatArchive.archiveVersion, 1);
  assert.equal(chatArchive.messages.length, 4);
  assert.equal(chatArchive.messages[0]?.contextIncluded, false);
  assert.equal(chatArchive.messages[0]?.isBookmarked, true);
  const importedArchive = await request("/api/chats/import-archive", {
    method: "POST",
    body: { archive: chatArchive, title: "Mobile Imported Archive" }
  });
  assert.notEqual(importedArchive.id, chat.id);
  assert.equal(importedArchive.title, "Mobile Imported Archive");
  assert.equal(importedArchive.messages.length, 4);
  assert.equal(importedArchive.messages[0]?.contextIncluded, false);
  assert.equal(importedArchive.messages[0]?.isBookmarked, true);
  assert.ok(importedArchive.memories.length >= 1);
  assert.equal(importedArchive.isArchived, false);
  await permanentlyDeleteChat(importedArchive.id);

  const branchedChat = await request(`/api/chats/${chat.id}/branches`, {
    method: "POST",
    body: {
      messageId: chatAfterAgentDraft.messages.find((message) => message.role === "assistant").id,
      title: "Mobile Smoke Branch"
    }
  });
  assert.equal(branchedChat.title, "Mobile Smoke Branch");
  assert.equal(branchedChat.parentChatId, chat.id);
  assert.equal(
    branchedChat.branchSourceMessageId,
    chatAfterAgentDraft.messages.find((message) => message.role === "assistant").id
  );
  assert.equal(branchedChat.messages.length, 2);
  assert.equal(branchedChat.messages[0]?.contextIncluded, false);
  assert.equal(branchedChat.messages[0]?.isBookmarked, true);
  assert.equal(branchedChat.memories.length, 0);
  await permanentlyDeleteChat(branchedChat.id);

  const checkpointChat = await request(`/api/chats/${chat.id}/branches`, {
    method: "POST",
    body: {
      messageId: chatAfterAgentDraft.messages.find((message) => message.role === "assistant").id,
      title: "Mobile Smoke Checkpoint",
      kind: "checkpoint"
    }
  });
  assert.equal(checkpointChat.isCheckpoint, true);
  assert.equal(checkpointChat.parentChatId, chat.id);
  assert.equal(checkpointChat.messages.length, 2);
  assert.equal(checkpointChat.memories.length, 0);
  await permanentlyDeleteChat(checkpointChat.id);

  const lineageParent = await request("/api/chats", {
    method: "POST",
    body: { title: "Mobile lineage cleanup parent", characterId: character.id }
  });
  const lineageSource = await request("/api/messages", {
    method: "POST",
    body: { chatId: lineageParent.id, role: "user", content: "Mobile lineage source" }
  });
  const detachedBranch = await request(`/api/chats/${lineageParent.id}/branches`, {
    method: "POST",
    body: { messageId: lineageSource.id, title: "Mobile lineage cleanup branch" }
  });
  await request(`/api/chats/${lineageParent.id}`, { method: "DELETE" });
  const branchWhileParentIsTrashed = await request(`/api/chats/${detachedBranch.id}`);
  assert.equal(branchWhileParentIsTrashed.parentChatId, lineageParent.id);
  await request(`/api/chats/${lineageParent.id}/permanent`, { method: "DELETE" });
  const detachedBranchAfterParentDelete = await request(`/api/chats/${detachedBranch.id}`);
  assert.equal(detachedBranchAfterParentDelete.parentChatId, null);
  assert.equal(detachedBranchAfterParentDelete.branchSourceMessageId, null);
  await permanentlyDeleteChat(detachedBranch.id);

  const transcription = await request("/api/media/voice/transcriptions", {
    method: "POST",
    body: {
      audioBase64: Buffer.from("mobile fake audio").toString("base64"),
      mimeType: "audio/webm"
    }
  });
  assert.equal(transcription.text, "mobile transcribed audio");

  const speech = await request("/api/media/voice/speech", {
    method: "POST",
    body: { text: "Read the mobile smoke line.", voice: "alloy", format: "mp3" }
  });
  assert.equal(speech.audioBase64, Buffer.from("mobile-audio").toString("base64"));

  const image = await request("/api/media/images/generations", {
    method: "POST",
    body: { prompt: "mobile smoke image", size: "1024x1024" }
  });
  assert.equal(image.images[0]?.b64Json, Buffer.from("mobile-image").toString("base64"));

  const backup = await request("/api/backups/export");
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.characters.length, 1);
  assert.equal(backup.characters[0]?.avatar, "data:image/png;base64,QUJDRA==");
  assert.equal(backup.characters[0]?.isFavorite, true);
  assert.equal(backup.chats.length, 1);
  assert.equal(backup.chats[0]?.isPinned, true);
  assert.equal(backup.chats[0]?.isArchived, true);
  assert.equal(backup.messages.length, 4);
  assert.equal("key" in backup.settings.providers[0], false);
  assert.equal(backup.settings.providers[0]?.hasKey, true);
  assert.ok(backup.memories.length >= 1);

  const exportedText = await request("/api/exports/text", {
    method: "POST",
    body: {
      filename: "chat-mobile-smoke.txt",
      content: "用户：Please remember that I like blue doors.\nAI：Mobile assistant reply."
    }
  });
  assert.equal(exportedText.filename, "chat-mobile-smoke.txt");
  assert.match(exportedText.url, /^file:\/\//);

  const exportedJson = await request("/api/exports/text", {
    method: "POST",
    body: {
      filename: "local-roleplay-backup-smoke.json",
      content: JSON.stringify(backup, null, 2)
    }
  });
  assert.equal(exportedJson.filename, "local-roleplay-backup-smoke.json");
  assert.match(exportedJson.url, /^file:\/\//);

  const peerBaseUrl = `http://127.0.0.1:${port}`;
  const syncInfo = await request("/api/sync/info");
  assert.equal(syncInfo.port, port);
  assert.equal(syncInfo.localUrl, peerBaseUrl);
  assert.equal(Array.isArray(syncInfo.lanUrls), true);
  assert.equal(syncInfo.listeningHost, "0.0.0.0");

  const pulledSyncSummary = await request("/api/sync/pull", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge"
    }
  });
  assert.equal(pulledSyncSummary.direction, "pull");
  assert.equal(pulledSyncSummary.summary.characters, 1);
  assert.equal(pulledSyncSummary.summary.chats, 1);
  assert.equal(pulledSyncSummary.summary.messages, 4);
  assert.ok(pulledSyncSummary.summary.memories >= 1);

  const pushedSyncSummary = await request("/api/sync/push", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge"
    }
  });
  assert.equal(pushedSyncSummary.direction, "push");
  assert.equal(pushedSyncSummary.summary.characters, 1);
  assert.equal(pushedSyncSummary.summary.chats, 1);
  assert.equal(pushedSyncSummary.summary.messages, 4);
  assert.ok(pushedSyncSummary.summary.memories >= 1);

  console.log("Mobile backend smoke passed");
} finally {
  child.kill();
  fakeModelServer.close();
  await rm(dataDir, { recursive: true, force: true });
}
