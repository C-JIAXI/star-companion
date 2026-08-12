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
  const chatCompletionBodies = [];

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

    if (request.method === "POST" && request.url === "/embeddings") {
      const body = await readJsonBody(request);
      const inputs = Array.isArray(body.input) ? body.input : [];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          model: body.model,
          data: inputs.map((input, index) => ({
            index,
            embedding: /commitment|vowed|harbor|festival/i.test(String(input).split("\n")[0] ?? "")
              ? [0, 1]
              : [1, 0]
          }))
        })
      );
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
    chatCompletionBodies.push(body);
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
    if (joinedMessages.includes("read-only drafting assistant for an original")) {
      content = JSON.stringify({ items: [{ field: "prompt", title: "Mobile core draft", suggestion: "A structured mobile character draft." }] });
    } else if (joinedMessages.includes("read-only context assistant")) {
      content = "Mobile agent draft: [DRAFT]Ask about the blue door hinge.[/DRAFT]";
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
      const semanticId = joinedMessages.match(/id=([^\s]+)\ntitle=Harbor vow/)?.[1];
      const id = joinedMessages.includes("Current conversation context:\nWhat commitment did they make")
        ? semanticId
        : joinedMessages.match(/id=([^\s]+)/)?.[1];
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
        getLastChatCompletionBody: () => lastChatCompletionBody,
        getChatCompletionBodies: () => [...chatCompletionBodies]
      });
    });
  });
};

const runSocketRequest = (input) =>
  new Promise((resolve, reject) => {
    const requestId = input.requestId ?? `mobile-smoke-${Date.now()}`;
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

const querySocketRequestStatus = (requestId) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for mobile generation status"));
    }, 5_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "status", requestId })));
    socket.addEventListener("message", (raw) => {
      const event = JSON.parse(String(raw.data));
      if (event.type !== "generation_status" || event.request?.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.close();
      resolve(event.request);
    });
    socket.addEventListener("error", reject);
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
  const appInfo = await request("/api/app/info");
  assert.match(appInfo.appVersion, /^\d+\.\d+\.\d+/);
  assert.equal(appInfo.platform, "android");
  assert.equal(appInfo.schemaVersion, "001_records");
  assert.equal(appInfo.migration.status, "ready");
  assert.equal("apiKey" in appInfo, false);

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
          {
            id: "mobile-chat", label: "Chat", model: "fake-mobile-model", contextWindow: 128000,
            capabilities: ["text_generation"],
            pricing: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 6_000_000, currency: "USD", updatedAt: "2026-08-12T00:00:00.000Z", source: "user" }
          },
          { id: "mobile-embedding", label: "Embedding", model: "fake-mobile-embedding", capabilities: ["text_embedding"] },
          { id: "mobile-stt", label: "Transcription", model: "fake-mobile-transcribe", capabilities: ["audio_transcription"] },
          { id: "mobile-tts", label: "Speech", model: "fake-mobile-tts", capabilities: ["text_to_speech"] },
          { id: "mobile-image", label: "Image", model: "fake-mobile-image", capabilities: ["image_generation"] }
        ]
      }
    ],
    activeProviderId: "mobile-provider",
    activeModelId: "mobile-chat",
    moduleModelPreferences: {
      memory_embedding: { providerId: "mobile-provider", modelId: "mobile-embedding" },
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
        avatar: "data:image/png;base64,YQ==",
        config: {
          displayName: "Mobile User",
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
  assert.equal(savedModelSettings.userPersonaPresets[0]?.avatar, "data:image/png;base64,YQ==");
  assert.equal(savedModelSettings.userPersonaPresets[0]?.config.displayName, "Mobile User");
  assert.equal(savedModelSettings.providers[0]?.models[0]?.contextWindow, 128000);
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
  assert.equal(switchedModelSettings.providers[0]?.models[0]?.contextWindow, 128000);
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
  assert.equal(importedPrivateCharacter.htmlCss, "");
  assert.equal(importedPrivateCharacter.prompt, "");

  const metadataUpdatedPrivateCharacter = await request(`/api/characters/${character.id}`, {
    method: "PUT",
    body: { name: "Mobile Smoke Character Metadata", avatar: "https://example.test/mobile-private.png", tags: ["mobile", "private-metadata"] }
  });
  assert.equal(metadataUpdatedPrivateCharacter.canViewPrompt, false);
  assert.equal(metadataUpdatedPrivateCharacter.name, "Mobile Smoke Character Metadata");
  assert.equal(metadataUpdatedPrivateCharacter.avatar, "https://example.test/mobile-private.png");
  assert.deepEqual(metadataUpdatedPrivateCharacter.tags, ["mobile", "private-metadata"]);

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
  assert.equal(unlockedPrivateCharacter.name, "Mobile Smoke Character Metadata");

  const characterDraftCount = fakeModelServer.getChatCompletionRequests();
  const characterDraft = await request("/api/characters/draft", {
    method: "POST",
    body: {
      requestId: "mobile-character-draft",
      task: "refine_prompt",
      characterId: character.id,
      accessPassword: "open-sesame",
      draft: {
        name: unlockedPrivateCharacter.name,
        description: unlockedPrivateCharacter.description,
        prefix: unlockedPrivateCharacter.prefix,
        prompt: unlockedPrivateCharacter.prompt,
        suffix: unlockedPrivateCharacter.suffix,
        loreEntries: unlockedPrivateCharacter.loreEntries,
        quickReplies: unlockedPrivateCharacter.quickReplies
      }
    }
  });
  assert.equal(characterDraft.task, "refine_prompt");
  assert.equal(characterDraft.items[0]?.field, "prompt");
  assert.equal(fakeModelServer.getChatCompletionRequests(), characterDraftCount + 1);
  assert.equal((await request(`/api/characters/${character.id}/unlock`, { method: "POST", body: { password: "open-sesame" } })).prompt, "Reply as a local mobile character.");
  const sentCharacterDraft = JSON.parse(fakeModelServer.getLastChatCompletionBody().messages[1].content);
  assert.deepEqual(Object.keys(sentCharacterDraft), ["prompt", "brief"]);
  const usageAfterCharacterDraft = await request("/api/usage/summary");
  assert.equal(usageAfterCharacterDraft.recent.some((item) => item.requestId === "mobile-character-draft" && item.module === "agent" && item.status === "succeeded"), true);

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

  const mobilePersonaEnvelope = JSON.stringify({
    type: "user-custom-config",
    version: 2,
    displayName: "Mobile User",
    prefix: "Mobile user boundary.",
    prompt: "Mobile user likes stable smoke tests.",
    suffix: "Keep it short."
  });
  const chat = await request("/api/chats", {
    method: "POST",
    body: {
      title: "Mobile smoke chat",
      characterId: character.id,
      folder: "Mobile smoke folder",
      memoryTurns: 12,
      autoMemoryEnabled: true,
      backgroundUrl: "",
      userPersona: mobilePersonaEnvelope,
      userAvatar: "data:image/png;base64,YQ==",
      userProfileSummary: ""
    }
  });
  assert.equal(chat.characterId, character.id);
  assert.equal(chat.folder, "Mobile smoke folder");
  assert.equal(chat.userAvatar, "data:image/png;base64,YQ==");

  const movedToFolder = await request("/api/chats/batch-folder", {
    method: "POST",
    body: { ids: [chat.id], folder: "Mobile organized folder" }
  });
  assert.equal(movedToFolder.updated, 1);
  assert.equal((await request(`/api/chats/${chat.id}`)).folder, "Mobile organized folder");
  const renamedFolder = await request("/api/chats/rename-folder", {
    method: "POST",
    body: { from: "Mobile organized folder", to: "Mobile renamed folder" }
  });
  assert.equal(renamedFolder.updated, 1);
  assert.equal((await request(`/api/chats/${chat.id}`)).folder, "Mobile renamed folder");
  assert.equal(
    (await request(`/api/chats/${chat.id}/auto-title`, { method: "POST" })).data,
    null
  );

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
  assert.equal("userAvatar" in chatsAfterPin[0], false);

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
  assert.ok(openingMessage.promptBreakdown?.promptTokens > 0);
  assert.ok(
    openingMessage.promptBreakdown?.sections.some(
      (section) => section.id === "generation_instruction"
    )
  );
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

  const generationBodyStart = fakeModelServer.getChatCompletionBodies().length;
  const generationEvents = await runGeneration(chat.id, "Please remember that I like blue doors.");
  const generationBody = fakeModelServer
    .getChatCompletionBodies()
    .slice(generationBodyStart)
    .find((body) => body.stream === true);
  assert.ok(generationBody);
  const generationPrompt = generationBody.messages
    .map((message) => message.content ?? "")
    .join("\n\n");
  assert.match(generationPrompt, /Mobile user boundary\./);
  assert.match(generationPrompt, /Mobile user likes stable smoke tests\./);
  assert.match(generationPrompt, /Keep it short\./);
  assert.doesNotMatch(generationPrompt, /Mobile User/);
  assert.doesNotMatch(generationPrompt, /user-custom-config/);
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
  assert.ok(memoryUpdatedEvent.summary.operationId);
  const automaticOperations = await request(`/api/chats/${chat.id}/memory-operations`);
  assert.equal(automaticOperations[0]?.id, memoryUpdatedEvent.summary.operationId);
  assert.equal(automaticOperations[0]?.status, "succeeded");
  const automaticRevisions = await request(`/api/chats/${chat.id}/memories/${chatAfterGeneration.memories[0].id}/revisions`);
  assert.equal(automaticRevisions[0]?.action, "automatic_create");
  assert.equal(automaticRevisions[0]?.operationId, memoryUpdatedEvent.summary.operationId);
  assert.equal(automaticRevisions[0]?.sourceMessageIds.length, 2);
  assert.ok(automaticRevisions[0]?.sources.every((source) => source.available));
  assert.equal("embedding" in automaticRevisions[0].afterSnapshot, false);
  const profileHistory = await request(`/api/chats/${chat.id}/profile-summary/revisions`);
  assert.equal(profileHistory[0]?.action, "automatic_update");
  assert.equal(profileHistory[0]?.sourceMessageIds.length, 1);
  const manuallyProfiledChat = await request(`/api/chats/${chat.id}`, {
    method: "PUT",
    body: { userProfileSummary: "Manual mobile profile revision." }
  });
  const profileRestorePreview = await request(`/api/chats/${chat.id}/profile-summary/revisions/1/restore-preview`);
  assert.equal(profileRestorePreview.expectedCurrentRevision, manuallyProfiledChat.profileRevision);
  const profileRestore = await request(`/api/chats/${chat.id}/profile-summary/restore`, {
    method: "POST",
    body: { revision: 1, expectedCurrentRevision: profileRestorePreview.expectedCurrentRevision, confirm: "RESTORE_PROFILE_SUMMARY" }
  });
  assert.equal(profileRestore.revision.action, "restore");
  assert.match(profileRestore.chat.userProfileSummary, /blue doors/i);
  const undoPreview = await request(`/api/chats/${chat.id}/memory-operations/${memoryUpdatedEvent.summary.operationId}/undo-preview`, { method: "POST" });
  assert.equal(undoPreview.items[0]?.effect, "retire_created");
  const undoResult = await request(`/api/chats/${chat.id}/memory-operations/${memoryUpdatedEvent.summary.operationId}/undo`, {
    method: "POST",
    body: {
      confirm: "UNDO_MEMORY_OPERATION",
      resolutions: undoPreview.items.map((item) => ({ memoryId: item.memoryId, expectedCurrentRevision: item.currentRevision, action: "restore" }))
    }
  });
  assert.equal(undoResult.retired, 1);
  const undoneMemories = await request(`/api/chats/${chat.id}/memories`);
  assert.ok(undoneMemories.find((memory) => memory.id === chatAfterGeneration.memories[0].id)?.deletedAt);
  const restoreAutomaticPreview = await request(`/api/chats/${chat.id}/memories/${chatAfterGeneration.memories[0].id}/revisions/1/restore-preview`);
  await request(`/api/chats/${chat.id}/memories/${chatAfterGeneration.memories[0].id}/restore`, {
    method: "POST",
    body: { revision: 1, expectedCurrentRevision: restoreAutomaticPreview.expectedCurrentRevision, confirm: "RESTORE_MEMORY_REVISION" }
  });
  assert.ok(chatAfterGeneration.messages[1]?.promptBreakdown?.promptTokens > 0);
  assert.ok(
    chatAfterGeneration.messages[1]?.promptBreakdown?.sections.some(
      (section) => section.id === "user_persona"
    )
  );
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
  assert.ok(continuedMessage?.promptBreakdown?.promptTokens > 0);
  assert.ok(
    continuedMessage?.promptBreakdown?.sections.some(
      (section) => section.id === "generation_instruction"
    )
  );
  assert.equal(continuedMessage?.generationMetadata?.modelId, "fake-mobile-model-2");
  assert.equal(continuedMessage?.generationMetadata?.usageSource, "provider");
  assert.equal(continuedMessage?.generationMetadata?.estimatedCostMicros, 40);
  assert.equal(continuedMessage?.generationMetadata?.incomplete, false);
  const continuedRequestId = continuedMessage.generationMetadata.requestId;
  const continuedRequestStatus = await querySocketRequestStatus(continuedRequestId);
  assert.equal(continuedRequestStatus.status, "succeeded");
  assert.equal(continuedRequestStatus.messageId, lastAssistantMessage.id);
  const providerCallsBeforeStatus = fakeModelServer.getChatCompletionRequests();
  assert.equal((await querySocketRequestStatus(continuedRequestId)).status, "succeeded");
  assert.equal(fakeModelServer.getChatCompletionRequests(), providerCallsBeforeStatus);
  const usageSummary = await request(`/api/usage/summary?${new URLSearchParams({ chatId: chat.id }).toString()}`);
  const continuedAttempt = usageSummary.recent.find((attempt) => attempt.requestId === continuedRequestId);
  assert.equal(continuedAttempt.status, "succeeded");
  assert.equal(continuedAttempt.usageSource, "provider");
  assert.equal(continuedAttempt.estimatedCostMicros, 40);
  assert.equal(continuedAttempt.chatTitle, chat.title);
  assert.ok(usageSummary.byChat.some((bucket) => bucket.key === chat.id && bucket.label === chat.title));
  const usagePreview = await request("/api/usage/preview", {
    method: "POST",
    body: { module: "chat", inputTokens: 8, maxOutputTokens: 4 }
  });
  assert.equal(usagePreview.minimumCostMicros, 16);
  assert.equal(usagePreview.maximumCostMicros, 40);
  assert.equal(usagePreview.unknownPricing, false);
  assert.ok(usagePreview.todayCostMicros >= 40);
  const chatAfterContinuation = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterContinuation.messages.length, 2);
  assert.equal(chatAfterContinuation.messages[1]?.content, "Mobile assistant reply. Mobile assistant reply.");

  const regenerationBodyStart = fakeModelServer.getChatCompletionBodies().length;
  const regenerationEvents = await runSocketRequest({
    type: "regenerate",
    messageId: lastAssistantMessage.id,
    guidance: "Make the replacement warmer."
  });
  const regeneratedMessage = regenerationEvents.find(
    (event) => event.type === "assistant_message"
  )?.message;
  assert.equal(regeneratedMessage?.id, lastAssistantMessage.id);
  assert.ok(regeneratedMessage?.variants.length >= 2);
  assert.ok(
    regeneratedMessage?.promptBreakdown?.sections.some(
      (section) => section.id === "generation_instruction"
    )
  );
  const regenerationBody = fakeModelServer
    .getChatCompletionBodies()
    .slice(regenerationBodyStart)
    .find((body) => body.stream === true);
  const regenerationPrompt = regenerationBody?.messages
    .map((message) => message.content ?? "")
    .join("\n\n") ?? "";
  assert.match(regenerationPrompt, /revisionGuidance.*Make the replacement warmer\./s);

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

  const reindexedMemories = await request(`/api/chats/${chat.id}/memories/reindex`, {
    method: "POST"
  });
  assert.ok(reindexedMemories.length >= 1);
  assert.ok(reindexedMemories.filter((memory) => !memory.deletedAt && memory.enabled).every((memory) => memory.embeddingStatus === "ready"));
  assert.ok(reindexedMemories.filter((memory) => !memory.deletedAt && memory.enabled).every((memory) => memory.embeddingModel === "openai-compatible:fake-mobile-embedding" && memory.embeddingUpdatedAt));

  const semanticMemory = await request(`/api/chats/${chat.id}/memories`, {
    method: "POST",
    body: {
      title: "Harbor vow",
      content: "They vowed to meet at the harbor after the winter festival.",
      keywords: ["harbor", "festival"],
      importance: 5,
      enabled: true
    }
  });
  assert.ok(semanticMemory.embeddingUpdatedAt);

  const editedSemanticMemory = await request(`/api/chats/${chat.id}/memories/${semanticMemory.id}`, {
    method: "PUT",
    body: { content: "They vowed to meet beside the harbor after the winter festival." }
  });
  const semanticHistory = await request(`/api/chats/${chat.id}/memories/${semanticMemory.id}/revisions`);
  assert.equal(semanticHistory[0]?.action, "manual_edit");
  const semanticRestorePreview = await request(`/api/chats/${chat.id}/memories/${semanticMemory.id}/revisions/1/restore-preview`);
  assert.equal(semanticRestorePreview.expectedCurrentRevision, editedSemanticMemory.currentRevision);
  const restoredSemanticMemory = await request(`/api/chats/${chat.id}/memories/${semanticMemory.id}/restore`, {
    method: "POST",
    body: { revision: 1, expectedCurrentRevision: semanticRestorePreview.expectedCurrentRevision, confirm: "RESTORE_MEMORY_REVISION" }
  });
  assert.equal(restoredSemanticMemory.revision.action, "restore");
  assert.equal(restoredSemanticMemory.memory.embeddingStatus, "stale");

  const timelineSource = await request("/api/messages", {
    method: "POST",
    body: { chatId: chat.id, role: "user", content: "Temporary source for audited timeline cleanup." }
  });
  const timelineMemory = await request(`/api/chats/${chat.id}/memories`, {
    method: "POST",
    body: { title: "Timeline-bound memory", content: "Must be disabled when its source timeline is removed.", sourceMessageIds: [timelineSource.id] }
  });
  const timelineCleanup = await request(`/api/messages/${timelineSource.id}/timeline`, { method: "DELETE" });
  assert.equal(timelineCleanup.deletedCount, 1);
  assert.equal(timelineCleanup.disabledMemoryCount, 1);
  const timelineHistory = await request(`/api/chats/${chat.id}/memories/${timelineMemory.id}/revisions`);
  assert.equal(timelineHistory[0]?.actor, "timeline_cleanup");
  assert.equal(timelineHistory[0]?.action, "timeline_disable");
  assert.equal(timelineHistory[0]?.sources[0]?.available, false);

  const semanticRecallEvents = await runGeneration(
    chat.id,
    "What commitment did they make for after winter?"
  );
  const semanticMatchEvent = semanticRecallEvents.find((event) => event.type === "memory_matches");
  assert.equal(semanticMatchEvent?.entries[0]?.id, semanticMemory.id);

  const recallEvents = await runGeneration(chat.id, "What did I say about blue doors?");
  const memoryMatchEvent = recallEvents.find((event) => event.type === "memory_matches");
  assert.ok(memoryMatchEvent);
  assert.equal(memoryMatchEvent.entries.length, 1);
  assert.equal(memoryMatchEvent.entries[0].id, chatAfterGeneration.memories[0].id);

  const titleSuggestion = await request(`/api/chats/${chat.id}/title-suggestion`, { method: "POST" });
  assert.equal(titleSuggestion.title, "Mobile Blue Door");
  const chatAfterTitleSuggestion = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterTitleSuggestion.title, chat.title);
  assert.equal(chatAfterTitleSuggestion.messages.length, 6);

  const agentDraft = await request(`/api/chats/${chat.id}/agent-draft`, {
    method: "POST",
    body: {
      mode: "reply_drafts",
      focus: "blue doors"
    }
  });
  assert.equal(agentDraft.mode, "reply_drafts");
  assert.match(agentDraft.content, /Mobile agent draft/);
  assert.equal(agentDraft.actions[0]?.kind, "reply_draft");
  assert.equal(agentDraft.actions[0]?.content, "Ask about the blue door hinge.");
  assert.equal(Array.isArray(agentDraft.matchedLoreEntries), true);
  assert.equal(Array.isArray(agentDraft.matchedMemoryEntries), true);
  const chatAfterAgentDraft = await request(`/api/chats/${chat.id}`);
  assert.equal(chatAfterAgentDraft.messages.length, 6);
  assert.ok(chatAfterAgentDraft.memories.length >= 1);

  const chatArchive = await request(`/api/chats/${chat.id}/archive`);
  assert.equal(chatArchive.archiveVersion, 1);
  assert.equal(chatArchive.messages.length, 6);
  assert.equal(chatArchive.messages[0]?.contextIncluded, false);
  assert.equal(chatArchive.messages[0]?.isBookmarked, true);
  assert.equal(chatArchive.chat.userAvatar, "data:image/png;base64,YQ==");
  assert.ok(
    chatArchive.messages.find((message) => message.role === "assistant")?.promptBreakdown
      ?.promptTokens > 0
  );
  const importedArchive = await request("/api/chats/import-archive", {
    method: "POST",
    body: { archive: chatArchive, title: "Mobile Imported Archive" }
  });
  assert.notEqual(importedArchive.id, chat.id);
  assert.equal(importedArchive.title, "Mobile Imported Archive");
  assert.equal(importedArchive.messages.length, 6);
  assert.equal(importedArchive.messages[0]?.contextIncluded, false);
  assert.equal(importedArchive.messages[0]?.isBookmarked, true);
  assert.ok(importedArchive.memories.length >= 1);
  assert.equal(importedArchive.isArchived, false);
  assert.equal(importedArchive.folder, "Mobile renamed folder");
  assert.equal(importedArchive.userAvatar, "data:image/png;base64,YQ==");
  assert.equal(chatArchive.memoryRevisions.length > 0, true);
  assert.equal(chatArchive.memoryOperations.length > 0, true);
  assert.equal(chatArchive.profileSummaryRevisions.length > 0, true);
  const importedArchiveBackup = await request("/api/backups/export");
  assert.ok(importedArchiveBackup.memoryRevisions.some((revision) => revision.chatId === importedArchive.id));
  assert.ok(importedArchiveBackup.memoryOperations.some((operation) => operation.chatId === importedArchive.id));
  assert.ok(importedArchiveBackup.profileSummaryRevisions.some((revision) => revision.chatId === importedArchive.id));
  assert.ok(
    importedArchive.messages.find((message) => message.role === "assistant")?.promptBreakdown
      ?.promptTokens > 0
  );
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
  assert.equal(branchedChat.folder, "Mobile renamed folder");
  assert.equal(branchedChat.userAvatar, "data:image/png;base64,YQ==");
  assert.ok(branchedChat.messages[1]?.promptBreakdown?.promptTokens > 0);
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
  assert.equal(checkpointChat.userAvatar, "data:image/png;base64,YQ==");
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
  assert.equal(backup.characters[0]?.avatar, "https://example.test/mobile-private.png");
  assert.equal(backup.characters[0]?.isFavorite, true);
  assert.equal(backup.chats.length, 1);
  assert.equal(backup.chats[0]?.isPinned, true);
  assert.equal(backup.chats[0]?.isArchived, true);
  assert.equal(backup.chats[0]?.folder, "Mobile renamed folder");
  assert.equal(backup.chats[0]?.userAvatar, "data:image/png;base64,YQ==");
  assert.equal(backup.messages.length, 6);
  assert.ok(backup.messages.some((message) => message.generationMetadata?.estimatedCostMicros === 40));
  assert.equal("usageAttempts" in backup, false);
  assert.equal("modelRequests" in backup, false);
  assert.ok(
    backup.messages.find((message) => message.role === "assistant")?.promptBreakdown
      ?.promptTokens > 0
  );
  assert.equal("key" in backup.settings.providers[0], false);
  assert.equal(backup.settings.providers[0]?.hasKey, true);
  assert.ok(backup.memories.length >= 1);
  assert.equal("embedding" in backup.memories[0], false);
  assert.ok(backup.memoryRevisions.length >= 1);
  assert.ok(backup.memoryOperations.length >= 1);
  assert.ok(backup.profileSummaryRevisions.length >= 1);
  assert.equal("embedding" in backup.memoryRevisions[0].afterSnapshot, false);

  assert.equal((await request("/api/privacy/status")).locked, false);
  assert.equal((await request("/api/privacy/lock", { method: "POST", body: { passcode: "2468" } })).locked, true);
  const lockedProfileResponse = await fetch(`http://127.0.0.1:${port}/api/chats/${chat.id}/profile-summary/revisions`);
  assert.equal(lockedProfileResponse.status, 423);
  assert.doesNotMatch(await lockedProfileResponse.text(), /blue doors|user likes/i);
  const failedUnlockResponse = await fetch(`http://127.0.0.1:${port}/api/privacy/unlock`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "wrong" })
  });
  assert.equal(failedUnlockResponse.status, 401);
  assert.doesNotMatch(await failedUnlockResponse.text(), /blue doors|user likes/i);
  assert.equal((await request("/api/privacy/unlock", { method: "POST", body: { passcode: "2468" } })).locked, false);

  const recoveryBeforePreview = await request("/api/backups/recovery-points");
  const replacePreview = await request("/api/backups/preview", {
    method: "POST",
    body: { ...backup, mode: "replace" }
  });
  assert.equal(replacePreview.canExecute, true);
  assert.equal((await request("/api/backups/recovery-points")).length, recoveryBeforePreview.length);
  const replaceSummary = await request("/api/backups/import", {
    method: "POST",
    body: {
      ...backup,
      mode: "replace",
      previewId: replacePreview.previewId,
      conflictResolutions: []
    }
  });
  assert.ok(replaceSummary.recoveryPointId);
  assert.equal(replaceSummary.characters, 1);

  const conflictBackup = {
    ...backup,
    characters: backup.characters.map((entry) => ({ ...entry, name: "Mobile Incoming Conflict" }))
  };
  const conflictPreview = await request("/api/backups/preview", {
    method: "POST",
    body: { ...conflictBackup, mode: "merge" }
  });
  assert.equal(conflictPreview.conflicts.length, 1);
  const conflictSummary = await request("/api/backups/import", {
    method: "POST",
    body: {
      ...conflictBackup,
      mode: "merge",
      previewId: conflictPreview.previewId,
      conflictResolutions: [{ key: conflictPreview.conflicts[0].key, action: "use_incoming" }]
    }
  });
  assert.ok(conflictSummary.recoveryPointId);
  assert.equal((await request(`/api/characters/${character.id}`)).name, "Mobile Incoming Conflict");
  const mobileRestore = await request(
    `/api/backups/recovery-points/${conflictSummary.recoveryPointId}/restore`,
    { method: "POST" }
  );
  assert.ok(mobileRestore.safetyRecoveryPointId);
  assert.equal((await request(`/api/characters/${character.id}`)).name, metadataUpdatedPrivateCharacter.name);
  const restoredMobileBackup = await request("/api/backups/export");
  assert.deepEqual(restoredMobileBackup.memoryRevisions, backup.memoryRevisions);
  assert.deepEqual(restoredMobileBackup.memoryOperations, backup.memoryOperations);
  assert.deepEqual(restoredMobileBackup.profileSummaryRevisions, backup.profileSummaryRevisions);

  const legacyChatId = "mobile-legacy-chat";
  const legacyMemoryId = "mobile-legacy-memory";
  const legacyBackup = {
    schemaVersion: 1,
    mode: "merge",
    chats: [{ id: legacyChatId, title: "Legacy baseline", characterId: null, userProfileSummary: "" }],
    messages: [],
    memories: [{ id: legacyMemoryId, chatId: legacyChatId, title: "Legacy memory", content: "Legacy current state", keywords: [], importance: 3, enabled: true, sourceMessageIds: [] }]
  };
  const legacyPreview = await request("/api/backups/preview", { method: "POST", body: legacyBackup });
  await request("/api/backups/import", { method: "POST", body: { ...legacyBackup, previewId: legacyPreview.previewId, conflictResolutions: [] } });
  const legacyHistory = await request(`/api/chats/${legacyChatId}/memories/${legacyMemoryId}/revisions`);
  assert.equal(legacyHistory.length, 1);
  assert.equal(legacyHistory[0].action, "baseline");
  const repeatLegacyPreview = await request("/api/backups/preview", { method: "POST", body: legacyBackup });
  await request("/api/backups/import", { method: "POST", body: { ...legacyBackup, previewId: repeatLegacyPreview.previewId, conflictResolutions: repeatLegacyPreview.conflicts.map((conflict) => ({ key: conflict.key, action: "use_incoming" })) } });
  assert.equal((await request(`/api/chats/${legacyChatId}/memories/${legacyMemoryId}/revisions`)).length, 1);
  await permanentlyDeleteChat(legacyChatId);

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

  const pulledSyncPreview = await request("/api/sync/pull", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge",
      phase: "preview"
    }
  });
  assert.equal(pulledSyncPreview.direction, "pull");
  assert.equal(pulledSyncPreview.summary, null);
  const pulledSyncSummary = await request("/api/sync/pull", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge",
      phase: "execute",
      previewId: pulledSyncPreview.preview.previewId,
      conflictResolutions: []
    }
  });
  assert.ok(pulledSyncSummary.summary.skipped > 0);

  const pushedSyncPreview = await request("/api/sync/push", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge",
      phase: "preview"
    }
  });
  const pushedSyncSummary = await request("/api/sync/push", {
    method: "POST",
    body: {
      peerBaseUrl,
      mode: "merge",
      phase: "execute",
      previewId: pushedSyncPreview.preview.previewId,
      conflictResolutions: []
    }
  });
  assert.equal(pushedSyncSummary.direction, "push");
  assert.ok(pushedSyncSummary.summary.skipped > 0);

  console.log("Mobile backend smoke passed");
} finally {
  child.kill();
  fakeModelServer.close();
  await rm(dataDir, { recursive: true, force: true });
}
