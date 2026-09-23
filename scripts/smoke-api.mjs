import assert from "node:assert/strict";
import { verifyChatDraftContract, verifyDraftBudgetResume } from "./testing/chat-draft-contract.mjs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "apps", "server");
const migrationsDir = path.join(serverDir, "prisma", "migrations");
const prismaTmpRoot = path.join(serverDir, "prisma", ".tmp");
const tsxCliPath = path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const smokePng = new PNG({ width: 1, height: 1 });
smokePng.data.fill(255);
const smokePngBase64 = PNG.sync.write(smokePng).toString("base64");
const withoutExportTimestamp = ({ exportedAt: _exportedAt, ...backup }) => backup;

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
    const requestId = input.requestId ?? `smoke-ws-${Date.now()}`;
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
        reject(new Error(`${event.error} (${event.modelError?.code ?? "unknown"}; ${event.modelError?.diagnosticId ?? "no-diagnostic"}; events=${events.map((item) => item.type).join(",")})`));
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

const querySocketRequestStatus = (baseUrl, requestId) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for generation status"));
    }, 5_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "status", requestId })));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(message.data.toString());
      if (event.type !== "generation_status" || event.request?.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.close();
      resolve(event.request);
    });
    socket.addEventListener("error", reject);
  });

const queryAgentRunEvents = (baseUrl, chatId, runId) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  const events = [];
  const timeout = setTimeout(() => { socket.close(); reject(new Error("Timed out waiting for Agent event replay")); }, 5_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "agent_subscribe", chatId, runId, afterSeq: 0 })));
  socket.addEventListener("message", (raw) => {
    const event = JSON.parse(String(raw.data));
    if (event.type !== "agent_event" || event.runId !== runId) return;
    events.push(event);
    if (["succeeded", "failed", "cancelled"].includes(event.phase)) { clearTimeout(timeout); socket.close(); resolve(events); }
  });
  socket.addEventListener("error", reject);
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
  let failNextStream = false;
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
    if (body.tools && joinedMessages.includes("role-tool-smoke")) {
      const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool");
      const message = toolMessages.length === 0
        ? { role: "assistant", content: null, tool_calls: [{ id: "smoke_role_search", type: "function", function: { name: "search_history", arguments: JSON.stringify({ query: "role-tool-smoke", limit: 5 }) } }] }
        : { role: "assistant", content: "Role tool found the current scene." };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 } }));
      return;
    }
    if (body.tools && joinedMessages.includes("agent-candidate-smoke")) {
      const message = { role: "assistant", content: JSON.stringify({ answer: "Reviewable memory and Lore candidates.", candidates: [
        { kind: "memory_candidate", title: "Harbor promise", content: "They promised to meet at the harbor after dusk.", keywords: ["harbor", "dusk"], sourceMessageIds: [], sourceMemoryIds: [] },
        { kind: "lore_candidate", title: "Harbor bell", content: "The harbor bell rings at dusk.", keywords: ["harbor", "bell"], sourceMessageIds: [], sourceMemoryIds: [] }
      ] }) };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 24, completion_tokens: 20, total_tokens: 44 } }));
      return;
    }
    if (body.tools && joinedMessages.includes("User focus:\ncharacter-tool-smoke")) {
      const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool");
      const character = toolMessages.length ? JSON.parse(toolMessages.at(-1).content).character : null;
      const message = toolMessages.length === 0
        ? { role: "assistant", content: null, tool_calls: [{ id: "smoke_character_read", type: "function", function: { name: "read_character", arguments: "{}" } }] }
        : { role: "assistant", content: `Character prompt: ${character?.prompt ?? "locked"}; Lore: ${character?.loreEntries?.[0]?.id ?? "none"}.` };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 } }));
      return;
    }
    if (body.tools && joinedMessages.includes("Find the tool-smoke agreement")) {
      const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool");
      const lastToolOutput = toolMessages.at(-1)?.content;
      const searchedMessageId = toolMessages.length ? JSON.parse(lastToolOutput).messages?.[0]?.id : null;
      const message = toolMessages.length === 0
        ? { role: "assistant", content: null, tool_calls: [{ id: "smoke_search", type: "function", function: { name: "search_history", arguments: JSON.stringify({ query: "Nominal status", limit: 5 }) } }] }
        : toolMessages.length === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "smoke_read", type: "function", function: { name: "read_messages", arguments: JSON.stringify({ ids: [searchedMessageId] }) } }] }
          : { role: "assistant", content: `The old status was nominal. [source:${searchedMessageId}]` };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 20 + toolMessages.length * 5, completion_tokens: 8, total_tokens: 28 + toolMessages.length * 5 } }));
      return;
    }
    if (body.tools && joinedMessages.includes("memory-tool-smoke agreement")) {
      const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool");
      const memoryId = toolMessages.length ? JSON.parse(toolMessages.at(-1).content).memories?.[0]?.id : null;
      const message = toolMessages.length === 0
        ? { role: "assistant", content: null, tool_calls: [{ id: "smoke_memory_search", type: "function", function: { name: "search_memories", arguments: JSON.stringify({ query: "harbor vow", limit: 5 }) } }] }
        : { role: "assistant", content: `The harbor vow is recorded. [memory:${memoryId}]` };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 } }));
      return;
    }
    const content = joinedMessages.includes("read-only drafting assistant for an original")
      ? JSON.stringify({ items: [{ field: "prompt", title: "Smoke core draft", suggestion: "A structured original smoke character draft." }] })
      : joinedMessages.includes("read-only context assistant")
      ? JSON.stringify({ answer: "Agent draft:", candidates: [{ kind: "reply_draft", title: "Diagnostic signal", content: "Ask for the next diagnostic signal.", keywords: [], sourceMessageIds: [], sourceMemoryIds: [] }] })
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
      if (failNextStream) { failNextStream = false; response.end('data: {"error":{"type":"server_error","message":"Controlled partial failure"}}\n\n'); return; }
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
        failNextStream: () => { failNextStream = true; },
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
    db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )`);
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    const migrationNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const migrationName of migrationNames) {
      const sql = await readFile(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
      db.exec(sql);
      const appliedAt = new Date().toISOString();
      db.prepare('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)')
        .run(randomUUID(), createHash("sha256").update(sql).digest("hex"), appliedAt, migrationName, appliedAt);
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
    const appInfo = await requestData(baseUrl, "/api/app/info");
    assert.match(appInfo.appVersion, /^\d+\.\d+\.\d+/);
    assert.match(appInfo.schemaVersion, /^\d+_/);
    assert.equal(appInfo.migration.status, "ready");
    assert.equal("apiKey" in appInfo, false);

    log("Verifying settings lifecycle");
    const initialSettings = await requestData(baseUrl, "/api/settings");
    assert.equal(initialSettings.hasApiKey, false);
    assert.equal("apiKey" in initialSettings, false);
    assert.equal(initialSettings.appearancePreferences.themeMode, "system");

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
      appearancePreferences: { themeMode: "light", fontSize: "large", lineHeight: "relaxed", chatWidth: "wide", messageSpacing: "compact", contrast: "high", motion: "reduced", backgroundOverlay: 0.75, backgroundBlur: "medium", characterStyle: "restricted" },
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
              contextWindow: 32768,
              capabilities: [
                "text_generation",
                "vision_input",
                "tool_calling",
                "text_embedding",
                "audio_transcription",
                "text_to_speech",
                "image_generation"
              ],
              pricing: {
                inputMicrosPerMillion: 2_000_000,
                outputMicrosPerMillion: 6_000_000,
                currency: "USD",
                updatedAt: "2026-08-12T00:00:00.000Z",
                source: "user"
              }
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
          avatar: "data:image/png;base64,YQ==",
          config: {
            displayName: "Smoke User",
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
    assert.equal(updatedSettings.appearancePreferences.themeMode, "light");
    assert.equal(updatedSettings.appearancePreferences.characterStyle, "restricted");
    assert.equal(updatedSettings.ttsVoice, "nova");
    assert.equal(updatedSettings.ttsPlaybackRate, 1.25);
    assert.equal(updatedSettings.ttsAutoPlay, true);
    assert.equal(updatedSettings.hasApiKey, true);
    assert.equal("apiKey" in updatedSettings, false);
    assert.equal("key" in updatedSettings.providers[0], false);
    assert.equal(updatedSettings.providers[0]?.hasKey, true);
    assert.equal(updatedSettings.providers[0]?.models[0]?.contextWindow, 32768);
    assert.ok(updatedSettings.providers[0]?.models[0]?.capabilities?.includes("tool_calling"));
    assert.deepEqual(updatedSettings.moduleModelPreferences.agent, {
      providerId: "smoke-provider",
      modelId: "smoke-model"
    });
    assert.equal(updatedSettings.userPersonaPresets[0]?.name, "Smoke Persona");
    assert.equal(updatedSettings.userPersonaPresets[0]?.avatar, "data:image/png;base64,YQ==");
    assert.equal(updatedSettings.userPersonaPresets[0]?.config.displayName, "Smoke User");
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
    assert.equal(preservedSettings.providers[0]?.models[0]?.contextWindow, 32768);

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

    const readinessBeforeCharacters = await requestData(baseUrl, "/api/readiness");
    assert.equal(readinessBeforeCharacters.serverReachable, true);
    assert.equal(readinessBeforeCharacters.configurationValid, true);
    assert.equal(readinessBeforeCharacters.hasCharacter, false);
    assert.equal(readinessBeforeCharacters.connectionStatus.status, "untested");
    assert.equal("apiKey" in readinessBeforeCharacters, false);
    const metadataRequestCountBefore = fakeModelServer.getChatCompletionRequests();
    const metadataConnectionTest = await requestData(baseUrl, "/api/readiness/connection-tests", {
      method: "POST",
      body: { mode: "metadata" }
    });
    assert.equal(metadataConnectionTest.status, "succeeded");
    assert.equal(metadataConnectionTest.mode, "metadata");
    assert.equal(metadataConnectionTest.mayIncurCost, false);
    assert.equal(fakeModelServer.getChatCompletionRequests(), metadataRequestCountBefore);
    assert.equal((await requestData(baseUrl, "/api/readiness")).connectionStatus.status, "succeeded");

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
    assert.equal(fetchedSettings.providers[0]?.models[0]?.contextWindow, 32768);
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
    await verifyChatDraftContract(baseUrl, async () => {
      log("Restarting the isolated backend to verify exact draft and image recovery");
      await stopProcess(server.child);
      server = startServer(env);
      await waitForHealth(baseUrl, server);
    });
    await verifyDraftBudgetResume(baseUrl, () => fakeModelServer.getChatCompletionRequests(), () => fakeModelServer.failNextStream());
    log("Chat draft persistence, conflicts, lock and lifecycle contract passed");
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

    const characterDraftRequestCount = fakeModelServer.getChatCompletionRequests();
    const characterDraft = await requestData(baseUrl, "/api/characters/draft", {
      method: "POST",
      body: {
        requestId: `character-draft-${runId}`,
        task: "refine_prompt",
        draft: {
          name: fetchedCharacterAfterUpdate.name,
          description: fetchedCharacterAfterUpdate.description,
          prefix: fetchedCharacterAfterUpdate.prefix,
          prompt: fetchedCharacterAfterUpdate.prompt,
          suffix: fetchedCharacterAfterUpdate.suffix,
          loreEntries: fetchedCharacterAfterUpdate.loreEntries,
          quickReplies: fetchedCharacterAfterUpdate.quickReplies
        }
      }
    });
    assert.equal(characterDraft.task, "refine_prompt");
    assert.equal(characterDraft.items[0]?.field, "prompt");
    assert.equal(fakeModelServer.getChatCompletionRequests(), characterDraftRequestCount + 1);
    const characterAfterDraft = await requestData(baseUrl, `/api/characters/${createdCharacter.id}`);
    assert.equal(characterAfterDraft.prompt, fetchedCharacterAfterUpdate.prompt, "AI draft must not write character data");
    const sentDraft = JSON.parse(fakeModelServer.getLastChatCompletionBody().messages[1].content);
    assert.deepEqual(Object.keys(sentDraft), ["prompt", "brief"]);
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
    assert.equal(importedPrivateCharacter.htmlCss, "");
    assert.equal(importedPrivateCharacter.prompt, "");

    const metadataUpdatedPrivateCharacter = await requestData(
      baseUrl,
      `/api/characters/${importedPrivateCharacter.id}`,
      {
        method: "PUT",
        body: {
          name: `${importablePrivateCard.character.name} Metadata Updated`,
          avatar: "https://example.test/private-metadata.png",
          tags: ["private-metadata", "sentinel"]
        }
      }
    );
    assert.equal(metadataUpdatedPrivateCharacter.canViewPrompt, false);
    assert.equal(metadataUpdatedPrivateCharacter.avatar, "https://example.test/private-metadata.png");
    assert.deepEqual(metadataUpdatedPrivateCharacter.tags, ["private-metadata", "sentinel"]);

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
      folder: "Smoke folder",
      backgroundUrl: "https://example.com/background.png",
      memoryTurns: 10,
      userPersona: "Be direct.",
      userAvatar: "data:image/png;base64,YQ==",
      userProfileSummary: "Prefers terse technical answers."
    };
    const createdChat = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: chatPayload
    });
    assert.equal(createdChat.characterId, createdCharacter.id);
    assert.equal(createdChat.folder, "Smoke folder");
    assert.equal(createdChat.autoMemoryEnabled, true);
    assert.equal(createdChat.userAvatar, "data:image/png;base64,YQ==");

    const imageDraftId = `draft_${runId.replace(/[^a-z0-9]/gi, "")}_image0001`;
    const uploadedImage = await requestData(baseUrl, "/api/media/chat-images/drafts", {
      method: "POST", expectedStatus: 201,
      body: { draftId: imageDraftId, dataBase64: smokePngBase64, mimeType: "image/png", originalFilename: "../smoke.png" }
    });
    assert.equal(uploadedImage.originalFilename, ".._smoke.png");
    const imageMessage = await requestData(baseUrl, "/api/messages", {
      method: "POST", expectedStatus: 201,
      body: { chatId: createdChat.id, role: "user", content: "", draftId: imageDraftId }
    });
    assert.equal(imageMessage.attachments.length, 1);
    const mediaResponse = await fetch(`${baseUrl}${imageMessage.attachments[0].url}`);
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.from(await mediaResponse.arrayBuffer()).length, uploadedImage.byteSize);
    const editDraftId = `draft_${runId.replace(/[^a-z0-9]/gi, "")}_edit0001`;
    const staged = await requestData(baseUrl, `/api/media/chat-images/messages/${imageMessage.id}/edit-draft`, { method: "POST", expectedStatus: 201, body: { draftId: editDraftId } });
    assert.equal(staged.length, 1);
    const editedImageMessage = await requestData(baseUrl, `/api/messages/${imageMessage.id}`, { method: "PUT", body: { content: "Image-only smoke", draftId: editDraftId, replaceAttachments: true } });
    assert.equal(editedImageMessage.attachments.length, 1);

    const batchFolderResult = await requestData(baseUrl, "/api/chats/batch-folder", {
      method: "POST",
      body: { ids: [createdChat.id], folder: "Smoke folder updated" }
    });
    assert.equal(batchFolderResult.updated, 1);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).folder, "Smoke folder updated");

    const renamedFolderResult = await requestData(baseUrl, "/api/chats/rename-folder", {
      method: "POST",
      body: { from: "Smoke folder updated", to: "Smoke folder renamed" }
    });
    assert.equal(renamedFolderResult.updated, 1);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).folder, "Smoke folder renamed");

    const listedChats = await requestData(baseUrl, "/api/chats");
    const listedChat = listedChats.find((item) => item.id === createdChat.id);
    assert.ok(listedChat);
    assert.equal(listedChat.messageCount, 1);
    assert.equal("userAvatar" in listedChat, false);

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

    const reindexedMemories = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/reindex`,
      { method: "POST" }
    );
    assert.equal(reindexedMemories.length, 1);
    assert.equal(reindexedMemories[0]?.embeddingStatus, "ready");
    assert.equal(reindexedMemories[0]?.embeddingDimensions, 3);

    let embeddingJob = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/reindex-jobs`,
      { method: "POST", expectedStatus: 202 }
    );
    for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(embeddingJob.state); attempt += 1) {
      await delay(20);
      embeddingJob = await requestData(
        baseUrl,
        `/api/chats/${createdChat.id}/memories/reindex-jobs/${embeddingJob.id}`
      );
    }
    assert.equal(embeddingJob.state, "completed");
    assert.equal(embeddingJob.completed, embeddingJob.total);
    assert.equal("content" in embeddingJob, false);

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
    const memoryHistory = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/${createdMemory.id}/revisions`
    );
    assert.deepEqual(memoryHistory.map((revision) => revision.action), ["manual_disable", "manual_create"]);
    assert.equal(memoryHistory[0].revision, 2);
    assert.equal("embedding" in memoryHistory[0].afterSnapshot, false);
    const restorePreview = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/${createdMemory.id}/revisions/1/restore-preview`
    );
    const restoredMemory = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/${createdMemory.id}/restore`,
      {
        method: "POST",
        body: {
          revision: 1,
          expectedCurrentRevision: restorePreview.expectedCurrentRevision,
          confirm: "RESTORE_MEMORY_REVISION"
        }
      }
    );
    assert.equal(restoredMemory.revision.action, "restore");
    assert.equal(restoredMemory.memory.embeddingStatus, "stale");
    const disabledReindexResult = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/memories/reindex`,
      { method: "POST" }
    );
    assert.equal(disabledReindexResult.length, 1);
    assert.equal(disabledReindexResult[0]?.enabled, true);

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
        promptBreakdown: {
          promptTokens: 12,
          promptTokensEstimated: true,
          includedMessageCount: 1,
          sections: [
            {
              id: "history",
              tokenEstimate: 12,
              characterCount: 21,
              itemCount: 1
            }
          ]
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
    assert.equal(assistantMessage.promptBreakdown.promptTokens, 12);
    assert.equal(assistantMessage.promptBreakdown.sections[0]?.id, "history");
    assert.equal(assistantMessage.memoryMatches[0].id, createdMemory.id);

    const excludedUserMessage = await requestData(baseUrl, `/api/messages/${userMessage.id}`, {
      method: "PUT",
      body: { contextIncluded: false, isBookmarked: true }
    });
    assert.equal(excludedUserMessage.contextIncluded, false);
    assert.equal(excludedUserMessage.isBookmarked, true);
    const agentHistorySearch = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/agent/history-search?${new URLSearchParams({ q: userMessage.content, limit: "5" }).toString()}`
    );
    assert.equal(agentHistorySearch.results.some((result) => result.message.id === userMessage.id), false);
    const bookmarkPage = await requestData(baseUrl, `/api/messages/page?${new URLSearchParams({
      chatId: createdChat.id, limit: "1", includeTotal: "true", bookmarkedOnly: "true"
    }).toString()}`);
    assert.equal(bookmarkPage.total, 1);
    assert.equal(bookmarkPage.items[0]?.id, userMessage.id);

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
    assert.ok(continuedMessage?.promptBreakdown?.promptTokens > 0);
    assert.ok(
      continuedMessage?.promptBreakdown?.sections.some(
        (section) => section.id === "generation_instruction"
      )
    );
    assert.equal(continuedMessage?.generationMetadata?.modelId, "fake-agent-model");
    assert.equal(continuedMessage?.generationMetadata?.usageSource, "provider");
    assert.equal(continuedMessage?.generationMetadata?.estimatedCostMicros, 40);
    assert.equal(continuedMessage?.generationMetadata?.incomplete, false);
    assert.equal(continuedMessage?.variantMetadata?.[0], null);
    assert.equal(continuedMessage?.variantMetadata?.[1]?.attemptId, continuedMessage?.generationMetadata?.attemptId);

    const continuedRequestId = continuedMessage.generationMetadata.requestId;
    const continuedRequestStatus = await querySocketRequestStatus(baseUrl, continuedRequestId);
    assert.equal(continuedRequestStatus.status, "succeeded");
    assert.equal(continuedRequestStatus.messageId, assistantMessage.id);
    const providerCallsBeforeDuplicate = fakeModelServer.getChatCompletionRequests();
    const duplicateStatus = await querySocketRequestStatus(baseUrl, continuedRequestId);
    assert.equal(duplicateStatus.status, "succeeded");
    assert.equal(fakeModelServer.getChatCompletionRequests(), providerCallsBeforeDuplicate);

    const usageSummary = await requestData(baseUrl, `/api/usage/summary?${new URLSearchParams({ chatId: createdChat.id }).toString()}`);
    const continuedAttempt = usageSummary.recent.find((attempt) => attempt.requestId === continuedRequestId);
    assert.equal(continuedAttempt.status, "succeeded");
    assert.equal(continuedAttempt.usageSource, "provider");
    assert.equal(continuedAttempt.estimatedCostMicros, 40);
    assert.equal(continuedAttempt.chatTitle, createdChat.title);
    assert.ok(usageSummary.byChat.some((bucket) => bucket.key === createdChat.id && bucket.label === createdChat.title));
    const usagePreview = await requestData(baseUrl, "/api/usage/preview", {
      method: "POST",
      body: { module: "chat", inputTokens: 8, maxOutputTokens: 4 }
    });
    assert.equal(usagePreview.minimumCostMicros, 16);
    assert.equal(usagePreview.maximumCostMicros, 40);
    assert.equal(usagePreview.unknownPricing, false);
    assert.ok(usagePreview.todayCostMicros >= 40);

    const listedMessages = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(listedMessages.length, 3);
    assert.equal(listedMessages.find((message) => message.id === assistantMessage.id)?.content, "Nominal status confirmed. Continued.");

    const chatsWithPreview = await requestData(baseUrl, "/api/chats");
    const chatListPreview = chatsWithPreview.find((chat) => chat.id === createdChat.id);
    assert.equal(chatListPreview?.messageCount, 3);
    assert.equal(chatListPreview?.lastMessagePreview?.role, "assistant");
    assert.equal(
      chatListPreview?.lastMessagePreview?.content,
      "Nominal status confirmed. Continued."
    );
    assert.ok(chatListPreview?.lastMessagePreview?.createdAt);

    const chatWithMessages = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatWithMessages.messages.length, 3);

    const messageSearch = await requestData(
      baseUrl,
      `/api/chats/${createdChat.id}/message-search?${new URLSearchParams({
        q: "nominal",
        limit: "5"
      }).toString()}`
    );
    assert.equal(messageSearch.total, 1);
    assert.equal(messageSearch.results[0]?.index, 2);
    assert.equal(messageSearch.results[0]?.message.id, assistantMessage.id);
    assert.match(messageSearch.results[0]?.snippet ?? "", /nominal/i);

    const titleSuggestion = await requestData(baseUrl, `/api/chats/${createdChat.id}/title-suggestion`, {
      method: "POST"
    });
    assert.equal(titleSuggestion.title, "Smoke Title Suggestion");
    const chatAfterTitleSuggestion = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatAfterTitleSuggestion.title, createdChat.title);
    assert.equal(chatAfterTitleSuggestion.messages.length, 3);

    const skippedAutoTitle = await requestData(baseUrl, `/api/chats/${createdChat.id}/auto-title`, {
      method: "POST"
    });
    assert.equal(skippedAutoTitle, null);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).title, createdChat.title);

    const roleToolChat = await requestData(baseUrl, "/api/chats", {
      method: "POST", expectedStatus: 201, body: { title: "Role tool smoke", characterId: createdCharacter.id, autoMemoryEnabled: false }
    });
    const roleToolRequestId = `role-tool-${runId}`;
    const roleToolEvents = await runSocketRequest(baseUrl, { type: "generate", requestId: roleToolRequestId,
      chatId: roleToolChat.id, content: "role-tool-smoke", toolUse: { enabled: true, toolNames: ["search_history"] } });
    assert.equal(roleToolEvents.some((event) => event.type === "generation_tool_event" && event.phase === "tool_complete"), true);
    assert.match(roleToolEvents.find((event) => event.type === "assistant_message")?.message.content ?? "", /Role tool found/);
    assert.equal((await querySocketRequestStatus(baseUrl, roleToolRequestId)).status, "succeeded");
    await permanentlyDeleteChat(baseUrl, roleToolChat.id);

    const defaultTitleChat = await requestData(baseUrl, "/api/chats", {
      method: "POST",
      expectedStatus: 201,
      body: { title: "New Chat", characterId: createdCharacter.id }
    });
    await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: { chatId: defaultTitleChat.id, role: "user", content: "Open the smoke-test door." }
    });
    await requestData(baseUrl, "/api/messages", {
      method: "POST",
      expectedStatus: 201,
      body: {
        chatId: defaultTitleChat.id,
        role: "assistant",
        characterId: createdCharacter.id,
        content: "The smoke-test door is open."
      }
    });
    const appliedAutoTitle = await requestData(
      baseUrl,
      `/api/chats/${defaultTitleChat.id}/auto-title`,
      { method: "POST" }
    );
    assert.equal(appliedAutoTitle.title, "Smoke Title Suggestion");
    assert.equal(
      (await requestData(baseUrl, `/api/chats/${defaultTitleChat.id}`)).title,
      "Smoke Title Suggestion"
    );
    await permanentlyDeleteChat(baseUrl, defaultTitleChat.id);

    const agentDraft = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent-draft`, {
      method: "POST",
      body: {
        mode: "reply_drafts",
        focus: "smoke path"
      }
    });
    assert.equal(agentDraft.mode, "reply_drafts");
    assert.match(agentDraft.content, /Agent draft/);
    assert.equal(agentDraft.actions[0]?.kind, "reply_draft");
    assert.equal(agentDraft.actions[0]?.content, "Ask for the next diagnostic signal.");
    assert.equal(Array.isArray(agentDraft.matchedLoreEntries), true);
    assert.equal(Array.isArray(agentDraft.matchedMemoryEntries), true);
    const firstAgentTaskId = randomUUID();
    const firstAgentSession = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: firstAgentTaskId, mode: "reply_drafts", content: "How should I answer the smoke path?" }
    });
    assert.deepEqual(firstAgentSession.entries.map((entry) => entry.role), ["user", "assistant"]);
    const firstAgentStatus = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/runs/${firstAgentTaskId}`);
    assert.equal(firstAgentStatus.status, "succeeded");
    assert.ok(firstAgentStatus.lastEventSeq > 0);
    const callsAfterFirstTask = fakeModelServer.getChatCompletionRequests();
    const duplicateAgentSession = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: firstAgentTaskId, mode: "reply_drafts", content: "How should I answer the smoke path?" }
    });
    assert.equal(duplicateAgentSession.entries.length, 2);
    assert.equal(fakeModelServer.getChatCompletionRequests(), callsAfterFirstTask);
    assert.equal((await request(baseUrl, `/api/chats/${createdChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: firstAgentTaskId, mode: "reply_drafts", content: "How should I answer the smoke path?", generation: { temperature: 0.2, maxTokens: 512 } }, expectedStatus: 409
    })).ok, false);
    const secondAgentSession = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: randomUUID(), mode: "continuity_check", content: "And is that consistent?" }
    });
    assert.deepEqual(secondAgentSession.entries.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/session`)).entries.length, 4);
    const toolTaskId = randomUUID();
    const callsBeforeToolTask = fakeModelServer.getChatCompletionRequests();
    const toolAgentSession = await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: toolTaskId, mode: "continuity_check", content: "Find the tool-smoke agreement about status." }
    });
    assert.ok(fakeModelServer.getChatCompletionRequests() >= callsBeforeToolTask + 3);
    assert.match(toolAgentSession.entries.at(-1)?.content ?? "", /old status was nominal/i);
    assert.deepEqual(toolAgentSession.entries.at(-1)?.sourceMessageIds, [assistantMessage.id]);
    assert.equal(toolAgentSession.activeRunId, null);
    const toolEvents = await queryAgentRunEvents(baseUrl, createdChat.id, toolTaskId);
    assert.ok(toolEvents.some((event) => event.phase === "tool_start" && event.toolName === "search_history"));
    assert.deepEqual(toolEvents.map((event) => event.seq), Array.from({ length: toolEvents.length }, (_, index) => index + 1));
    assert.equal(toolEvents.at(-1)?.phase, "succeeded");
    const toolLedger = new DatabaseSync(tempDbPath, { readOnly: true });
    try {
      const requestId = `agent_${toolTaskId}`;
      assert.equal(toolLedger.prepare('SELECT status FROM "ModelRequest" WHERE id = ?').get(requestId)?.status, "succeeded");
      const attempts = toolLedger.prepare('SELECT attemptNumber, module, status, reservedCostMicros FROM "ModelUsageAttempt" WHERE requestId = ? ORDER BY attemptNumber').all(requestId);
      assert.deepEqual(attempts.map((attempt) => attempt.attemptNumber), [1, 2, 3, 4, 5]);
      assert.deepEqual(attempts.map((attempt) => attempt.module), ["memory_embedding", "memory", "agent", "agent", "agent"]);
      assert.ok(attempts.every((attempt) => attempt.status === "succeeded" && attempt.reservedCostMicros === 0));
    } finally {
      toolLedger.close();
    }
    const memoryToolChat = await requestData(baseUrl, "/api/chats", {
      method: "POST", expectedStatus: 201, body: { title: "Agent memory tool smoke", characterId: createdCharacter.id }
    });
    const memoryToolMemory = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/memories`, {
      method: "POST", expectedStatus: 201,
      body: { title: "Harbor vow", content: "They agreed to meet at the harbor.", keywords: ["harbor", "vow"], enabled: true }
    });
    assert.equal((await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/memories/${memoryToolMemory.id}`)).id, memoryToolMemory.id);
    assert.equal((await request(baseUrl, `/api/chats/${memoryToolChat.id}/memories/${createdMemory.id}`, { expectedStatus: 404 })).ok, false);
    const memoryToolTaskId = randomUUID();
    const memoryToolSession = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: memoryToolTaskId, mode: "continuity_check", content: "Find the memory-tool-smoke agreement." }
    });
    assert.deepEqual(memoryToolSession.entries.at(-1)?.sourceMemoryIds, [memoryToolMemory.id]);
    assert.match(memoryToolSession.entries.at(-1)?.content ?? "", /harbor vow/i);
    const characterToolChat = await requestData(baseUrl, "/api/chats", {
      method: "POST", expectedStatus: 201, body: { title: "Character tool smoke", characterId: createdCharacter.id }
    });
    const characterToolSession = await requestData(baseUrl, `/api/chats/${characterToolChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: randomUUID(), mode: "character_consistency", content: "character-tool-smoke", generation: { temperature: 0.15, maxTokens: 512 } }
    });
    assert.match(characterToolSession.entries.at(-1)?.content ?? "", /You are a smoke-test sentinel/);
    assert.match(characterToolSession.entries.at(-1)?.content ?? "", /smoke-lore-1/);
    assert.equal(fakeModelServer.getLastChatCompletionBody().temperature, 0.15);
    assert.equal(fakeModelServer.getLastChatCompletionBody().max_tokens, 512);
    await permanentlyDeleteChat(baseUrl, characterToolChat.id);
    const memoryToolLedger = new DatabaseSync(tempDbPath, { readOnly: true });
    try {
      const rows = memoryToolLedger.prepare('SELECT attemptNumber, module, status FROM "ModelUsageAttempt" WHERE requestId = ? ORDER BY attemptNumber').all(`agent_${memoryToolTaskId}`);
      assert.deepEqual(rows.map((row) => row.attemptNumber), [1, 2, 3, 4]);
      assert.deepEqual(rows.map((row) => row.module), ["agent", "memory_embedding", "memory", "agent"]);
      assert.ok(rows.every((row) => row.status === "succeeded"));
    } finally { memoryToolLedger.close(); }
    const candidateSession = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: randomUUID(), mode: "memory_lore_candidates", content: "agent-candidate-smoke" }
    });
    const candidate = candidateSession.entries.at(-1)?.actions[0];
    assert.equal(candidate?.kind, "memory_candidate");
    const editedMemoryCandidate = { title: "Harbor promise revised", content: candidate.content, keywords: candidate.keywords };
    const memoryPreview = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${candidate.id}/preview`, {
      method: "POST", body: { candidate: editedMemoryCandidate }
    });
    assert.equal(memoryPreview.original.title, "Harbor promise");
    assert.equal(memoryPreview.proposed.title, "Harbor promise revised");
    assert.equal(memoryPreview.affectedChatCount, 1);
    const firstConfirmation = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${candidate.id}/confirm-memory`, {
      method: "POST", body: { confirm: "APPLY_AGENT_MEMORY", candidate: editedMemoryCandidate }
    });
    const repeatedConfirmation = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${candidate.id}/confirm-memory`, {
      method: "POST", body: { confirm: "APPLY_AGENT_MEMORY", candidate: editedMemoryCandidate }
    });
    assert.equal(firstConfirmation.memory.id, repeatedConfirmation.memory.id);
    assert.equal(firstConfirmation.memory.title, "Harbor promise revised");
    assert.equal((await request(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${candidate.id}/confirm-memory`, {
      method: "POST", body: { confirm: "APPLY_AGENT_MEMORY", candidate: { ...editedMemoryCandidate, title: "Different retry" } }, expectedStatus: 409
    })).ok, false);
    assert.equal(firstConfirmation.session.entries.at(-1)?.actions[0]?.appliedTargetId, firstConfirmation.memory.id);
    assert.equal((await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/memories/${firstConfirmation.memory.id}/revisions`)).length, 1);
    const loreCandidate = candidateSession.entries.at(-1)?.actions[1];
    assert.equal(loreCandidate?.kind, "lore_candidate");
    const editedLoreCandidate = { title: loreCandidate.title, content: "The harbor bell rings twice at dusk.", keywords: loreCandidate.keywords };
    const lorePreview = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${loreCandidate.id}/preview`, {
      method: "POST", body: { candidate: editedLoreCandidate }
    });
    assert.equal(lorePreview.proposed.content, editedLoreCandidate.content);
    assert.equal(lorePreview.targetName, (await requestData(baseUrl, `/api/characters/${createdCharacter.id}`)).name);
    assert.equal(lorePreview.privateCharacter, false);
    assert.equal(typeof lorePreview.targetVersion, "string");
    const firstLoreConfirmation = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${loreCandidate.id}/confirm-lore`, {
      method: "POST", body: { confirm: "APPLY_AGENT_LORE", candidate: editedLoreCandidate }
    });
    const repeatedLoreConfirmation = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${loreCandidate.id}/confirm-lore`, {
      method: "POST", body: { confirm: "APPLY_AGENT_LORE", candidate: editedLoreCandidate }
    });
    assert.equal(repeatedLoreConfirmation.alreadyApplied, true);
    assert.equal((await request(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${loreCandidate.id}/confirm-lore`, {
      method: "POST", body: { confirm: "APPLY_AGENT_LORE", candidate: { ...editedLoreCandidate, content: "Different retry" } }, expectedStatus: 409
    })).ok, false);
    assert.equal(firstLoreConfirmation.characterId, createdCharacter.id);
    const savedLore = (await requestData(baseUrl, `/api/characters/${createdCharacter.id}`)).loreEntries.filter((entry) => entry.id === loreCandidate.id);
    assert.equal(savedLore.length, 1);
    assert.equal(savedLore[0]?.content, editedLoreCandidate.content);
    const staleLoreSession = await requestData(baseUrl, `/api/chats/${memoryToolChat.id}/agent/tasks`, {
      method: "POST", body: { mutationId: randomUUID(), mode: "memory_lore_candidates", content: "agent-candidate-smoke stale version" }
    });
    const staleLoreAction = staleLoreSession.entries.at(-1)?.actions.find((action) => action.kind === "lore_candidate");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await requestData(baseUrl, `/api/characters/${createdCharacter.id}`, { method: "PUT", body: { description: "Changed after Agent proposal" } });
    assert.equal((await request(baseUrl, `/api/chats/${memoryToolChat.id}/agent/actions/${staleLoreAction.id}/confirm-lore`, {
      method: "POST", body: { confirm: "APPLY_AGENT_LORE", candidate: { title: staleLoreAction.title, content: staleLoreAction.content, keywords: staleLoreAction.keywords } }, expectedStatus: 409
    })).ok, false);
    await permanentlyDeleteChat(baseUrl, memoryToolChat.id);
    const chatAfterAgentDraft = await requestData(baseUrl, `/api/chats/${createdChat.id}`);
    assert.equal(chatAfterAgentDraft.messages.length, 3);
    assert.equal(chatAfterAgentDraft.memories.length, 1);

    const skillMarkdown = "---\nname: smoke-scene-skill\ndescription: Track a scene in the current chat.\n---\nUse visible messages only.";
    const skillInput = { format: "markdown", markdown: skillMarkdown };
    const builtinSkills = await requestData(baseUrl, "/api/skills");
    assert.equal(builtinSkills.filter((skill) => skill.source === "builtin").length, 4);
    const skillPreview = await requestData(baseUrl, "/api/skills/import-preview", { method: "POST", body: skillInput });
    assert.equal(skillPreview.name, "smoke-scene-skill");
    assert.equal(skillPreview.existingVersion, null);
    const importedSkill = await requestData(baseUrl, "/api/skills/import", { method: "POST", body: skillInput });
    assert.equal(importedSkill.agentEnabled, false);
    assert.equal((await requestData(baseUrl, "/api/skills/smoke-scene-skill")).skillMd, skillMarkdown);
    const enabledSkill = await requestData(baseUrl, "/api/skills/smoke-scene-skill/enabled", {
      method: "PUT", body: { expectedVersion: importedSkill.version, agentEnabled: true, chatId: createdChat.id, chatEnabled: true }
    });
    assert.equal(enabledSkill.agentEnabled, true);
    assert.deepEqual(enabledSkill.enabledChatIds, [createdChat.id]);
    assert.equal((await request(baseUrl, "/api/skills/smoke-scene-skill/enabled", {
      method: "PUT", body: { expectedVersion: importedSkill.version, agentEnabled: false }, expectedStatus: 409
    })).ok, false);
    assert.equal((await requestData(baseUrl, "/api/skills/import-preview", { method: "POST", body: skillInput })).existingVersion, enabledSkill.version);
    assert.equal((await request(baseUrl, "/api/mcp", {
      method: "POST", body: { name: "Unsafe MCP", endpointUrl: "http://example.com/mcp", allowPrivateNetwork: false }, expectedStatus: 400
    })).ok, false);
    const mcpConnection = await requestData(baseUrl, "/api/mcp", {
      method: "POST", expectedStatus: 201,
      body: { name: "Smoke MCP", endpointUrl: "https://example.com/mcp", allowPrivateNetwork: false, bearerToken: "mcp-smoke-secret" }
    });
    assert.equal(mcpConnection.hasBearerToken, true);
    assert.equal(JSON.stringify(mcpConnection).includes("mcp-smoke-secret"), false);
    assert.equal((await requestData(baseUrl, "/api/mcp")).some((item) => item.id === mcpConnection.id), true);
    const updatedMcp = await requestData(baseUrl, `/api/mcp/${mcpConnection.id}`, {
      method: "PUT", body: { expectedVersion: mcpConnection.version, enabled: true }
    });
    assert.equal(updatedMcp.enabled, true);
    assert.equal((await request(baseUrl, `/api/mcp/${mcpConnection.id}`, {
      method: "PUT", body: { expectedVersion: mcpConnection.version, enabled: false }, expectedStatus: 409
    })).ok, false);
    assert.deepEqual(await requestData(baseUrl, `/api/mcp/${mcpConnection.id}`, {
      method: "DELETE", body: { expectedVersion: updatedMcp.version, confirm: "DELETE_MCP_CONNECTION" }
    }), { deleted: true });

    const chatArchive = await requestData(baseUrl, `/api/chats/${createdChat.id}/archive`);
    assert.equal(chatArchive.archiveVersion, 1);
    assert.equal(Object.hasOwn(chatArchive, "agentSession"), false);
    assert.equal(Object.hasOwn(chatArchive, "skills"), false);
    assert.deepEqual(await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/session`), toolAgentSession);
    assert.deepEqual(await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/session`, { method: "DELETE" }), { cleared: true });
    assert.deepEqual((await requestData(baseUrl, `/api/chats/${createdChat.id}/agent/session`)).entries, []);
    assert.equal(chatArchive.messages.length, 3);
    assert.equal(chatArchive.media.assets.length, 1);
    assert.equal(chatArchive.media.attachments.length, 1);
    assert.equal(chatArchive.messages.find((message) => message.id === userMessage.id)?.contextIncluded, false);
    assert.equal(chatArchive.messages.find((message) => message.id === userMessage.id)?.isBookmarked, true);
    assert.equal(chatArchive.memories.length, 1);
    assert.equal(chatArchive.memoryRevisions.length, 3);
    assert.ok(Array.isArray(chatArchive.memoryOperations));
    assert.ok(Array.isArray(chatArchive.profileSummaryRevisions));
    assert.equal(chatArchive.chat.isArchived, true);
    assert.equal(chatArchive.chat.userAvatar, "data:image/png;base64,YQ==");
    assert.deepEqual(await requestData(baseUrl, "/api/skills/smoke-scene-skill", { method: "DELETE", body: { expectedVersion: enabledSkill.version, confirm: "DELETE_SKILL" } }), { deleted: true });
    const importedArchive = await requestData(baseUrl, "/api/chats/import-archive", {
      method: "POST",
      expectedStatus: 201,
      body: { archive: chatArchive, title: "Imported Smoke Archive" }
    });
    assert.notEqual(importedArchive.id, createdChat.id);
    assert.equal(importedArchive.title, "Imported Smoke Archive");
    assert.equal(importedArchive.messages.length, 3);
    assert.equal(importedArchive.messages.find((message) => message.content === "Image-only smoke")?.attachments.length, 1);
    assert.ok(importedArchive.messages.some((message) => message.contextIncluded === false && message.isBookmarked === true));
    assert.equal(importedArchive.memories.length, 1);
    const importedHistory = await requestData(baseUrl, `/api/chats/${importedArchive.id}/memories/${importedArchive.memories[0].id}/revisions`);
    assert.equal(importedHistory.length, chatArchive.memoryRevisions.length);
    assert.equal(importedArchive.isArchived, false);
    assert.equal(importedArchive.userAvatar, "data:image/png;base64,YQ==");
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
    assert.equal(branchedChat.folder, "Smoke folder renamed");
    assert.equal(branchedChat.parentChatId, createdChat.id);
    assert.equal(branchedChat.branchSourceMessageId, assistantMessage.id);
    assert.equal(branchedChat.messages.length, 3);
    assert.ok(branchedChat.messages.some((message) => message.contextIncluded === false && message.isBookmarked === true));
    assert.equal(branchedChat.messages.find((message) => message.content === "Image-only smoke")?.attachments.length, 1);
    assert.equal(branchedChat.userAvatar, "data:image/png;base64,YQ==");
    assert.ok(branchedChat.messages.find((message) => message.role === "assistant")?.promptBreakdown?.promptTokens > 0);
    assert.equal(branchedChat.memories.length, 0);
    await permanentlyDeleteChat(baseUrl, branchedChat.id);

    const checkpointChat = await requestData(baseUrl, `/api/chats/${createdChat.id}/branches`, {
      method: "POST",
      expectedStatus: 201,
      body: { messageId: assistantMessage.id, title: "Smoke Checkpoint", kind: "checkpoint" }
    });
    assert.equal(checkpointChat.isCheckpoint, true);
    assert.equal(checkpointChat.parentChatId, createdChat.id);
    assert.equal(checkpointChat.messages.length, 3);
    assert.equal(checkpointChat.messages.find((message) => message.content === "Image-only smoke")?.attachments.length, 1);
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
    assert.equal(exportedBackup.settings.appearancePreferences.themeMode, "light");
    assert.equal("apiKey" in exportedBackup.settings, false);
    assert.equal(exportedBackup.schemaVersion, 1);
    assert.ok(exportedBackup.settings);
    assert.equal(exportedBackup.characters.length, 2);
    assert.equal(exportedBackup.chats.length, 1);
    assert.equal(exportedBackup.chats[0]?.isPinned, true);
    assert.equal(exportedBackup.chats[0]?.isArchived, true);
    assert.equal(exportedBackup.chats[0]?.userAvatar, "data:image/png;base64,YQ==");
    assert.equal(exportedBackup.messages.length, 3);
    assert.equal(exportedBackup.media.assets.length, 1);
    assert.equal(exportedBackup.media.attachments.length, 1);
    const exportedGeneratedMessage = exportedBackup.messages.find((message) => message.id === assistantMessage.id);
    assert.equal(exportedGeneratedMessage?.generationMetadata?.estimatedCostMicros, 40);
    assert.equal(exportedGeneratedMessage?.variantMetadata?.[0], null);
    assert.equal("usageAttempts" in exportedBackup, false);
    assert.equal("modelRequests" in exportedBackup, false);
    assert.equal(exportedBackup.memories.length, 1);
    assert.equal(exportedBackup.memoryRevisions.length, 3);
    assert.ok(Array.isArray(exportedBackup.memoryOperations));
    assert.ok(Array.isArray(exportedBackup.profileSummaryRevisions));
    assert.ok(exportedBackup.memoryRevisions.every((revision) => !revision.afterSnapshot || !("embedding" in revision.afterSnapshot)));
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

    log("Verifying session privacy lock API isolation");
    assert.equal((await requestData(baseUrl, "/api/privacy/status")).locked, false);
    assert.equal((await requestData(baseUrl, "/api/privacy/lock", { method: "POST", body: { passcode: "2468" } })).locked, true);
    const lockedReadiness = await request(baseUrl, "/api/readiness", { expectedStatus: 423 });
    assert.equal(lockedReadiness.ok, false);
    assert.equal("data" in lockedReadiness, false);
    const lockedStorage = await request(baseUrl, "/api/storage-health/summary", { expectedStatus: 423 });
    assert.equal(lockedStorage.ok, false);
    const lockedMedia = await request(baseUrl, imageMessage.attachments[0].url, { expectedStatus: 423 });
    assert.equal(lockedMedia.ok, false);
    assert.doesNotMatch(JSON.stringify(lockedMedia), /iVBOR|smoke\.png/i);
    const lockedHistory = await request(baseUrl, `/api/chats/${createdChat.id}/memories/${createdMemory.id}/revisions`, { expectedStatus: 423 });
    assert.equal(lockedHistory.ok, false, "locked history response must be denied");
    assert.doesNotMatch(JSON.stringify(lockedHistory), /smoke path|nominal/i);
    const wrongUnlock = await request(baseUrl, "/api/privacy/unlock", { method: "POST", expectedStatus: 401, body: { passcode: "wrong" } });
    assert.equal(wrongUnlock.ok, false, "wrong unlock response must be denied");
    assert.doesNotMatch(JSON.stringify(wrongUnlock), /smoke path|nominal/i);
    assert.equal((await requestData(baseUrl, "/api/privacy/unlock", { method: "POST", body: { passcode: "2468" } })).locked, false);

    log("Verifying storage statistics, deep health, and one-use maintenance plans");
    const storageSummary = await requestData(baseUrl, "/api/storage-health/summary");
    assert.ok(storageSummary.categories.some((entry) => entry.id === "media_orphans"));
    assert.equal(JSON.stringify(storageSummary).includes(tempDbPath), false);
    assert.doesNotMatch(JSON.stringify(storageSummary), /smoke path|nominal|fake-api-key/i);
    let deepScan = await requestData(baseUrl, "/api/storage-health/deep-scans", { method: "POST", expectedStatus: 202 });
    for (let attempt = 0; attempt < 100 && deepScan.state === "running"; attempt += 1) {
      await delay(20);
      deepScan = await requestData(baseUrl, `/api/storage-health/deep-scans/${deepScan.id}`);
    }
    assert.equal(deepScan.state, "completed");
    const maintenancePlan = await requestData(baseUrl, "/api/storage-health/cleanup-plans", { method: "POST", expectedStatus: 201, body: { actions: ["rebuild_database_indexes"] } });
    assert.equal(maintenancePlan.items[0].action, "rebuild_database_indexes");
    const maintenanceResult = await requestData(baseUrl, `/api/storage-health/cleanup-plans/${maintenancePlan.id}/execute`, { method: "POST", body: { confirm: "EXECUTE_STORAGE_CLEANUP" } });
    assert.equal(maintenanceResult.items[0].status, "completed");
    const reusedPlan = await request(baseUrl, `/api/storage-health/cleanup-plans/${maintenancePlan.id}/execute`, { method: "POST", expectedStatus: 409, body: { confirm: "EXECUTE_STORAGE_CLEANUP" } });
    assert.equal(reusedPlan.ok, false);

    const recoveryPointsBeforePreview = await requestData(baseUrl, "/api/backups/recovery-points");
    const replacePreview = await requestData(baseUrl, "/api/backups/preview", {
      method: "POST",
      body: {
        ...exportedBackup,
        mode: "replace"
      }
    });
    assert.equal(replacePreview.canExecute, true);
    assert.equal(replacePreview.counts.invalid, 0);
    assert.deepEqual(
      withoutExportTimestamp(await requestData(baseUrl, "/api/backups/export")),
      withoutExportTimestamp(exportedBackup)
    );
    assert.equal(
      (await requestData(baseUrl, "/api/backups/recovery-points")).length,
      recoveryPointsBeforePreview.length
    );

    const damagedPreview = await requestData(baseUrl, "/api/backups/preview", {
      method: "POST",
      body: { schemaVersion: 2, exportedAt: "invalid", characters: [{ id: "broken" }], mode: "merge" }
    });
    assert.equal(damagedPreview.canExecute, false);
    assert.ok(damagedPreview.issues.some((issue) => issue.code === "schema_version"));
    assert.equal(JSON.stringify(damagedPreview).includes("sk-smoke-test-key"), false);

    const missingReferencePreview = await requestData(baseUrl, "/api/backups/preview", {
      method: "POST",
      body: {
        schemaVersion: 1,
        mode: "merge",
        chats: [{ id: "orphan-chat", title: "Orphan", characterId: "missing-character" }],
        messages: [{ id: "orphan-message", chatId: "missing-chat", role: "user", content: "not echoed" }],
        memories: []
      }
    });
    assert.equal(missingReferencePreview.canExecute, false);
    assert.ok(missingReferencePreview.issues.some((issue) => issue.code === "missing_reference"));
    assert.equal(JSON.stringify(missingReferencePreview).includes("not echoed"), false);

    const importedBackupSummary = await requestData(baseUrl, "/api/backups/import", {
      method: "POST",
      body: {
        ...exportedBackup,
        mode: "replace",
        previewId: replacePreview.previewId,
        conflictResolutions: []
      }
    });
    assert.equal(importedBackupSummary.mode, "replace");
    assert.equal(importedBackupSummary.characters, 2);
    assert.equal(importedBackupSummary.chats, 1);
    assert.equal(importedBackupSummary.messages, 3);
    assert.equal(importedBackupSummary.memories, 1);
    assert.equal(
      (await requestData(baseUrl, `/api/chats/${createdChat.id}`)).userAvatar,
      "data:image/png;base64,YQ=="
    );
    assert.equal(importedBackupSummary.settingsImported, true);
    assert.ok(importedBackupSummary.recoveryPointId);

    const mergeAddition = {
      schemaVersion: 1,
      mode: "merge",
      characters: [{
        id: `merge-add-${runId}`,
        cardId: `merge-add-card-${runId}`,
        name: "Merge Addition",
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "Merge fixture",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: [],
        isFavorite: false
      }],
      chats: [],
      messages: [],
      memories: []
    };
    const mergeAdditionPreview = await requestData(baseUrl, "/api/backups/preview", {
      method: "POST",
      body: mergeAddition
    });
    assert.equal(mergeAdditionPreview.counts.added, 1);
    assert.equal(mergeAdditionPreview.counts.conflicts, 0);
    const mergeAdditionSummary = await requestData(baseUrl, "/api/backups/import", {
      method: "POST",
      body: {
        ...mergeAddition,
        previewId: mergeAdditionPreview.previewId,
        conflictResolutions: []
      }
    });
    assert.equal(mergeAdditionSummary.added, 1);
    assert.equal(mergeAdditionSummary.recoveryPointId, null);
    await request(baseUrl, `/api/characters/${mergeAddition.characters[0].id}`, {
      method: "DELETE",
      expectedStatus: 204
    });

    const conflictBackup = {
      ...exportedBackup,
      characters: exportedBackup.characters.map((character) =>
        character.id === createdCharacter.id ? { ...character, name: "Incoming Conflict Name" } : character
      )
    };
    const conflictPreview = await requestData(baseUrl, "/api/backups/preview", {
      method: "POST",
      body: { ...conflictBackup, mode: "merge" }
    });
    assert.ok(conflictPreview.conflicts.some((entry) => entry.key === `characters:${createdCharacter.id}`));
    const unresolvedResponse = await request(baseUrl, "/api/backups/import", {
      method: "POST",
      expectedStatus: 409,
      body: {
        ...conflictBackup,
        mode: "merge",
        previewId: conflictPreview.previewId,
        conflictResolutions: []
      }
    });
    assert.equal(unresolvedResponse.ok, false);

    const resolvedConflictSummary = await requestData(baseUrl, "/api/backups/import", {
      method: "POST",
      body: {
        ...conflictBackup,
        mode: "merge",
        previewId: conflictPreview.previewId,
        conflictResolutions: conflictPreview.conflicts.map((conflict) => ({
          key: conflict.key,
          action: "use_incoming"
        }))
      }
    });
    assert.ok(resolvedConflictSummary.updated >= 1);
    assert.ok(resolvedConflictSummary.recoveryPointId);
    assert.equal((await requestData(baseUrl, `/api/characters/${createdCharacter.id}`)).name, "Incoming Conflict Name");

    const restoreResult = await requestData(
      baseUrl,
      `/api/backups/recovery-points/${resolvedConflictSummary.recoveryPointId}/restore`,
      { method: "POST" }
    );
    assert.equal(
      (await requestData(baseUrl, `/api/characters/${createdCharacter.id}`)).name,
      exportedBackup.characters.find((character) => character.id === createdCharacter.id)?.name
    );
    assert.ok(restoreResult.safetyRecoveryPointId);
    const restoredBackup = await requestData(baseUrl, "/api/backups/export");
    assert.equal(restoredBackup.settings.appearancePreferences.themeMode, "light");
    assert.equal(restoredBackup.settings.appearancePreferences.characterStyle, "restricted");
    assert.deepEqual(restoredBackup.memoryRevisions, exportedBackup.memoryRevisions);
    assert.deepEqual(restoredBackup.memoryOperations, exportedBackup.memoryOperations);
    assert.deepEqual(restoredBackup.profileSummaryRevisions, exportedBackup.profileSummaryRevisions);

    const legacyChatId = `legacy-chat-${runId}`;
    const legacyMemoryId = `legacy-memory-${runId}`;
    const legacyBackup = {
      schemaVersion: 1,
      mode: "merge",
      chats: [{ id: legacyChatId, title: "Legacy baseline", characterId: null, userProfileSummary: "" }],
      messages: [],
      memories: [{ id: legacyMemoryId, chatId: legacyChatId, title: "Legacy memory", content: "Legacy current state", keywords: [], importance: 3, enabled: true, sourceMessageIds: [] }]
    };
    const legacyPreview = await requestData(baseUrl, "/api/backups/preview", { method: "POST", body: legacyBackup });
    await requestData(baseUrl, "/api/backups/import", { method: "POST", body: { ...legacyBackup, previewId: legacyPreview.previewId, conflictResolutions: [] } });
    const legacyHistory = await requestData(baseUrl, `/api/chats/${legacyChatId}/memories/${legacyMemoryId}/revisions`);
    assert.equal(legacyHistory.length, 1);
    assert.equal(legacyHistory[0].action, "baseline");
    const repeatLegacyPreview = await requestData(baseUrl, "/api/backups/preview", { method: "POST", body: legacyBackup });
    await requestData(baseUrl, "/api/backups/import", { method: "POST", body: { ...legacyBackup, previewId: repeatLegacyPreview.previewId, conflictResolutions: repeatLegacyPreview.conflicts.map((conflict) => ({ key: conflict.key, action: "use_incoming" })) } });
    assert.equal((await requestData(baseUrl, `/api/chats/${legacyChatId}/memories/${legacyMemoryId}/revisions`)).length, 1);
    await permanentlyDeleteChat(baseUrl, legacyChatId);

    const beforeFailedRestore = await requestData(baseUrl, "/api/backups/export");
    const corruptionDb = new DatabaseSync(tempDbPath);
    try {
      corruptionDb
        .prepare('UPDATE "RecoveryPoint" SET "snapshot" = ? WHERE "id" = ?')
        .run(JSON.stringify({ schemaVersion: 1, characters: "damaged" }), restoreResult.safetyRecoveryPointId);
    } finally {
      corruptionDb.close();
    }
    const failedRestore = await request(
      baseUrl,
      `/api/backups/recovery-points/${restoreResult.safetyRecoveryPointId}/restore`,
      { method: "POST", expectedStatus: 400 }
    );
    assert.equal(failedRestore.ok, false);
    assert.deepEqual(
      withoutExportTimestamp(await requestData(baseUrl, "/api/backups/export")),
      withoutExportTimestamp(beforeFailedRestore)
    );

    const pulledSyncPreview = await requestData(baseUrl, "/api/sync/pull", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge",
        phase: "preview"
      }
    });
    const syncInfo = await requestData(baseUrl, "/api/sync/info");
    assert.equal(syncInfo.port, port);
    assert.equal(syncInfo.localUrl, `http://127.0.0.1:${port}`);
    assert.equal(Array.isArray(syncInfo.lanUrls), true);
    assert.equal(typeof syncInfo.lanReachable, "boolean");

    assert.equal(pulledSyncPreview.direction, "pull");
    assert.equal(pulledSyncPreview.phase, "preview");
    assert.equal(pulledSyncPreview.summary, null);
    const pulledSyncSummary = await requestData(baseUrl, "/api/sync/pull", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge",
        phase: "execute",
        previewId: pulledSyncPreview.preview.previewId,
        conflictResolutions: []
      }
    });
    assert.equal(pulledSyncSummary.phase, "execute");
    assert.ok(pulledSyncSummary.summary.skipped > 0);

    const pushedSyncPreview = await requestData(baseUrl, "/api/sync/push", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge",
        phase: "preview"
      }
    });
    const pushedSyncSummary = await requestData(baseUrl, "/api/sync/push", {
      method: "POST",
      body: {
        peerBaseUrl: baseUrl,
        mode: "merge",
        phase: "execute",
        previewId: pushedSyncPreview.preview.previewId,
        conflictResolutions: []
      }
    });
    assert.equal(pushedSyncSummary.direction, "push");
    assert.equal(pushedSyncSummary.mode, "merge");
    assert.equal(pushedSyncSummary.phase, "execute");
    assert.ok(pushedSyncSummary.summary.skipped > 0);

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
    assert.equal(messagesAfterTimelineDeletion.length, 3);

    await request(baseUrl, `/api/messages/${assistantMessage.id}`, {
      method: "DELETE",
      expectedStatus: 204
    });
    const remainingMessages = await requestData(
      baseUrl,
      `/api/messages?${new URLSearchParams({ chatId: createdChat.id }).toString()}`
    );
    assert.equal(remainingMessages.length, 2);

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
    assert.equal((await requestData(baseUrl, `/api/chats/${createdChat.id}`)).messages.length, 2);
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
  } catch (error) {
    if (error instanceof Error && error.stack) console.error(error.stack);
    console.error(`[smoke-api] isolated server diagnostics\n${server?.output() ?? "server not started"}`);
    try {
      const diagnosticDb = new DatabaseSync(tempDbPath, { readOnly: true });
      const lifecycle = diagnosticDb.prepare('SELECT id, module, operation, status, activeAttemptId, outputStarted, errorCode, messageId FROM "ModelRequest" ORDER BY createdAt DESC LIMIT 8').all();
      const attempts = diagnosticDb.prepare('SELECT id, requestId, attemptNumber, module, status, errorCode, messageId, reservedCostMicros FROM "ModelUsageAttempt" ORDER BY startedAt DESC LIMIT 12').all();
      diagnosticDb.close();
      const characterDraftLifecycle = lifecycle.find((item) => item.id === `character-draft-${runId}`);
      assert.equal(characterDraftLifecycle?.module, "agent");
      assert.equal(characterDraftLifecycle?.operation, "character_refine_prompt");
      assert.equal(characterDraftLifecycle?.status, "succeeded");
      assert.equal(attempts.some((item) => item.requestId === `character-draft-${runId}` && item.module === "agent" && item.status === "succeeded"), true);
      console.error(`[smoke-api] lifecycle diagnostics\n${JSON.stringify({ lifecycle, attempts }, null, 2)}`);
    } catch (diagnosticError) {
      console.error(`[smoke-api] lifecycle diagnostics unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
    }
    throw error;
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
