import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 4111;
const dataDir = await mkdtemp(path.join(os.tmpdir(), "star-companion-mobile-"));

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
  const prepare = spawn("node", ["scripts/prepare-mobile-backend.mjs"], {
    cwd: rootDir,
    stdio: "inherit"
  });
  prepare.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`mobile backend prepare failed: ${code}`))
  );
});

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

  const message = await request("/api/messages", {
    method: "POST",
    body: {
      chatId: chat.id,
      role: "user",
      characterId: null,
      content: "Hello from mobile smoke.",
      variants: [],
      activeVariantIndex: 0
    }
  });
  assert.equal(message.chatId, chat.id);

  const backup = await request("/api/backups/export");
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.characters.length, 1);
  assert.equal(backup.chats.length, 1);
  assert.equal(backup.messages.length, 1);

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
  assert.equal(pulledSyncSummary.summary.messages, 1);

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
  assert.equal(pushedSyncSummary.summary.messages, 1);

  console.log("Mobile backend smoke passed");
} finally {
  child.kill();
  await rm(dataDir, { recursive: true, force: true });
}
