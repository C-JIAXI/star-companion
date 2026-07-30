import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "apps", "server");
const migrationsDir = path.join(serverDir, "prisma", "migrations");
const prismaTmpRoot = path.join(serverDir, "prisma", ".tmp");
const tsxCliPath = path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message) => {
  console.log(`[smoke-api] ${message}`);
};

const formatCommand = (command, args) => [command, ...args].join(" ");

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${code}: ${formatCommand(command, args)}\n${stdout}${stderr}`
        )
      );
    });
  });

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a free port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const parseJsonBody = async (response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

const request = async (baseUrl, pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? { Accept: "application/json" }
        : {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = await parseJsonBody(response);
  const expectedStatus = options.expectedStatus ?? 200;

  if (response.status !== expectedStatus) {
    throw new Error(
      `Expected ${options.method ?? "GET"} ${pathname} to return ${expectedStatus}, got ${response.status}\n${JSON.stringify(payload, null, 2)}`
    );
  }

  return payload;
};

const requestData = async (baseUrl, pathname, options = {}) => {
  const payload = await request(baseUrl, pathname, options);

  if (!payload?.ok) {
    throw new Error(
      `API reported failure for ${options.method ?? "GET"} ${pathname}\n${JSON.stringify(payload, null, 2)}`
    );
  }

  return payload.data;
};

const permanentlyDeleteChat = async (baseUrl, chatId) => {
  await request(baseUrl, `/api/chats/${chatId}`, { method: "DELETE", expectedStatus: 204 });
  await request(baseUrl, `/api/chats/${chatId}/permanent`, { method: "DELETE", expectedStatus: 204 });
};

const runSocketRequest = (baseUrl, input) =>
  new Promise((resolve, reject) => {
    const requestId = `smoke-ws-${Date.now()}`;
    const events = [];
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
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
      if (event.type === "error" && event.requestId === requestId) {
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

const createFakeModelServer = (port) => {
  let chatCompletionRequests = 0;
  let lastChatCompletionBody = null;

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "fake-agent-model" }] }));
      return;
    }

    if (request.method === "POST" && request.url === "/audio/transcriptions") {
      await readRawBody(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: "transcribed smoke audio" }));
      return;
    }

    if (request.method === "POST" && request.url === "/audio/speech") {
      await readJsonBody(request);
      response.setHeader("Content-Type", "audio/mpeg");
      response.end(Buffer.from("fake-audio"));
      return;
    }

    if (request.method === "POST" && request.url === "/images/generations") {
      await readJsonBody(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }));
      return;
    }

    if (request.method === "POST" && request.url === "/embeddings") {
      const body = await readJsonBody(request);
      const inputs = Array.isArray(body.input) ? body.input : [];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          model: body.model,
          data: inputs.map((_input, index) => ({ index, embedding: [1, 0, 0] }))
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
    const joinedMessages = (body.messages ?? []).map((message) => message.content ?? "").join("\n\n");
    const content = joinedMessages.includes("read-only context assistant")
      ? "Agent draft: check the smoke path and ask for the next diagnostic signal."
      : joinedMessages.includes("Generate a concise title for this local-first")
        ? '"Smoke Title Suggestion"'
        : "Smoke model reply.";

    if (body.stream) {
      const streamContent = joinedMessages.includes("Continue the immediately preceding assistant reply")
        ? " Continued."
        : "Smoke model reply.";
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: streamContent } }] })}\n\n`);
      response.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        close: () => server.close(),
        getChatCompletionRequests: () => chatCompletionRequests,
        getLastChatCompletionBody: () => lastChatCompletionBody
      });
    });
  });
};

const removeWithRetry = async (target) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "EBUSY" || error.code === "EPERM")
      ) {
        await delay(250 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  await rm(target, { recursive: true, force: true });
};

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");

  try {
    await Promise.race([once(child, "exit"), delay(5_000)]);
  } catch {}

  if (child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    await runCommand("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(() => {});
    return;
  }

  child.kill("SIGKILL");
  await once(child, "exit").catch(() => {});
};

const startServer = (env) => {
  const child = spawn(process.execPath, [tsxCliPath, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    output: () => `${stdout}${stderr}`
  };
};

const waitForHealth = async (baseUrl, server) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 20_000) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy\n${server.output()}`);
    }

    try {
      const payload = await request(baseUrl, "/api/health");
      if (payload?.ok === true && payload.database === "connected") {
        return payload;
      }
    } catch {}

    await delay(250);
  }

  throw new Error(`Timed out waiting for server health\n${server.output()}`);
};

const initializeFreshDatabase = async (dbPath) => {
  const db = new DatabaseSync(dbPath);

  try {
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const migrationNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const migrationName of migrationNames) {
      const sql = await readFile(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
      db.exec(sql);
    }
  } finally {
    db.close();
  }
};

const main = async () => {
  const runId = `smoke-api-${Date.now()}`;
  const port = await getFreePort();
  const modelPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDbDir = path.join(prismaTmpRoot, runId);
  const tempDbPath = path.join(tempDbDir, "smoke.db");
  const databaseUrl = `file:./.tmp/${runId}/smoke.db`;
  const env = {
    DATABASE_URL: databaseUrl,
    SERVER_PORT: String(port),
    CORS_ORIGIN: "http://127.0.0.1:5173",
    API_KEY_ENCRYPTION_SECRET: `smoke-secret-${runId}-0123456789abcdef`
  };

  let server = null;
  let fakeModelServer = null;

  await mkdir(tempDbDir, { recursive: true });

  try {
    fakeModelServer = await createFakeModelServer(modelPort);

    // Prisma schema engine currently fails on fresh SQLite in this environment,
    // so smoke tests bootstrap the schema by replaying committed migration SQL.
    log("Initializing a fresh smoke database from Prisma migration SQL");
    await initializeFreshDatabase(tempDbPath);

    log("Starting isolated API server");
    server = startServer(env);
    const health = await waitForHealth(baseUrl, server);
    assert.equal(health.ok, true);
    assert.equal(health.database, "connected");

    log("Verifying settings lifecycle");
    const initialSettings = await requestData(baseUrl, "/api/settings");
    assert.equal(initialSettings.hasApiKey, false);
    assert.equal("apiKey" in initialSettings, false);

    const settingsPayload = {
      activeProvider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${modelPort}`,
      apiKey: "sk-smoke-test-key",
      model: "fake-agent-model",
      temperature: 0.7,
      maxTokens: 1024,
      topP: 0.95,
      language: "en",
      autoSummarizeUser: false,
      showMessageAvatars: false,
      showMessageTimestamps: true,
      ttsVoice: "nova",
      ttsPlaybackRate: 1.25,
      ttsAutoPlay: true,
      userProfileSummary: "",
      providers: [
        {
          id: "smoke-provider",
          label: "Smoke Provider",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${modelPort}`,
          key: "smoke-provider-key",
          models: [
            {
              id: "smoke-model",
              label: "Smoke Model",
              model: "fake-agent-model",
              capabilities: [
                "text_generation",
                "text_embedding",
                "audio_transcription",
                "text_to_speech",
                "image_generation"
              ]
            }
          ]
        }
      ],
      activeProviderId: "smoke-provider",
      activeModelId: "smoke-model",
      moduleModelPreferences: {
        agent: { providerId: "smoke-provider", modelId: "smoke-model" },
        memory_embedding: { providerId: "smoke-provider", modelId: "smoke-model" },
        image_generation: { providerId: "smoke-provider", modelId: "smoke-model" }
      },
      userPersonaPresets: [
        {
          id: "smoke-persona",
          name: "Smoke Persona",
          config: {
            prefix: "User boundary.",
            prompt: "User likes practical tests.",
            suffix: "Keep it brief."
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    };
    const updatedSettings = await requestData(baseUrl, "/api/settings", {
      method: "PUT",
      body: settingsPayload
    });
    assert.equal(updatedSettings.language, "en");
    assert.equal(updatedSettings.showMessageAvatars, false);
    assert.equal(updatedSettings.showMessageTimestamps, true);
    assert.equal(updatedSettings.ttsVoice, "nova");
    assert.equal(updatedSettings.ttsPlaybackRate, 1.25);
    assert.equal(updatedSettings.ttsAutoPlay, true);
    assert.equal(updatedSettings.hasApiKey, true);
    assert.equal("apiKey" in updatedSettings, false);
    assert.equal("key" in updatedSettings.providers[0], false);
    assert.equal(updatedSettings.providers[0]?.hasKey, true);
    assert.deepEqual(updatedSettings.moduleModelPreferences.agent, {
      providerId: "smoke-provider",
      modelId: "smoke-model"
    });
    assert.equal(updatedSettings.userPersonaPresets[0]?.name, "Smoke Persona");
    assert.equal(updatedSettings.userPersonaPresets[0]?.config.prompt, "User likes practical tests.");

    const preservedSettings = await requestData(baseUrl, "/api/settings", {
      method: "PUT",
      body: {
        ...settingsPayload,
        apiKey: undefined,
        moduleModelPreferences: undefined,
        userPersonaPresets: undefined,
        providers: updatedSettings.providers
      }
    });
    assert.deepEqual(preservedSettings.moduleModelPreferences.agent, {
      providerId: "smoke-provider",
      modelId: "smoke-model"
    });
    assert.equal(preservedSettings.userPersonaPresets[0]?.name, "Smoke Persona");
    assert.equal(preservedSettings.ttsVoice, "nova");
    assert.equal(preservedSettings.ttsPlaybackRate, 1.25);
    assert.equal(preservedSettings.ttsAutoPlay, true);
    assert.equal("key" in preservedSettings.providers[0], false);
    assert.equal(preservedSettings.providers[0]?.hasKey, true);

    const importedProviderModels = await requestData(
      baseUrl,
      "/api/settings/providers/smoke-provider/models",
      {
        method: "POST",
        body: {
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${modelPort}`
        }
      }
    );
    assert.deepEqual(importedProviderModels.models, ["fake-agent-model"]);

    const profileSettings = await requestData(baseUrl, "/api/settings/user-profile", {
      method: "PUT",
      body: {
        userProfileSummary: "Prefers terse technical answers.",
        autoSummarizeUser: false
      }
    });
    assert.equal(profileSettings.userProfileSummary, "Prefers terse technical answers.");
    assert.equal(profileSettings.autoSummarizeUser, false);
    assert.notEqual(profileSettings.userProfileUpdatedAt, null);

    const fetchedSettings = await requestData(baseUrl, "/api/settings");
    assert.equal(fetchedSettings.hasApiKey, true);
    assert.equal(fetchedSettings.userProfileSummary, "Prefers terse technical answers.");
    assert.equal("apiKey" in fetchedSettings, false);

    const testRequestCountBefore = fakeModelServer.getChatCompletionRequests();
    const connectionTest = await requestData(baseUrl, "/api/settings/test", { method: "POST" });
    assert.equal(connectionTest.reachable, true);
    assert.equal(connectionTest.model, "fake-agent-model");
    assert.equal(fakeModelServer.getChatCompletionRequests(), testRequestCountBefore + 1);
    assert.equal(fakeModelServer.getLastChatCompletionBody().model, "fake-agent-model");
    assert.equal(fakeModelServer.getLastChatCompletionBody().stream, false);

    log("Verifying character CRUD, paging, export, import, and unlock flows");
    const localAvatar = "data:image/png;base64,QUJDRA==";
    const characterPayload = {
      name: `Smoke Character ${runId}`,
      avatar: localAvatar,
      description: "Character used by the API smoke test.",
      tags: ["smoke", "sentinel"],
      prefix: "Stay in character.",
      prompt: "You are a smoke-test sentinel.",
      suffix: "Reply with crisp answers.",
      htmlCss: ".smoke-card { color: #abc; }",
      openingHtml: "<section>Smoke opening</section>",
      loreEntries: [
        {
          id: "smoke-lore-1",
          keys: ["smoke", "sentinel"],
          content: "Sentinel context stays available during the smoke test.",
          priority: 1,
          scope: "prompt",
          triggerMode: "both",
          alwaysActive: false,
          enabled: true
        }
      ],
      quickReplies: [
        {
          id: "smoke-quick-1",
          label: "Status",
          content: "Give me the current system status."
        }
      ]
    };
    const createdCharacter = await requestData(baseUrl, "/api/characters", {
      method: "POST",
      expectedStatus: 201,
      body: characterPayload
    });
    assert.equal(createdCharacter.visibility, "public");
    assert.equal(createdCharacter.canViewPrompt, true);
    assert.equal(typeof createdCharacter.cardId, "string");
    assert.equal(createdCharacter.cardId.length > 0, true);
    assert.equal(createdCharacter.avatar, localAvatar);
    assert.deepEqual(createdCharacter.tags, characterPayload.tags);

    const characterList = await requestData(baseUrl, "/api/characters");
    assert.equal(characterList.some((item) => item.id === createdCharacter.id), true);

    const pagedCharacters = await requestData(
      baseUrl,
      `/api/characters/page?${new URLSearchParams({
        q: "Smoke Character",
        page: "1",
        pageSize: "10"
      }).toString()}`
    );
    assert.equal(pagedCharacters.total >= 1, true);
    assert.equal(pagedCharacters.items.some((item) => item.id === createdCharacter.id), true);
    assert.equal(pagedCharacters.availableTags.includes("sentinel"), true);

    const tagFilteredCharacters = await requestData(
      baseUrl,
      `/api/characters/page?${new URLSearchParams({
        tag: "sentinel",
        page: "1",
        pageSize: "10"
      }).toString()}`
    );
    assert.equal(tagFilteredCharacters.items.some((item) => item.id === createdCharacter.id), true);

    const promptOnlySearchCharacters = await requestData(
      baseUrl,
      `/api/characters/page?${new URLSearchParams({
        q: "smoke-test sentinel",
        page: "1",
        pageSize: "10"
      }).toString()}`
    );
    assert.equal(promptOnlySearchCharacters.items.some((item) => item.id === createdCharacter.id), false);

    const fetchedCharacter = await requestData(baseUrl, `/api/characters/${createdCharacter.id}`);
    assert.equal(
      fetchedCharacter.prompt,
      characterPayload.prompt,
      "created character should keep its prompt"
    );

    const characterUpdatePayload = {
      description: "Updated smoke character description.",
      openingHtml: "<section>Updated smoke opening</section>",
      quickReplies: [
        {
          id: "smoke-quick-2",
          label: "Diagnostics",
          content: "List the current smoke diagnostics."
        }
      ]
    };
    const updatedCharacter = await requestData(baseUrl, `/api/characters/${createdCharacter.id}`, {
      method: "PUT",
      body: characterUpdatePayload
    });
    assert.equal(updatedCharacter.description, characterUpdatePayload.description);
    assert.equal(updatedCharacter.openingHtml, characterUpdatePayload.openingHtml);
    assert.equal(updatedCharacter.quickReplies[0].label, "Diagnostics");

    const favoriteCharacter = await requestData(baseUrl, `/api/characters/${createdCharacter.id}`, {
      method: "PUT",
      body: { isFavorite: true }
    });
    assert.equal(favoriteCharacter.isFavorite, true);
    const favoriteCharacters = await requestData(
      baseUrl,
      `/api/characters/page?${new URLSearchParams({ favoriteOnly: "true" }).toString()}`
    );
    assert.equal(favoriteCharacters.items.some((item) => item.id === createdCharacter.id), true);
    assert.equal(favoriteCharacters.items.every((item) => item.isFavorite === true), true);

    const fetchedCharacterAfterUpdate = await requestData(
      baseUrl,
      `/api/characters/${createdCharacter.id}`
    );
    assert.equal(
      fetchedCharacterAfterUpdate.prompt,
      characterPayload.prompt,
      "updating non-prompt fields should not clear the saved prompt"
    );

    const publicCard = await requestData(baseUrl, `/api/characters/${createdCharacter.id}/export`, {
      method: "POST",
      body: {
        visibility: "public"
      }
    });
    assert.equal(publicCard.visibility, "public");
    assert.equal(publicCard.cardId, createdCharacter.cardId);
    assert.equal(
      publicCard.character.prompt,
      characterPayload.prompt,
      "public export should keep the current prompt"
    );
    assert.deepEqual(publicCard.character.tags, characterPayload.tags);
    assert.equal(publicCard.character.avatar, localAvatar);
    assert.equal("isFavorite" in publicCard.character, false);

    const renamedPublicCard = {
      ...publicCard,
      character: {
        ...publicCard.character,
        name: `${publicCard.character.name} Renamed`
      }
    };

    const importedPublicCharacter = await requestData(baseUrl, "/api/characters/import", {
      method: "POST",
      body: renamedPublicCard
    });
    assert.equal(
      importedPublicCharacter.id,
      createdCharacter.id,
      "same-card public import should update the existing character even when the name changes"
    );
    assert.equal(importedPublicCharacter.cardId, createdCharacter.cardId);
    assert.equal(importedPublicCharacter.name, renamedPublicCard.character.name);
    assert.equal(importedPublicCharacter.visibility, "public");
    assert.equal(
      importedPublicCharacter.prompt,
      characterPayload.prompt,
      "public import should keep the exported prompt"
    );
    assert.deepEqual(importedPublicCharacter.tags, characterPayload.tags);

    const privatePassword = "smoke-private-password";
    const privateCard = await requestData(baseUrl, `/api/characters/${createdCharacter.id}/export`, {
      method: "POST",
      body: {
        visibility: "private",
        password: privatePassword
      }
    });
    assert.equal(privateCard.visibility, "private");
    assert.equal(privateCard.cardId, createdCharacter.cardId);
    assert.equal("prompt" in privateCard.character, false);

    const importablePrivateCard = {
      ...privateCard,
      cardId: `${privateCard.cardId}-private-import-${runId}`,
      character: {
        ...privateCard.character,
        name: `${privateCard.character.name} Private Import ${runId}`
      }
    };

    const importedPrivateCharacter = await requestData(baseUrl, "/api/characters/import", {
      method: "POST",
      expectedStatus: 201,
      body: importablePrivateCard
    });
    assert.equal(importedPrivateCharacter.visibility, "private");
    assert.equal(importedPrivateCharacter.cardId, importablePrivateCard.cardId);
    assert.equal(importedPrivateCharacter.canViewPrompt, false);
    assert.equal(importedPrivateCharacter.prompt, "");

    const renamedPrivateCard = {
      ...importablePrivateCard,
      character: {
        ...importablePrivateCard.character,
        name: `${importablePrivateCard.character.name} Renamed`
      }
    };

    const importedPrivateBackupCharacter = await requestData(baseUrl, "/api/characters/import", {
      method: "POST",
      body: renamedPrivateCard
    });
    assert.equal(
      importedPrivateBackupCharacter.id,
      importedPrivateCharacter.id,
      "same-card private import should update the existing imported character even when the name changes"
    );
    assert.equal(importedPrivateBackupCharacter.name, renamedPrivateCard.character.name);
    assert.equal(importedPrivateBackupCharacter.visibility, "private");
    assert.equal(importedPrivateBackupCharacter.canViewPrompt, false);
    assert.equal(importedPrivateBackupCharacter.prompt, "");

    const duplicatedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${importedPrivateCharacter.id}/duplicate`,
      {
        method: "POST",
        expectedStatus: 201,
        body: { name: `AAA Smoke Character Copy ${runId}` }
      }
    );
    assert.notEqual(duplicatedPrivateCharacter.id, importedPrivateCharacter.id);
    assert.notEqual(duplicatedPrivateCharacter.cardId, importedPrivateCharacter.cardId);
    assert.equal(duplicatedPrivateCharacter.visibility, "private");
    assert.equal(duplicatedPrivateCharacter.canViewPrompt, false);
    assert.equal(duplicatedPrivateCharacter.isFavorite, false);
    const batchTagAdd = await requestData(baseUrl, "/api/characters/batch-tags", {
      method: "POST",
      body: {
        ids: [createdCharacter.id, duplicatedPrivateCharacter.id],
        operation: "add",
        tags: ["batch-managed", "sentinel"]
      }
    });
    assert.equal(batchTagAdd.updated, 2);
    const batchTaggedPublicCharacter = await requestData(
      baseUrl,
      `/api/characters/${createdCharacter.id}`
    );
    const batchTaggedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${duplicatedPrivateCharacter.id}`
    );
    assert.equal(batchTaggedPublicCharacter.tags.includes("batch-managed"), true);
    assert.equal(batchTaggedPublicCharacter.tags.filter((tag) => tag === "sentinel").length, 1);
    assert.equal(batchTaggedPrivateCharacter.tags.includes("batch-managed"), true);
    assert.equal(batchTaggedPrivateCharacter.canViewPrompt, false);
    const batchTagRemove = await requestData(baseUrl, "/api/characters/batch-tags", {
      method: "POST",
      body: {
        ids: [createdCharacter.id, duplicatedPrivateCharacter.id],
        operation: "remove",
        tags: ["batch-managed"]
      }
    });
    assert.equal(batchTagRemove.updated, 2);
    assert.equal(
      (
        await requestData(baseUrl, `/api/characters/${duplicatedPrivateCharacter.id}`)
      ).tags.includes("batch-managed"),
      false
    );
    const nameSortedCharacters = await requestData(
      baseUrl,
      `/api/characters/page?${new URLSearchParams({ q: "Smoke Character", sort: "name_asc" }).toString()}`
    );
    assert.equal(nameSortedCharacters.items[0]?.id, duplicatedPrivateCharacter.id);
    await request(baseUrl, `/api/characters/${duplicatedPrivateCharacter.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });

    const unlockedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${importedPrivateCharacter.id}/unlock`,
      {
        method: "POST",
        body: {
          password: privatePassword
        }
      }
    );
    assert.equal(unlockedPrivateCharacter.canViewPrompt, true);
    assert.equal(
      unlockedPrivateCharacter.prompt,
      characterPayload.prompt,
      "private unlock should reveal the stored prompt"
    );

    log("Verifying chat and message flows");
    const chatPayload = {
      title: `Smoke Chat ${runId}`,
      characterId: createdCharacter.id,
      backgroundUrl: "https://example.com/background.png",
      memoryTurns: 10,
      userPersona: "Be direct.",
      userProfileSummary: "Prefers terse technical answers."
    };
    const createdChat = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: chatPayload
    });
    assert.equal(createdChat.characterId, createdCharacter.id);
    assert.equal(createdChat.autoMemoryEnabled, true);

    const listedChats = await requestData(baseUrl, "/api/chats");
    const listedChat = listedChats.find((item) => item.id === createdChat.id);
    assert.ok(listedChat);
    assert.equal(listedChat.messageCount, 0);

    const openingChat = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: {
        title: `Smoke Opening Chat ${runId}`,
        characterId: createdCharacter.id
      }
    });
    const openingMessage = await requestData(baseUrl, `/api/chats/${openingChat.id}/opening-message`, {
      method: "POST",
      expectedStatus: 201
    });
    assert.equal(openingMessage.role, "assistant");
    assert.equal(openingMessage.characterId, createdCharacter.id);
    assert.equal(openingMessage.variants.length, 1);
    assert.match(openingMessage.content, /Smoke model reply/);
    const openingChatWithMessages = await requestData(baseUrl, `/api/chats/${openingChat.id}`);
    assert.equal(openingChatWithMessages.messages.length, 1);
    await request(baseUrl, `/api/chats/${openingChat.id}/opening-message`, {
      method: "POST",
      expectedStatus: 409
    });
    await request(baseUrl, `/api/chats/${openingChat.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });
    const chatsWithTrashedOpening = await requestData(baseUrl, "/api/chats");
    assert.ok(chatsWithTrashedOpening.find((chat) => chat.id === openingChat.id)?.deletedAt);
    const backupWithTrashedOpening = await requestData(baseUrl, "/api/backups/export");
    assert.ok(backupWithTrashedOpening.chats.find((chat) => chat.id === openingChat.id)?.deletedAt);
    await request(baseUrl, `/api/chats/${openingChat.id}`, { expectedStatus: 404 });
    const restoredOpeningChat = await requestData(baseUrl, `/api/chats/${openingChat.id}/restore`, {
      method: "POST"
    });
    assert.equal(restoredOpeningChat.deletedAt, null);
    assert.equal((await requestData(baseUrl, `/api/chats/${openingChat.id}`)).messages.length, 1);
    await permanentlyDeleteChat(baseUrl, openingChat.id);

    const updatedChat = await requestData(baseUrl, `/api/chats/${createdChat.id}`, {
      method: "PUT",
      body: {
        backgroundUrl: "https://example.com/background-updated.png",
        memoryTurns: 16,
        autoMemoryEnabled: false,
        isPinned: true,
        isArchived: true,
        userPersona: "Focus on concise diagnostics."
      }
    });
    assert.equal(updatedChat.backgroundUrl, "https://example.com/background-updated.png");
    assert.equal(updatedChat.memoryTurns, 16);
    assert.equal(updatedChat.autoMemoryEnabled, false);
    assert.equal(updatedChat.isPinned, true);
    assert.equal(updatedChat.isArchived, true);

    const restoredBatch = await requestData(baseUrl, "/api/chats/batch-archive", {
      method: "POST",
      body: { ids: [createdChat.id], isArchived: false }
    });
    assert.equal(restoredBatch.updated, 1);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).isArchived, false);
    const archivedBatch = await requestData(baseUrl, "/api/chats/batch-archive", {
      method: "POST",
      body: { ids: [createdChat.id], isArchived: true }
    });
    assert.equal(archivedBatch.updated, 1);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).isArchived, true);

    const activeOrderingChat = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: { title: `Smoke Active Ordering ${runId}`, characterId: createdCharacter.id }
    });
    const chatsAfterPin = await requestData(baseUrl, "/api/chats");
    assert.equal(chatsAfterPin[0]?.id, activeOrderingChat.id);
    assert.equal(chatsAfterPin.find((chat) => chat.id === createdChat.id)?.isArchived, true);
    await permanentlyDeleteChat(baseUrl, activeOrderingChat.id);

    const batchTrashChats = [];
    for (const title of [`Smoke Batch Trash A ${runId}`, `Smoke Batch Trash B ${runId}`]) {
      batchTrashChats.push(
        await requestData(baseUrl, "/api/chats", {
          method: "POST",
          expectedStatus: 201,
          body: { title, characterId: createdCharacter.id }
        })
      );
    }
    const batchTrashIds = batchTrashChats.map((chat) => chat.id);
    assert.equal(
      (await requestData(baseUrl, "/api/chats/batch-trash", {
        method: "POST",
        body: { ids: batchTrashIds, action: "trash" }
      })).updated,
      2
    );
    assert.equal(
      (await requestData(baseUrl, "/api/chats/batch-trash", {
        method: "POST",
        body: { ids: batchTrashIds, action: "restore" }
      })).updated,
      2
    );
    await requestData(baseUrl, "/api/chats/batch-trash", {
      method: "POST",
      body: { ids: batchTrashIds, action: "trash" }
    });
    assert.equal(
      (await requestData(baseUrl, "/api/chats/batch-permanent-delete", {
        method: "POST",
        body: { ids: batchTrashIds }
      })).deleted,
      2
    );

    const createdMemory = await requestData(baseUrl, `/api/chats/${createdChat.id}/memories`, {
      method: "POST",
      expectedStatus: 201,
      body: {
        title: "Smoke memory",
        content: "The smoke path should stay nominal across checks.",
        keywords: ["smoke", "nominal"],
        importance: 4,
        enabled: true
      }
    });
    assert.equal(createdMemory.title, "Smoke memory");
    assert.equal(createdMemory.keywords.length, 2);
    assert.equal(createdMemory.embeddingModel, "openai-compatible:fake-agent-model");
    assert.ok(createdMemory.embeddingUpdatedAt);
    assert.equal("embedding" in createdMemory, false);

    const listedMemories = await requestData(baseUrl, `/api/chats/${createdChat.id}/memories`);
    assert.equal(listedMemories.length, 1);

    const updatedMemory = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/${createdMemory.id}`,
      {
        method: "PUT",
        body: {
          enabled: false,
          importance: 5
        }
      }
    );
    assert.equal(updatedMemory.enabled, false);
    assert.equal(updatedMemory.importance, 5);

    const userMessage = await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: {
        chatId: createdChat.id,
        role: "user",
        content: "Check the smoke path."
      }
    });
    assert.equal(userMessage.role, "user");

    const assistantMessage = await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: {
        chatId: createdChat.id,
        role: "assistant",
        characterId: createdCharacter.id,
        content: "Nominal status confirmed.",
        variants: ["Smoke path is nominal.", "Nominal status confirmed."],
        activeVariantIndex: 1,
        tokenUsage: {
          promptTokens: 12,
          completionTokens: 7,
          totalTokens: 19,
          estimated: true
        },
        loreMatches: [
          {
            id: "smoke-lore-1",
            characterId: createdCharacter.id,
            characterName: createdCharacter.name,
            keys: ["smoke"],
            content: "Sentinel context stays available during the smoke test.",
            priority: 1,
            scope: "prompt",
            triggerMode: "both",
            alwaysActive: false,
            enabled: true
          }
        ],
        memoryMatches: [
          {
            id: createdMemory.id,
            chatId: createdChat.id,
            title: "Smoke memory",
            content: "The smoke path should stay nominal across checks.",
            keywords: ["smoke", "nominal"],
            importance: 5,
            enabled: false
          }
        ]
      }
    });
    assert.equal(assistantMessage.role, "assistant");
    assert.equal(assistantMessage.activeVariantIndex, 1);
    assert.equal(assistantMessage.tokenUsage.totalTokens, 19);
    assert.equal(assistantMessage.memoryMatches[0].id, createdMemory.id);

    const excludedUserMessage = await requestData(baseUrl, `/api/messages/${userMessage.id}`, {
      method: "PUT",
      body: { contextIncluded: false, isBookmarked: true }
    });
    assert.equal(excludedUserMessage.contextIncluded, false);
    assert.equal(excludedUserMessage.isBookmarked, true);

    const globalMessageSearch = await requestData(
      baseUrl,
      `/api/chats/message-search?${new URLSearchParams({ q: "Smoke path", limit: "5" }).toString()}`
    );
    assert.ok(globalMessageSearch.total >= 1);
    assert.equal(globalMessageSearch.results[0]?.chat.id, createdChat.id);
    assert.equal(globalMessageSearch.results[0]?.chat.isArchived, true);
    assert.match(globalMessageSearch.results[0]?.snippet ?? "", /Smoke path/i);

    const continuationEvents = await runSocketRequest(baseUrl, {
      type: "continue",
      messageId: assistantMessage.id
    });
    const continuedMessage = continuationEvents.find((event) => event.type === "assistant_message")?.message;
    assert.equal(continuedMessage?.id, assistantMessage.id);
    assert.equal(continuedMessage?.content, "Nominal status confirmed. Continued.");
    assert.equal(continuedMessage?.variants.length, 2);
    assert.equal(continuedMessage?.variants[1], "Nominal status confirmed. Continued.");

    const listedMessages = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(listedMessages.length, 2);
    assert.equal(listedMessages[1]?.content, "Nominal status confirmed. Continued.");

    const chatsWithPreview = await requestData(baseUrl, "/api/chats");
    const chatListPreview = chatsWithPreview.find((chat) => chat.id === createdChat.id);
    assert.equal(chatListPreview?.messageCount, 2);
    assert.equal(chatListPreview?.lastMessagePreview?.role, "assistant");
    assert.equal(
      chatListPreview?.lastMessagePreview?.content,
      "Nominal status confirmed. Continued."
    );
    assert.ok(chatListPreview?.lastMessagePreview?.createdAt);

    const chatWithMessages = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatWithMessages.messages.length, 2);

    const messageSearch = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/message-search?${new URLSearchParams({
        q: "nominal",
        limit: "5"
      }).toString()}`
    );
    assert.equal(messageSearch.total, 1);
    assert.equal(messageSearch.results[0]?.index, 1);
    assert.equal(messageSearch.results[0]?.message.id, assistantMessage.id);
    assert.match(messageSearch.results[0]?.snippet ?? "", /nominal/i);

    const titleSuggestion = await requestData(baseUrl, `/api/chats/${createdChat.id}/title-suggestion`, {
      method: "POST"
    });
    assert.equal(titleSuggestion.title, "Smoke Title Suggestion");
    const chatAfterTitleSuggestion = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatAfterTitleSuggestion.title, createdChat.title);
    assert.equal(chatAfterTitleSuggestion.messages.length, 2);

    const agentDraft = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent-draft`, {
      method: "POST",
      body: {
        mode: "next_steps",
        focus: "smoke path"
      }
    });
    assert.equal(agentDraft.mode, "next_steps");
    assert.match(agentDraft.content, /Agent draft/);
    assert.equal(Array.isArray(agentDraft.matchedLoreEntries), true);
    assert.equal(Array.isArray(agentDraft.matchedMemoryEntries), true);
    const chatAfterAgentDraft = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatAfterAgentDraft.messages.length, 2);
    assert.equal(chatAfterAgentDraft.memories.length, 1);

    const chatArchive = await requestData(baseUrl, `/api/chats/${createdChat.id}/archive`);
    assert.equal(chatArchive.archiveVersion, 1);
    assert.equal(chatArchive.messages.length, 2);
    assert.equal(chatArchive.messages[0]?.contextIncluded, false);
    assert.equal(chatArchive.messages[0]?.isBookmarked, true);
    assert.equal(chatArchive.memories.length, 1);
    assert.equal(chatArchive.chat.isArchived, true);
    const importedArchive = await requestData(baseUrl, "/api/chats/import-archive", {
      method: "POST",
      expectedStatus: 201,
      body: { archive: chatArchive, title: "Imported Smoke Archive" }
    });
    assert.notEqual(importedArchive.id, createdChat.id);
    assert.equal(importedArchive.title, "Imported Smoke Archive");
    assert.equal(importedArchive.messages.length, 2);
    assert.equal(importedArchive.messages[0]?.contextIncluded, false);
    assert.equal(importedArchive.messages[0]?.isBookmarked, true);
    assert.equal(importedArchive.memories.length, 1);
    assert.equal(importedArchive.isArchived, false);
    await permanentlyDeleteChat(baseUrl, importedArchive.id);

    const branchedChat = await requestData(baseUrl, `/api/chats/${createdChat.id}/branches`, {
      method: "POST",
      expectedStatus: 201,
      body: {
        messageId: assistantMessage.id,
        title: "Smoke Branch"
      }
    });
    assert.equal(branchedChat.title, "Smoke Branch");
    assert.equal(branchedChat.parentChatId, createdChat.id);
    assert.equal(branchedChat.branchSourceMessageId, assistantMessage.id);
    assert.equal(branchedChat.messages.length, 2);
    assert.equal(branchedChat.messages[0]?.contextIncluded, false);
    assert.equal(branchedChat.messages[0]?.isBookmarked, true);
    assert.equal(branchedChat.memories.length, 0);
    await permanentlyDeleteChat(baseUrl, branchedChat.id);

    const checkpointChat = await requestData(baseUrl, `/api/chats/${createdChat.id}/branches`, {
      method: "POST",
      expectedStatus: 201,
      body: { messageId: assistantMessage.id, title: "Smoke Checkpoint", kind: "checkpoint" }
    });
    assert.equal(checkpointChat.isCheckpoint, true);
    assert.equal(checkpointChat.parentChatId, createdChat.id);
    assert.equal(checkpointChat.messages.length, 2);
    assert.equal(checkpointChat.memories.length, 0);
    await permanentlyDeleteChat(baseUrl, checkpointChat.id);

    const lineageParent = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: { title: "Lineage cleanup parent", characterId: createdCharacter.id }
    });
    const lineageSource = await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: { chatId: lineageParent.id, role: "user", content: "Lineage source" }
    });
    const detachedBranch = await requestData(baseUrl, `/api/chats/${lineageParent.id}/branches`, {
      method: "POST",
      expectedStatus: 201,
      body: { messageId: lineageSource.id, title: "Lineage cleanup branch" }
    });
    await request(baseUrl, `/api/chats/${lineageParent.id}`, { method: "DELETE", expectedStatus: 204 });
    const branchWhileParentIsTrashed = await requestData(baseUrl, `/api/chats/${detachedBranch.id}`);
    assert.equal(branchWhileParentIsTrashed.parentChatId, lineageParent.id);
    await request(baseUrl, `/api/chats/${lineageParent.id}/permanent`, {
      method: "DELETE",
      expectedStatus: 204
    });
    const detachedBranchAfterParentDelete = await requestData(baseUrl, `/api/chats/${detachedBranch.id}`);
    assert.equal(detachedBranchAfterParentDelete.parentChatId, null);
    assert.equal(detachedBranchAfterParentDelete.branchSourceMessageId, null);
    await permanentlyDeleteChat(baseUrl, detachedBranch.id);

    const transcription = await requestData(baseUrl, "/api/media/voice/transcriptions", {
      method: "POST",
      body: {
        audioBase64: Buffer.from("fake audio").toString("base64"),
        mimeType: "audio/webm"
      }
    });
    assert.equal(transcription.text, "transcribed smoke audio");
    assert.equal(transcription.model, "fake-agent-model");

    const speech = await requestData(baseUrl, "/api/media/voice/speech", {
      method: "POST",
      body: { text: "Read this smoke line.", voice: "alloy", format: "mp3" }
    });
    assert.equal(speech.audioBase64, Buffer.from("fake-audio").toString("base64"));

    const image = await requestData(baseUrl, "/api/media/images/generations", {
      method: "POST",
      body: { prompt: "smoke image", size: "1024x1024" }
    });
    assert.equal(image.images[0]?.b64Json, Buffer.from("fake-image").toString("base64"));

    const updatedMessage = await requestData(baseUrl, `/api/messages/${assistantMessage.id}`, {
      method: "PUT",
      body: {
        content: "Smoke path remains nominal.",
        variants: ["Smoke path remains nominal.", "Nominal status confirmed."],
        activeVariantIndex: 0
      }
    });
    assert.equal(updatedMessage.content, "Smoke path remains nominal.");
    assert.equal(updatedMessage.activeVariantIndex, 0);

    const fetchedMessage = await requestData(baseUrl, `/api/messages/${assistantMessage.id}`);
    assert.equal(fetchedMessage.content, "Smoke path remains nominal.");

    log("Verifying backup export/import and delete flows");
    const exportedBackup = await requestData(baseUrl, "/api/backups/export");
    assert.equal(exportedBackup.schemaVersion, 1);
    assert.ok(exportedBackup.settings);
    assert.equal(exportedBackup.characters.length, 2);
    assert.equal(exportedBackup.chats.length, 1);
    assert.equal(exportedBackup.chats[0]?.isPinned, true);
    assert.equal(exportedBackup.chats[0]?.isArchived, true);
    assert.equal(exportedBackup.messages.length, 2);
    assert.equal(exportedBackup.memories.length, 1);
    assert.equal(
      exportedBackup.characters.find((character) => character.id === createdCharacter.id)?.isFavorite,
      true
    );
    assert.equal("key" in exportedBackup.settings.providers[0], false);
    assert.equal(exportedBackup.settings.providers[0]?.hasKey, true);
    const exportedPrivateBackupCharacter = exportedBackup.characters.find(
      (character) => character.id === importedPrivateBackupCharacter.id
    );
    assert.ok(exportedPrivateBackupCharacter);
    assert.equal(Array.isArray(exportedPrivateBackupCharacter.loreEntries), false);
    assert.ok(
      exportedPrivateBackupCharacter.loreEntries &&
        typeof exportedPrivateBackupCharacter.loreEntries === "object" &&
        "__privateCharacter" in exportedPrivateBackupCharacter.loreEntries
    );

    const importedBackupSummary = await requestData(baseUrl, "/api/backups/import", {
      method: "POST",
      body: {
        ...exportedBackup,
        mode: "replace"
      }
    });
    assert.equal(importedBackupSummary.mode, "replace");
    assert.equal(importedBackupSummary.characters, 2);
    assert.equal(importedBackupSummary.chats, 1);
    assert.equal(importedBackupSummary.messages, 2);
    assert.equal(importedBackupSummary.memories, 1);
    assert.equal(importedBackupSummary.settingsImported, true);

    const pulledSyncSummary = await requestData(baseUrl, "/api/sync/pull", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge"
      }
    });
    const syncInfo = await requestData(baseUrl, "/api/sync/info");
    assert.equal(syncInfo.port, port);
    assert.equal(syncInfo.localUrl, `http://127.0.0.1:${port}`);
    assert.equal(Array.isArray(syncInfo.lanUrls), true);
    assert.equal(typeof syncInfo.lanReachable, "boolean");

    assert.equal(pulledSyncSummary.direction, "pull");
    assert.equal(pulledSyncSummary.mode, "merge");
    assert.equal(pulledSyncSummary.summary.characters, 2);
    assert.equal(pulledSyncSummary.summary.chats, 1);
    assert.equal(pulledSyncSummary.summary.messages, 2);
    assert.equal(pulledSyncSummary.summary.memories, 1);

    const pushedSyncSummary = await requestData(baseUrl, "/api/sync/push", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge"
      }
    });
    assert.equal(pushedSyncSummary.direction, "push");
    assert.equal(pushedSyncSummary.mode, "merge");
    assert.equal(pushedSyncSummary.summary.characters, 2);
    assert.equal(pushedSyncSummary.summary.chats, 1);
    assert.equal(pushedSyncSummary.summary.messages, 2);
    assert.equal(pushedSyncSummary.summary.memories, 1);

    const restoredImportedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${importedPrivateBackupCharacter.id}`
    );
    assert.equal(restoredImportedPrivateCharacter.visibility, "private");
    assert.equal(restoredImportedPrivateCharacter.canViewPrompt, false);
    assert.equal(restoredImportedPrivateCharacter.prompt, "");

    const restoredUnlockedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${importedPrivateBackupCharacter.id}/unlock`,
      {
        method: "POST",
        body: {
          password: privatePassword
        }
      }
    );
    assert.equal(restoredUnlockedPrivateCharacter.canViewPrompt, true);
    assert.equal(
      restoredUnlockedPrivateCharacter.prompt,
      characterPayload.prompt,
      "backup restore should preserve imported private character prompts"
    );

    const timelineUserMessage = await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: {
        chatId: createdChat.id,
        role: "user",
        content: "Remove this smoke timeline from here."
      }
    });
    await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: {
        chatId: createdChat.id,
        role: "assistant",
        characterId: createdCharacter.id,
        content: "This follow-up should be deleted atomically."
      }
    });
    const timelineDeletion = await requestData(
      baseUrl,
      `/api/messages/${timelineUserMessage.id}/timeline`,
      { method: "DELETE" }
    );
    assert.equal(timelineDeletion.chatId, createdChat.id);
    assert.equal(timelineDeletion.deletedCount, 2);
    assert.equal(timelineDeletion.disabledMemoryCount, 0);
    const messagesAfterTimelineDeletion = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(messagesAfterTimelineDeletion.length, 2);

    await request(baseUrl, `/api/messages/${assistantMessage.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });
    const remainingMessages = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(remainingMessages.length, 1);

    await request(baseUrl, `/api/chats/${createdChat.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });
    const hiddenTrashSearch = await requestData(
      baseUrl,
      `/api/chats/message-search?${new URLSearchParams({ q: "Smoke path", limit: "5" }).toString()}`
    );
    assert.equal(hiddenTrashSearch.results.some((result) => result.chat.id === createdChat.id), false);
    const messagesAfterChatDelete = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(messagesAfterChatDelete.length, 0);
    const restoredChat = await requestData(baseUrl, `/api/chats/${createdChat.id}/restore`, {
      method: "POST"
    });
    assert.equal(restoredChat.deletedAt, null);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).messages.length, 1);
    await permanentlyDeleteChat(baseUrl, createdChat.id);

    await request(baseUrl, `/api/characters/${importedPublicCharacter.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });
    await request(baseUrl, `/api/characters/${importedPrivateCharacter.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });

    const finalBackup = await requestData(baseUrl, "/api/backups/export");
    assert.equal(finalBackup.characters.length, 0);
    assert.equal(finalBackup.chats.length, 0);
    assert.equal(finalBackup.messages.length, 0);
    assert.equal(finalBackup.memories.length, 0);
    assert.ok(finalBackup.settings);

    log("Smoke API checks passed");
  } finally {
    await stopProcess(server?.child);
    fakeModelServer?.close();
    await removeWithRetry(tempDbDir);
  }
};

main().catch((error) => {
  console.error(`[smoke-api] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
