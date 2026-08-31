import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import { PERF_DATASET_PROFILES, perfMarkerName, seedPerformanceDataset } from "./dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverDir = path.join(root, "apps/server");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const profileName = args.get("--profile") ?? "small";
const samples = Number(args.get("--samples") ?? (profileName === "large" ? 12 : 20));
const outputArg = args.get("--output");
const keep = args.get("--keep") === "true";
const includeBulk = args.get("--bulk") === "true";
const perfHttpAgent = new Agent({ headersTimeout: 11 * 60_000, bodyTimeout: 11 * 60_000 });
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 200) throw new Error("--samples must be an integer from 5 to 200.");

const percentile = (values, fraction) => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
};
const round = (value) => Math.round(value * 100) / 100;
const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Unable to allocate a local port."));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestData = async (baseUrl, pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    dispatcher: perfHttpAgent,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    const safeDetail = typeof payload?.error === "string" ? ` (${payload.error.slice(0, 240)})` : "";
    const safeIssues = Array.isArray(payload?.details)
      ? ` ${JSON.stringify(payload.details.slice(0, 3).map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })))}`
      : "";
    throw new Error(`Safe route ${pathname.split("?")[0]} failed with HTTP ${response.status}${safeDetail}${safeIssues}.`);
  }
  return payload.data;
};
const waitForServer = async (baseUrl, child, output) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Performance server exited early: ${output()}`);
    try { await requestData(baseUrl, "/api/health"); return; } catch { await delay(100); }
  }
  throw new Error(`Performance server did not become healthy: ${output()}`);
};
const stopServer = async (child) => {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await once(killer, "exit").catch(() => undefined); return;
  }
  child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => undefined);
  if (child.exitCode === null) child.kill("SIGKILL");
};
const safeCleanup = async (directory) => {
  const resolved = path.resolve(directory); const temp = path.resolve(os.tmpdir());
  const relative = path.relative(temp, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to clean a non-temporary performance directory.");
  await readFile(path.join(resolved, perfMarkerName), "utf8");
  await rm(resolved, { recursive: true, force: true });
};

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), `star-companion-perf-${profileName}-`));
const databasePath = path.join(temporaryDirectory, "performance.db");
const mediaDirectory = path.join(temporaryDirectory, "media");
let child;
let serverOutput = "";
try {
  const seedMetadata = await seedPerformanceDataset({ profileName, seed: 20260831, databasePath, mediaDirectory, migrationsDirectory: path.join(serverDir, "prisma/migrations") });
  console.error(`[perf] seeded ${profileName} in ${seedMetadata.durationMs} ms`);
  const verificationDb = new DatabaseSync(databasePath, { readOnly: true });
  const expectedSearchTotal = Number(verificationDb.prepare(`
    SELECT COUNT(*) AS count FROM Message AS m NOT INDEXED
    JOIN Chat AS c ON c.id = m.chatId
    WHERE c.deletedAt IS NULL AND instr(lower(m.content), 'deterministic') > 0
  `).get().count);
  verificationDb.close();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tsx = path.join(serverDir, "node_modules/tsx/dist/cli.mjs");
  child = spawn(process.execPath, [tsx, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: `file:${databasePath.replaceAll("\\", "/")}`, SERVER_PORT: String(port), CORS_ORIGIN: "http://127.0.0.1:5173", API_KEY_ENCRYPTION_SECRET: "performance-fixture-secret-0123456789abcdef", STAR_COMPANION_DATA_DIR: temporaryDirectory, STAR_COMPANION_PERF_METRICS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); if (includeBulk) process.stderr.write(chunk); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); if (includeBulk) process.stderr.write(chunk); });
  await waitForServer(baseUrl, child, () => serverOutput);

  const firstMessagePage = await requestData(baseUrl, "/api/messages/page?chatId=chat-000000000&limit=50&includeTotal=false");
  if (!firstMessagePage.nextCursor) throw new Error("The long-chat fixture did not produce an older-message cursor.");
  const operations = [
    { id: "messages_latest", path: "/api/messages/page?chatId=chat-000000000&limit=50&includeTotal=true", rows: (data) => data.items.length },
    { id: "messages_older", path: `/api/messages/page?chatId=chat-000000000&limit=50&includeTotal=false&cursor=${encodeURIComponent(firstMessagePage.nextCursor)}`, rows: (data) => data.items.length },
    { id: "chats_first_page", path: "/api/chats/page?scope=active&limit=50&includeTotal=true", rows: (data) => data.items.length },
    { id: "characters_first_page", path: "/api/characters/page?page=1&pageSize=40&sort=favorites", rows: (data) => data.items.length },
    { id: "message_search", path: "/api/chats/message-search?q=deterministic&limit=20", rows: (data) => data.results.length, validate: (data) => {
      if (data.total !== expectedSearchTotal) throw new Error(`Message search returned total ${data.total}; expected ${expectedSearchTotal}.`);
    } },
    { id: "prompt_context", path: "/api/perf/prompt/chat-000000000", rows: (data) => data.historyCount }
  ];
  const results = [];
  const bulkResults = [];
  let peakRssBytes = 0; let peakHeapUsedBytes = 0;
  for (const operation of operations) {
    console.error(`[perf] measuring ${operation.id}`);
    operation.validate?.(await requestData(baseUrl, operation.path));
    const durations = []; const queryCounts = []; let returnedRows = 0;
    for (let index = 0; index < samples; index += 1) {
      const before = await requestData(baseUrl, "/api/perf/metrics");
      const start = performance.now();
      const data = await requestData(baseUrl, operation.path);
      operation.validate?.(data);
      durations.push(performance.now() - start);
      const after = await requestData(baseUrl, "/api/perf/metrics");
      queryCounts.push(after.queryCount - before.queryCount);
      peakRssBytes = Math.max(peakRssBytes, after.rssBytes);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, after.heapUsedBytes);
      returnedRows = operation.rows(data);
    }
    results.push({ id: operation.id, samples, returnedRows, timingMs: { p50: round(percentile(durations, 0.5)), p95: round(percentile(durations, 0.95)), max: round(Math.max(...durations)) }, queries: { min: Math.min(...queryCounts), max: Math.max(...queryCounts) }, success: true });
  }

  if (includeBulk) {
    const measureBulk = async (id, operation, details = () => ({})) => {
      console.error(`[perf] measuring bulk ${id}`);
      const before = await requestData(baseUrl, "/api/perf/metrics");
      const startedAt = performance.now();
      const data = await operation();
      const durationMs = round(performance.now() - startedAt);
      const after = await requestData(baseUrl, "/api/perf/metrics");
      peakRssBytes = Math.max(peakRssBytes, after.rssBytes);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, after.heapUsedBytes);
      bulkResults.push({ id, durationMs, queries: after.queryCount - before.queryCount, ...details(data), success: true });
      return data;
    };

    await measureBulk("storage_health_summary", () => requestData(baseUrl, "/api/storage-health/summary"), (data) => ({ categoryCount: data.categories.length }));
    const scan = await measureBulk("storage_health_deep_scan", async () => {
      let state = await requestData(baseUrl, "/api/storage-health/deep-scans", { method: "POST" });
      while (state.state === "idle" || state.state === "running") {
        await delay(25);
        state = await requestData(baseUrl, `/api/storage-health/deep-scans/${state.id}`);
      }
      if (state.state !== "completed") throw new Error(`Large deep scan ended in ${state.state}.`);
      return state;
    }, (data) => ({ scanned: data.checkedItems, issueCount: data.issues.length }));
    if (scan.progress !== 100) throw new Error("Large deep scan did not reach 100%.");

    const backup = await measureBulk("backup_export", () => requestData(baseUrl, "/api/backups/export"), (data) => ({
      characters: data.characters.length,
      chats: data.chats.length,
      messages: data.messages.length,
      memories: data.memories.length
    }));
    const previewBody = JSON.stringify({ ...backup, mode: "replace" });
    const preview = await measureBulk("backup_replace_preview", () => requestData(baseUrl, "/api/backups/preview", { method: "POST", body: previewBody }), (data) => ({
      requestBytes: Buffer.byteLength(previewBody),
      conflicts: data.counts.conflicts,
      invalid: data.counts.invalid,
      deletes: data.counts.deleted
    }));
    if (!preview.canExecute || preview.counts.invalid !== 0) throw new Error("Large replace preview was not executable.");
    const executeBody = JSON.stringify({ ...backup, mode: "replace", previewId: preview.previewId, conflictResolutions: [] });
    const imported = await measureBulk("backup_replace_execute", () => requestData(baseUrl, "/api/backups/import", { method: "POST", body: executeBody }), (data) => ({
      requestBytes: Buffer.byteLength(executeBody),
      recoveryPointCreated: Boolean(data.recoveryPointId),
      messages: data.messages
    }));
    if (!imported.recoveryPointId) throw new Error("Large replace import did not create a recovery point.");
    await measureBulk("recovery_point_restore", () => requestData(baseUrl, `/api/backups/recovery-points/${imported.recoveryPointId}/restore`, { method: "POST" }), (data) => ({
      safetyRecoveryPointCreated: Boolean(data.safetyRecoveryPointId),
      messages: data.summary.messages
    }));
    const restoredPage = await requestData(baseUrl, "/api/messages/page?chatId=chat-000000000&limit=1&includeTotal=true");
    const expectedLongChatMessages = PERF_DATASET_PROFILES[profileName]?.longChatMessages;
    if (restoredPage.total !== expectedLongChatMessages) throw new Error(`Recovery restore changed the long chat size to ${restoredPage.total}.`);
  }

  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  const sqliteVersion = sqlite.prepare("SELECT sqlite_version() AS version").get().version;
  const planDefinitions = {
    messages_latest: ["SELECT id FROM Message WHERE chatId = ? ORDER BY createdAt DESC, id DESC LIMIT 50", "chat-000000000"],
    chats_first_page: ["SELECT id FROM Chat WHERE deletedAt IS NULL AND isArchived = 0 AND isCheckpoint = 0 ORDER BY isPinned DESC, updatedAt DESC, id DESC LIMIT 50"],
    message_search: ['SELECT COUNT(*) FROM MessageSearch WHERE content MATCH ?', '"deterministic"']
  };
  const queryPlans = Object.fromEntries(Object.entries(planDefinitions).map(([id, [sql, ...parameters]]) => [id, sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => String(row.detail))]));
  sqlite.close();
  const gitCommit = await new Promise((resolve) => {
    const proc = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let value = "unknown"; proc.stdout.on("data", (chunk) => { value = chunk.toString().trim(); }); proc.on("close", () => resolve(value));
  });
  const report = { kind: "server", profileName, seed: 20260831, appVersion: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, schemaVersion: seedMetadata.schemaVersion, workspace: gitCommit, environment: { platform: process.platform, arch: process.arch, node: process.version, sqlite: sqliteVersion, cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, run: { temperature: "warm", samples, includeBulk, generatedAt: new Date().toISOString() }, dataset: seedMetadata.counts, metrics: { peakRssBytes, peakHeapUsedBytes, operations: results, bulkOperations: bulkResults, queryPlans }, success: true };
  const output = outputArg ? path.resolve(outputArg) : path.join(root, "perf-results", `server-${profileName}.json`);
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child) await stopServer(child);
  await perfHttpAgent.close();
  if (!keep) await safeCleanup(temporaryDirectory);
}
