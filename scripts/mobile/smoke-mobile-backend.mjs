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

const createFakeModelServer = () => {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "fake-mobile-model" }] }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const body = await readJsonBody(request);
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
    if (joinedMessages.includes("concise local user profile memory")) {
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
      resolve(server);
    });
  });
};

const runGeneration = (chatId, content) =>
  new Promise((resolve, reject) => {
    const requestId = `mobile-smoke-${Date.now()}`;
    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for mobile generation"));
    }, 10_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "generate", requestId, chatId, content }));
    });
    socket.addEventListener("message", (raw) => {
      const event = JSON.parse(String(raw.data));
      events.push(event);
      if (event.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(event.error));
      }
      if (event.type === "generation_done" && event.requestId === requestId) {
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
    providers: [],
    activeProviderId: "",
    activeModelId: "",
    autoSummarizeUser: true,
    showMessageAvatars: false,
    userProfileSummary: ""
  };
  const savedModelSettings = await request("/api/settings", {
    method: "PUT",
    body: modelSettings
  });
  assert.equal(savedModelSettings.showMessageAvatars, false);
  assert.equal(savedModelSettings.hasApiKey, true);

  const switchedModelSettings = await request("/api/settings", {
    method: "PUT",
    body: {
      ...modelSettings,
      apiKey: undefined,
      model: "fake-mobile-model-2",
      showMessageAvatars: undefined,
      autoSummarizeUser: undefined,
      userProfileSummary: undefined
    }
  });
  assert.equal(switchedModelSettings.model, "fake-mobile-model-2");
  assert.equal(switchedModelSettings.showMessageAvatars, false);
  assert.equal(switchedModelSettings.autoSummarizeUser, true);

  const character = await request("/api/characters", {
    method: "POST",
    body: {
      name: "Mobile Smoke Character",
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

  const privateCard = await request(`/api/characters/${character.id}/export`, {
    method: "POST",
    body: {
      visibility: "private",
      password: "open-sesame"
    }
  });
  assert.equal(privateCard.visibility, "private");
  assert.equal(privateCard.protectedPayload.algorithm, "aes-256-gcm");

  const importedPrivateCharacter = await request("/api/characters/import", {
    method: "POST",
    body: privateCard
  });
  assert.equal(importedPrivateCharacter.id, character.id);
  assert.equal(importedPrivateCharacter.visibility, "private");
  assert.equal(importedPrivateCharacter.canViewPrompt, false);
  assert.equal(importedPrivateCharacter.prompt, "");

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

  const generationEvents = await runGeneration(chat.id, "Please remember that I like blue doors.");
  const startedCharacterEvent = generationEvents.find((event) => event.type === "generation_character_started");
  assert.ok(startedCharacterEvent);
  assert.equal(startedCharacterEvent.characterId, character.id);
  assert.ok(generationEvents.some((event) => event.type === "user_profile_updated"));

  const chatAfterGeneration = await request(`/api/chats/${chat.id}`);
  assert.match(chatAfterGeneration.userProfileSummary, /blue doors/i);
  assert.equal(chatAfterGeneration.messages.length, 2);
  assert.equal(chatAfterGeneration.memories.length, 1);
  assert.match(chatAfterGeneration.memories[0].content, /blue door/i);

  const memoryRefresh = await request(`/api/chats/${chat.id}/memories/refresh`, {
    method: "POST"
  });
  assert.ok(memoryRefresh.length >= 1);

  const recallEvents = await runGeneration(chat.id, "What did I say about blue doors?");
  const memoryMatchEvent = recallEvents.find((event) => event.type === "memory_matches");
  assert.ok(memoryMatchEvent);
  assert.equal(memoryMatchEvent.entries.length, 1);
  assert.equal(memoryMatchEvent.entries[0].id, chatAfterGeneration.memories[0].id);

  const backup = await request("/api/backups/export");
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.characters.length, 1);
  assert.equal(backup.chats.length, 1);
  assert.equal(backup.messages.length, 4);
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
