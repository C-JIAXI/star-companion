import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
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

  await mkdir(tempDbDir, { recursive: true });

  try {
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
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "sk-smoke-test-key",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 1024,
      topP: 0.95,
      language: "en",
      autoSummarizeUser: false,
      showMessageAvatars: false,
      userProfileSummary: "",
      providers: [
        {
          id: "smoke-provider",
          label: "Smoke Provider",
          provider: "openai-compatible",
          apiBaseUrl: "https://api.openai.com/v1",
          models: [
            { id: "smoke-model", label: "Smoke Model", model: "gpt-4o-mini" }
          ]
        }
      ],
      activeProviderId: "smoke-provider",
      activeModelId: "smoke-model"
    };
    const updatedSettings = await requestData(baseUrl, "/api/settings", {
      method: "PUT",
      body: settingsPayload
    });
    assert.equal(updatedSettings.language, "en");
    assert.equal(updatedSettings.showMessageAvatars, false);
    assert.equal(updatedSettings.hasApiKey, true);
    assert.equal("apiKey" in updatedSettings, false);

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

    log("Verifying character CRUD, paging, export, import, and unlock flows");
    const characterPayload = {
      name: `Smoke Character ${runId}`,
      avatar: null,
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

    const updatedChat = await requestData(baseUrl, `/api/chats/${createdChat.id}`, {
      method: "PUT",
      body: {
        backgroundUrl: "https://example.com/background-updated.png",
        memoryTurns: 16,
        autoMemoryEnabled: false,
        userPersona: "Focus on concise diagnostics."
      }
    });
    assert.equal(updatedChat.backgroundUrl, "https://example.com/background-updated.png");
    assert.equal(updatedChat.memoryTurns, 16);
    assert.equal(updatedChat.autoMemoryEnabled, false);

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
        content: "Smoke path is nominal.",
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

    const listedMessages = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(listedMessages.length, 2);

    const chatWithMessages = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatWithMessages.messages.length, 2);

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
    assert.equal(exportedBackup.messages.length, 2);
    assert.equal(exportedBackup.memories.length, 1);
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
    const messagesAfterChatDelete = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(messagesAfterChatDelete.length, 0);

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
    await removeWithRetry(tempDbDir);
  }
};

main().catch((error) => {
  console.error(`[smoke-api] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
