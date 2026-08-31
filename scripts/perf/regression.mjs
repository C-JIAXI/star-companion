import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PERF_DATASET_PROFILES, perfMarkerName, seedPerformanceDataset } from "./dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requested = process.argv.slice(2).filter((argument) => argument.startsWith("--profiles="))[0]?.split("=")[1];
const profiles = (requested ?? "small,medium").split(",").filter(Boolean);
for (const profile of profiles) if (!PERF_DATASET_PROFILES[profile]) throw new Error(`Unknown profile: ${profile}`);

const results = [];
for (const profileName of profiles) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `star-companion-regression-${profileName}-`));
  try {
    const databasePath = path.join(directory, "performance.db");
    const metadata = await seedPerformanceDataset({
      profileName,
      seed: 20260831,
      databasePath,
      mediaDirectory: path.join(directory, "media"),
      migrationsDirectory: path.join(root, "apps/server/prisma/migrations")
    });
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const scalar = (sql, ...params) => Number(Object.values(db.prepare(sql).get(...params))[0]);
    const expected = PERF_DATASET_PROFILES[profileName];
    if (scalar('SELECT COUNT(*) FROM "Character"') !== expected.characters) throw new Error(`${profileName}: character count drifted.`);
    if (scalar('SELECT COUNT(*) FROM "Chat"') !== expected.chats) throw new Error(`${profileName}: chat count drifted.`);
    if (scalar('SELECT COUNT(*) FROM "Message"') !== expected.messages) throw new Error(`${profileName}: message count drifted.`);
    if (scalar('SELECT COUNT(*) FROM "MessageSearch"') !== expected.messages) throw new Error(`${profileName}: message search index drifted.`);
    if (scalar('SELECT COUNT(*) FROM "ChatMemory"') !== expected.memories) throw new Error(`${profileName}: memory count drifted.`);
    if (scalar('SELECT COUNT(*) FROM "Message" WHERE chatId = ?', "chat-000000000") !== expected.longChatMessages) throw new Error(`${profileName}: long-chat size drifted.`);
    if (scalar("SELECT COUNT(*) FROM pragma_foreign_key_check") !== 0) throw new Error(`${profileName}: broken references detected.`);
    const messagePlan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Message" WHERE chatId = ? ORDER BY createdAt DESC, id DESC LIMIT 50').all("chat-000000000").map((row) => String(row.detail)).join(" ");
    const chatPlan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Chat" WHERE deletedAt IS NULL AND isArchived = 0 AND isCheckpoint = 0 ORDER BY isPinned DESC, updatedAt DESC, id DESC LIMIT 50').all().map((row) => String(row.detail)).join(" ");
    const searchPlan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM "MessageSearch" WHERE content MATCH ?').all('"deterministic"').map((row) => String(row.detail)).join(" ");
    if (!messagePlan.includes("Message_chatId_createdAt_id_idx") || /TEMP B-TREE/i.test(messagePlan)) throw new Error(`${profileName}: message page lost its covering index.`);
    if (!chatPlan.includes("Chat_deletedAt_isArchived_isCheckpoint_isPinned_updatedAt_id_idx") || /TEMP B-TREE/i.test(chatPlan)) throw new Error(`${profileName}: chat page lost its composite index.`);
    if (!/VIRTUAL TABLE INDEX/i.test(searchPlan)) throw new Error(`${profileName}: message search lost its FTS index.`);
    db.close();
    results.push({ profileName, seed: 20260831, counts: metadata.counts, schemaVersion: metadata.schemaVersion, queryPlans: { messages: "indexed", chats: "indexed", search: "fts5-trigram" }, success: true });
  } finally {
    const marker = await readFile(path.join(directory, perfMarkerName), "utf8");
    if (!marker) throw new Error("Performance marker disappeared before cleanup.");
    await rm(directory, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ kind: "correctness", generatedAt: new Date().toISOString(), results, success: true }, null, 2));
