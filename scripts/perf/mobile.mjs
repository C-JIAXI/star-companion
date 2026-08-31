import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { Agent } from "undici";
import { PERF_DATASET_PROFILES, perfMarkerName } from "./dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the mobile benchmark through npm so build dependencies can be prepared safely.");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const profileName = args.get("--profile") ?? "mobile-large";
const profile = PERF_DATASET_PROFILES[profileName];
const samples = Number(args.get("--samples") ?? 12);
const outputArg = args.get("--output");
const includeBulk = args.get("--bulk") === "true";
const perfHttpAgent = new Agent({ headersTimeout: 11 * 60_000, bodyTimeout: 11 * 60_000 });
if (!profile) throw new Error(`Unknown performance profile: ${profileName}`);
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 100) throw new Error("--samples must be an integer from 5 to 100.");

const pad = (prefix, value) => `${prefix}-${String(value).padStart(9, "0")}`;
const iso = (index) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString();
const round = (value) => Math.round(value * 100) / 100;
const percentile = (values, fraction) => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref().on("error", reject).listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Unable to allocate a local port."));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await once(killer, "exit").catch(() => undefined);
  } else {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => undefined);
  }
};
const run = async (command, commandArgs, options = {}) => {
  const processHandle = spawn(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
  const [code] = await once(processHandle, "exit");
  if (code !== 0) throw new Error(`Performance preparation failed with exit code ${code}.`);
};
const requestData = async (baseUrl, pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    dispatcher: perfHttpAgent,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(`Mobile performance route ${pathname.split("?")[0]} failed with HTTP ${response.status}${typeof payload?.error === "string" ? ` (${payload.error.slice(0, 200)})` : ""}.`);
  return payload.data;
};
const distributeMessages = () => {
  const counts = Array(profile.chats).fill(0);
  counts[0] = profile.longChatMessages;
  let remaining = profile.messages - profile.longChatMessages;
  for (let chat = 1; remaining > 0; chat = chat === profile.chats - 1 ? 1 : chat + 1) {
    counts[chat] += 1;
    remaining -= 1;
  }
  return counts;
};
const deterministicImage = (seed) => {
  const image = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = (seed * 31 + index) % 256;
    image.data[index + 1] = (seed * 47 + index * 3) % 256;
    image.data[index + 2] = (seed * 61 + index * 5) % 256;
    image.data[index + 3] = 255;
  }
  const bytes = PNG.sync.write(image);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
};

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), `star-companion-mobile-perf-${profileName}-`));
const markerPath = path.join(temporaryDirectory, perfMarkerName);
let child;
try {
  await run(process.execPath, [npmCli, "run", "build", "--prefix", "apps/server"]);
  await run(process.execPath, [path.join(root, "scripts/mobile/prepare-mobile-backend.mjs")], {
    env: { ...process.env, MOBILE_BACKEND_SKIP_WEB_NODE_COPY: "1" }
  });
  await writeFile(markerPath, JSON.stringify({ profileName, seed: 20260831 }), { flag: "wx" });
  const { MobileStore } = await import("../../apps/mobile-backend/src/store.mjs");
  const store = new MobileStore(path.join(temporaryDirectory, "mobile-backend.json"));
  await store.load();
  const messageCounts = distributeMessages();
  const startedAt = performance.now();
  await store.atomicWrite(async () => {
    for (let index = 0; index < profile.characters; index += 1) {
      await store.writeRecord("character", {
        id: pad("char", index), cardId: pad("card", index), name: `Mobile Character ${index}`,
        avatar: null, description: `Deterministic mobile character ${index}`, prefix: `Prefix ${index}`,
        prompt: `Core prompt ${index}`, suffix: `Suffix ${index}`, htmlCss: "", openingHtml: "",
        tags: [`tag-${index % 12}`], loreEntries: [], quickReplies: [], isFavorite: index % 9 === 0,
        createdAt: iso(index), updatedAt: iso(index)
      });
    }
    let messageIndex = 0;
    for (let chatIndex = 0; chatIndex < profile.chats; chatIndex += 1) {
      const chatId = pad("chat", chatIndex);
      await store.writeRecord("chat", {
        id: chatId, title: chatIndex === 0 ? "Mobile long chat" : `Mobile Chat ${chatIndex}`,
        characterId: pad("char", chatIndex % profile.characters), parentChatId: null,
        branchSourceMessageId: null, isCheckpoint: false, isPinned: chatIndex % 23 === 0,
        isArchived: chatIndex % 29 === 0, folder: chatIndex % 5 === 0 ? `Folder ${chatIndex % 10}` : "",
        deletedAt: chatIndex > 0 && chatIndex % 37 === 0 ? iso(profile.messages + chatIndex) : null,
        backgroundUrl: "", memoryTurns: 12, autoMemoryEnabled: true, memoryUpdatedAt: null,
        userPersona: "", userAvatar: "", userProfileSummary: "", userProfileUpdatedAt: null,
        profileRevision: 0, createdAt: iso(chatIndex), updatedAt: iso(profile.messages + chatIndex)
      });
      for (let localIndex = 0; localIndex < messageCounts[chatIndex]; localIndex += 1) {
        const role = messageIndex % 2 ? "assistant" : "user";
        await store.writeRecord("message", {
          id: pad("msg", messageIndex), chatId, role,
          characterId: role === "assistant" ? pad("char", chatIndex % profile.characters) : null,
          content: `Mobile deterministic message ${messageIndex} for bounded performance validation.`,
          contextIncluded: messageIndex % 17 !== 0, isBookmarked: messageIndex % 53 === 0,
          variants: [], activeVariantIndex: 0, tokenUsage: null, generationMetadata: null,
          variantMetadata: [], promptBreakdown: null, loreMatches: null, memoryMatches: null,
          createdAt: iso(messageIndex), updatedAt: iso(messageIndex)
        });
        messageIndex += 1;
      }
    }
    for (let index = 0; index < profile.memories; index += 1) {
      await store.writeRecord("memory", {
        id: pad("memory", index), chatId: pad("chat", index % profile.chats),
        title: `Mobile memory ${index}`, content: `Deterministic memory ${index}`,
        keywords: [`memory-${index % 17}`], importance: 1 + index % 5, enabled: index % 31 !== 0,
        deletedAt: index % 43 === 0 ? iso(profile.messages + index) : null, currentRevision: 1,
        lastActor: "restore", lastAction: "baseline", sourceMessageIds: [], embedding: null,
        embeddingModel: null, embeddingSource: null, embeddingDimensions: null, embeddingStatus: "stale",
        embeddingUpdatedAt: null, lastMatchedAt: null, createdAt: iso(index), updatedAt: iso(index)
      });
    }
    for (let index = 0; index < profile.mediaAssets; index += 1) {
      const { bytes: imageBytes, hash: imageHash } = deterministicImage(index + 20260831);
      await store.writeRecord("mediaAsset", {
        id: pad("asset", index), contentHash: imageHash, mimeType: "image/png", byteSize: imageBytes.length,
        width: 4, height: 4, storageKey: `sha256:${imageHash}`, dataBase64: imageBytes.toString("base64"), createdAt: iso(index)
      });
    }
    for (let index = 0; index < profile.attachments; index += 1) {
      await store.writeRecord("messageAttachment", {
        id: pad("attachment", index), messageId: pad("msg", Math.floor(index * profile.messages / profile.attachments)),
        draftId: null, assetId: pad("asset", index % profile.mediaAssets), sortOrder: 0,
        originalFilename: `fixture-${index}.png`, createdAt: iso(index)
      });
    }
  });
  store.db.close();
  const seedDurationMs = round(performance.now() - startedAt);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  child = spawn(process.execPath, [path.join(root, "apps/mobile-backend/src/index.mjs")], {
    cwd: root,
    env: {
      ...process.env, MOBILE_BACKEND_PORT: String(port), MOBILE_BACKEND_HOST: "127.0.0.1",
      MOBILE_BACKEND_DATA_DIR: temporaryDirectory,
      API_KEY_ENCRYPTION_SECRET: "performance-fixture-secret-0123456789abcdef",
      STAR_COMPANION_PERF_METRICS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Mobile performance backend exited early: ${output}`);
    try { await requestData(baseUrl, "/api/health"); break; } catch { await delay(100); }
  }
  const first = await requestData(baseUrl, `/api/messages/page?chatId=${pad("chat", 0)}&limit=50`);
  const operations = [
    { id: "messages_latest", path: `/api/messages/page?chatId=${pad("chat", 0)}&limit=50&includeTotal=true`, rows: (data) => data.items.length },
    { id: "messages_older", path: `/api/messages/page?chatId=${pad("chat", 0)}&limit=50&cursor=${encodeURIComponent(first.nextCursor)}`, rows: (data) => data.items.length },
    { id: "bookmarks", path: `/api/messages/page?chatId=${pad("chat", 0)}&limit=50&bookmarkedOnly=true&includeTotal=true`, rows: (data) => data.items.length },
    { id: "chats_first_page", path: "/api/chats/page?scope=active&limit=50&includeTotal=true", rows: (data) => data.items.length },
    { id: "characters_first_page", path: "/api/characters/page?page=1&pageSize=40&sort=favorites", rows: (data) => data.items.length },
    { id: "message_search", path: "/api/chats/message-search?q=deterministic&limit=20", rows: (data) => data.results.length },
    { id: "memory_page", path: `/api/chats/${pad("chat", 0)}/memories/page?limit=100&includeTotal=true`, rows: (data) => data.items.length },
    { id: "prompt_context", path: `/api/perf/prompt/${pad("chat", 0)}`, rows: (data) => data.historyCount }
  ];
  const results = [];
  const bulkResults = [];
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;
  for (const operation of operations) {
    await requestData(baseUrl, operation.path);
    const durations = [];
    let returnedRows = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const start = performance.now();
      const data = await requestData(baseUrl, operation.path);
      durations.push(performance.now() - start);
      returnedRows = operation.rows(data);
      const memory = await requestData(baseUrl, "/api/perf/metrics");
      peakRssBytes = Math.max(peakRssBytes, memory.rssBytes);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsedBytes);
    }
    results.push({
      id: operation.id, samples, returnedRows,
      timingMs: { p50: round(percentile(durations, 0.5)), p95: round(percentile(durations, 0.95)), max: round(Math.max(...durations)) },
      success: true
    });
  }
  if (includeBulk) {
    const measureBulk = async (id, operation, details = () => ({})) => {
      const start = performance.now();
      const data = await operation();
      const memory = await requestData(baseUrl, "/api/perf/metrics");
      peakRssBytes = Math.max(peakRssBytes, memory.rssBytes);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsedBytes);
      bulkResults.push({ id, durationMs: round(performance.now() - start), ...details(data), success: true });
      return data;
    };
    await measureBulk("storage_health_summary", () => requestData(baseUrl, "/api/storage-health/summary"), (data) => ({ categoryCount: data.categories.length }));
    await measureBulk("storage_health_deep_scan", async () => {
      let scan = await requestData(baseUrl, "/api/storage-health/deep-scans", { method: "POST" });
      while (scan.state === "idle" || scan.state === "running") {
        await delay(25);
        scan = await requestData(baseUrl, `/api/storage-health/deep-scans/${scan.id}`);
      }
      if (scan.state !== "completed") throw new Error(`Mobile-large deep scan ended in ${scan.state}.`);
      return scan;
    }, (data) => ({ scanned: data.checkedItems, issueCount: data.issues.length }));
    const backup = await measureBulk("backup_export", () => requestData(baseUrl, "/api/backups/export"), (data) => ({ messages: data.messages.length, memories: data.memories.length }));
    const previewBody = JSON.stringify({ ...backup, mode: "replace" });
    const preview = await measureBulk("backup_replace_preview", () => requestData(baseUrl, "/api/backups/preview", { method: "POST", body: previewBody }), (data) => ({ requestBytes: Buffer.byteLength(previewBody), conflicts: data.counts.conflicts, invalid: data.counts.invalid }));
    if (!preview.canExecute || preview.counts.invalid) throw new Error("Mobile-large replace preview was not executable.");
    const executeBody = JSON.stringify({ ...backup, mode: "replace", previewId: preview.previewId, conflictResolutions: [] });
    const imported = await measureBulk("backup_replace_execute", () => requestData(baseUrl, "/api/backups/import", { method: "POST", body: executeBody }), (data) => ({ recoveryPointCreated: Boolean(data.recoveryPointId), messages: data.messages }));
    if (!imported.recoveryPointId) throw new Error("Mobile-large replace did not create a recovery point.");
    await measureBulk("recovery_point_restore", () => requestData(baseUrl, `/api/backups/recovery-points/${imported.recoveryPointId}/restore`, { method: "POST" }), (data) => ({ safetyRecoveryPointCreated: Boolean(data.safetyRecoveryPointId), messages: data.summary.messages }));
    const restored = await requestData(baseUrl, `/api/messages/page?chatId=${pad("chat", 0)}&limit=1&includeTotal=true`);
    if (restored.total !== profile.longChatMessages) throw new Error(`Mobile-large recovery changed long chat size to ${restored.total}.`);
  }
  const report = {
    kind: "mobile", profileName, seed: 20260831,
    appVersion: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
    schemaVersion: "005_message_search",
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length },
    run: { temperature: "warm", samples, includeBulk, generatedAt: new Date().toISOString(), seedDurationMs },
    dataset: { characters: profile.characters, chats: profile.chats, messages: profile.messages, longChatMessages: profile.longChatMessages, memories: profile.memories, mediaAssets: profile.mediaAssets, attachments: profile.attachments },
    metrics: { peakRssBytes, peakHeapUsedBytes, operations: results, bulkOperations: bulkResults }, success: true
  };
  const outputPath = outputArg ? path.resolve(outputArg) : path.join(root, "perf-results", `mobile-${profileName}.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop(child);
  await perfHttpAgent.close();
  const marker = await readFile(markerPath, "utf8").catch(() => "");
  if (!marker) throw new Error("Refusing to clean mobile performance data without its marker.");
  await rm(temporaryDirectory, { recursive: true, force: true });
}
