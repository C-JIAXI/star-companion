import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";

export const PERF_DATASET_PROFILES = Object.freeze({
  small: { characters: 20, chats: 50, messages: 2_000, longChatMessages: 500, memories: 200, mediaAssets: 20, attachments: 40 },
  medium: { characters: 200, chats: 1_000, messages: 25_000, longChatMessages: 5_000, memories: 2_000, mediaAssets: 500, attachments: 1_000 },
  large: { characters: 1_000, chats: 5_000, messages: 200_000, longChatMessages: 20_000, memories: 10_000, mediaAssets: 1_000, attachments: 5_000 },
  "mobile-large": { characters: 300, chats: 1_500, messages: 60_000, longChatMessages: 10_000, memories: 3_000, mediaAssets: 250, attachments: 1_500 }
});

const MARKER = ".star-companion-perf";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const json = (value) => JSON.stringify(value);
const dbTime = (index, group = 1) => BASE_TIME + Math.floor(index / group) * 1_000;
const iso = (index, group = 1) => new Date(BASE_TIME + Math.floor(index / group) * 1_000).toISOString();
const padded = (prefix, value, width = 9) => `${prefix}-${String(value).padStart(width, "0")}`;

const isInside = (parent, target) => {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const assertSafePerfPaths = async ({ databasePath, mediaDirectory }) => {
  const tempRoot = path.resolve(os.tmpdir());
  const db = path.resolve(databasePath);
  const media = path.resolve(mediaDirectory);
  if (!isInside(tempRoot, db) || !isInside(tempRoot, media)) {
    throw new Error(`Performance data must stay inside the operating-system temporary directory (${tempRoot}).`);
  }
  const forbiddenNames = new Set(["dev.db", "test.db", "production.db", "star-companion.db"]);
  if (forbiddenNames.has(path.basename(db).toLowerCase())) {
    throw new Error("Refusing to use a database name associated with development or user data.");
  }
  const common = path.dirname(db);
  if (!isInside(common, media) && path.resolve(common) !== path.resolve(media)) {
    throw new Error("The explicit media directory must be contained beside the temporary performance database.");
  }
};

const initializeDatabase = async (databasePath, migrationsDirectory) => {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );`);
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDirectory, name, "migration.sql"), "utf8");
    db.exec(sql);
    const appliedAt = new Date().toISOString();
    db.prepare('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)')
      .run(randomUUID(), createHash("sha256").update(sql).digest("hex"), appliedAt, name, appliedAt);
  }
  return { db, schemaVersion: names.at(-1) ?? "unknown" };
};

const deterministicPng = (index) => {
  const image = new PNG({ width: 4, height: 4 });
  for (let pixel = 0; pixel < 16; pixel += 1) {
    const offset = pixel * 4;
    image.data[offset] = ((index >>> (pixel % 3) * 8) + pixel * 17) % 256;
    image.data[offset + 1] = ((index * 47) + pixel * 29) % 256;
    image.data[offset + 2] = ((index * 61) + pixel * 13) % 256;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
};

const messageContent = (index) => {
  if (index % 97 === 0) return `性能样本 ${index}\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``;
  if (index % 43 === 0) return `<section><strong>Synthetic fragment ${index}</strong></section>`;
  if (index % 7 === 0) return `中英文混合消息 ${index} — deterministic local performance fixture.`;
  return `Synthetic message ${index} for deterministic local-only performance validation.`;
};

const distributeMessages = (profile) => {
  const counts = Array(profile.chats).fill(0);
  counts[0] = profile.longChatMessages;
  let remaining = profile.messages - profile.longChatMessages;
  for (let chat = 1; remaining > 0; chat = chat === profile.chats - 1 ? 1 : chat + 1) {
    counts[chat] += 1;
    remaining -= 1;
  }
  return counts;
};

const runTransaction = (db, task) => {
  db.exec("BEGIN IMMEDIATE");
  try { task(); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};

const suspendMessageSearchIndex = (db) => {
  db.exec(`
    DROP TRIGGER IF EXISTS "Message_search_after_insert";
    DROP TRIGGER IF EXISTS "Message_search_after_update";
    DROP TRIGGER IF EXISTS "Message_search_after_delete";
    DELETE FROM "MessageSearch";
  `);
};

const rebuildMessageSearchIndex = (db) => {
  runTransaction(db, () => {
    db.exec('INSERT INTO "MessageSearch" ("messageId", "chatId", "content") SELECT "id", "chatId", "content" FROM "Message";');
  });
  db.exec(`
    CREATE TRIGGER "Message_search_after_insert" AFTER INSERT ON "Message" BEGIN
      INSERT INTO "MessageSearch" ("messageId", "chatId", "content") VALUES (new."id", new."chatId", new."content");
    END;
    CREATE TRIGGER "Message_search_after_update" AFTER UPDATE OF "content", "chatId" ON "Message" BEGIN
      DELETE FROM "MessageSearch" WHERE "messageId" = old."id";
      INSERT INTO "MessageSearch" ("messageId", "chatId", "content") VALUES (new."id", new."chatId", new."content");
    END;
    CREATE TRIGGER "Message_search_after_delete" AFTER DELETE ON "Message" BEGIN
      DELETE FROM "MessageSearch" WHERE "messageId" = old."id";
    END;
  `);
};

export const seedPerformanceDataset = async ({ profileName, seed = 20260831, databasePath, mediaDirectory, migrationsDirectory }) => {
  const profile = PERF_DATASET_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown performance profile: ${profileName}`);
  await assertSafePerfPaths({ databasePath, mediaDirectory });
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(path.dirname(databasePath), MARKER), json({ profileName, seed }), { flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    const marker = JSON.parse(await readFile(path.join(path.dirname(databasePath), MARKER), "utf8"));
    if (marker.profileName !== profileName || marker.seed !== seed) throw new Error("The temporary performance directory belongs to a different dataset.");
  });
  try { await stat(databasePath); throw new Error("The explicit performance database already exists; use a new temporary directory."); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  const startedAt = performance.now();
  const { db, schemaVersion } = await initializeDatabase(databasePath, migrationsDirectory);
  suspendMessageSearchIndex(db);
  const chatMessageCounts = distributeMessages(profile);
  const firstMessageByChat = new Map();
  try {
    const insertSettings = db.prepare('INSERT INTO "UserSettings" (id, activeProvider, apiBaseUrl, apiKey, model, temperature, maxTokens, topP, language, models, providers, activeProviderId, activeModelId, moduleModelPreferences, modelReliability, usageBudgets, usageTimezone, userPersonaPresets, userProfileSummary, autoSummarizeUser, showMessageAvatars, showMessageTimestamps, appearancePreferences, ttsVoice, ttsPlaybackRate, ttsAutoPlay, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertCharacter = db.prepare('INSERT INTO "Character" (id, cardId, name, avatar, description, prefix, prompt, suffix, htmlCss, openingHtml, tags, loreEntries, quickReplies, isFavorite, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertChat = db.prepare('INSERT INTO "Chat" (id, title, characterId, parentChatId, branchSourceMessageId, isCheckpoint, isPinned, isArchived, folder, deletedAt, backgroundUrl, memoryTurns, autoMemoryEnabled, memoryUpdatedAt, userPersona, userAvatar, userProfileSummary, userProfileUpdatedAt, profileRevision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMessage = db.prepare('INSERT INTO "Message" (id, chatId, role, characterId, content, contextIncluded, isBookmarked, variants, activeVariantIndex, tokenUsage, generationMetadata, variantMetadata, promptBreakdown, loreMatches, memoryMatches, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMemory = db.prepare('INSERT INTO "ChatMemory" (id, chatId, title, content, keywords, importance, enabled, deletedAt, currentRevision, lastActor, lastAction, sourceMessageIds, embedding, embeddingModel, embeddingSource, embeddingDimensions, embeddingStatus, embeddingUpdatedAt, lastMatchedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRevision = db.prepare('INSERT INTO "MemoryRevision" (id, memoryId, chatId, revision, action, actor, beforeSnapshot, afterSnapshot, sourceMessageIds, operationId, reasonCode, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertOperation = db.prepare('INSERT INTO "MemoryOperation" (id, chatId, type, actor, status, startedAt, completedAt, createdCount, updatedCount, disabledCount, unchangedCount, sourceMessageIds, errorCode, undoneAt, undoOperationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertProfileRevision = db.prepare('INSERT INTO "ProfileSummaryRevision" (id, chatId, revision, action, actor, summary, sourceMessageIds, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertAsset = db.prepare('INSERT INTO "MediaAsset" (id, contentHash, mimeType, byteSize, width, height, storageKey, data, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertAttachment = db.prepare('INSERT INTO "MessageAttachment" (id, messageId, draftId, assetId, sortOrder, originalFilename, createdAt) VALUES (?, ?, NULL, ?, 0, ?, ?)');
    const insertRequest = db.prepare('INSERT INTO "ModelRequest" (id, module, operation, chatId, messageId, status, activeAttemptId, outputStarted, errorCode, errorSummary, diagnosticId, overrideHardBudget, createdAt, startedAt, completedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 0, ?, ?, ?, ?)');
    const insertAttempt = db.prepare('INSERT INTO "ModelUsageAttempt" (id, requestId, attemptNumber, module, chatId, messageId, providerId, providerType, modelId, status, startedAt, completedAt, promptTokens, outputTokens, totalTokens, usageSource, inputPriceMicros, outputPriceMicros, estimatedCostMicros, currency, specialTokensUnknown, usedFallback, fallbackFromProviderId, fallbackFromModelId, errorCode, diagnosticId, reservedCostMicros, reservationDay, reservationMonth) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, 0, NULL, NULL)');
    const insertRecovery = db.prepare('INSERT INTO "RecoveryPoint" (id, reason, summary, snapshot, createdAt) VALUES (?, ?, ?, ?, ?)');

    runTransaction(db, () => {
      insertSettings.run("perf-settings", "openai-compatible", "http://127.0.0.1.invalid/v1", "mock-model", 0.8, 800, 1, "zh-CN", "[]", "[]", "", "", "{}", "{}", "{}", "UTC", "[]", "", 1, 1, 0, "{}", "alloy", 1, 0, dbTime(0), dbTime(0));
      for (let index = 0; index < profile.characters; index += 1) {
        const lore = [{ id: `lore-${index}`, keys: [index % 2 ? "keyword" : "关键词"], content: `Synthetic lore ${index}`, priority: index % 5, triggerMode: "both", alwaysActive: index % 13 === 0, enabled: true }];
        insertCharacter.run(padded("char", index), padded("card", index), `Synthetic Character ${String(index).padStart(4, "0")}`, `Local-only character ${index}`, `Prefix ${index}`, `Core prompt ${index}`, `Suffix ${index}`, index % 17 === 0 ? ".message { line-height: 1.6; }" : "", index % 19 === 0 ? `<p>Opening ${index}</p>` : "", json([`tag-${index % 12}`]), json(lore), json([]), index % 9 === 0 ? 1 : 0, dbTime(index, 4), dbTime(index, 4));
      }
    });

    let globalMessage = 0;
    runTransaction(db, () => {
      for (let chatIndex = 0; chatIndex < profile.chats; chatIndex += 1) {
        const chatId = padded("chat", chatIndex);
        const parentIndex = chatIndex > 0 && chatIndex % 41 === 0 ? chatIndex - 1 : null;
        const parentId = parentIndex === null ? null : padded("chat", parentIndex);
        const branchSource = parentIndex === null ? null : firstMessageByChat.get(parentId) ?? null;
        const created = dbTime(chatIndex, 3);
        const updated = dbTime(profile.messages + chatIndex, 2);
        insertChat.run(chatId, chatIndex === 0 ? "Synthetic 20k long chat" : `Synthetic Chat ${chatIndex}`, padded("char", chatIndex % profile.characters), parentId, branchSource, chatIndex > 0 && chatIndex % 83 === 0 ? 1 : 0, chatIndex > 0 && chatIndex % 23 === 0 ? 1 : 0, chatIndex > 0 && chatIndex % 29 === 0 ? 1 : 0, chatIndex % 5 === 0 ? `Folder ${chatIndex % 10}` : "", chatIndex > 0 && chatIndex % 37 === 0 ? updated : null, "", 12 + (chatIndex % 8), 1, null, chatIndex > 0 && chatIndex % 31 === 0 ? "Synthetic persona" : "", "", "", null, 0, created, updated);
        for (let localIndex = 0; localIndex < chatMessageCounts[chatIndex]; localIndex += 1) {
          const messageId = padded("msg", globalMessage);
          if (localIndex === 0) firstMessageByChat.set(chatId, messageId);
          const role = globalMessage % 2 === 0 ? "user" : "assistant";
          const variants = globalMessage % 11 === 0 ? [messageContent(globalMessage), `${messageContent(globalMessage)} variant`] : [];
          const createdAt = dbTime(globalMessage, 4);
          insertMessage.run(messageId, chatId, role, role === "assistant" ? padded("char", chatIndex % profile.characters) : null, globalMessage < profile.attachments && globalMessage % 5 === 0 ? "" : messageContent(globalMessage), globalMessage % 17 === 0 ? 0 : 1, globalMessage % 53 === 0 ? 1 : 0, json(variants), variants.length ? 1 : 0, null, role === "assistant" ? json({ providerId: "mock", providerType: "mock", modelId: "mock-model", requestId: `fixture-request-${globalMessage}`, attemptId: `fixture-attempt-${globalMessage}`, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, estimated: false }, usageSource: "provider", inputPriceMicros: 1, outputPriceMicros: 2, estimatedCostMicros: 1, currency: "USD", usedFallback: false, incomplete: globalMessage % 101 === 0 }) : null, json([]), null, null, null, createdAt, createdAt);
          globalMessage += 1;
        }
      }
    });
    rebuildMessageSearchIndex(db);

    runTransaction(db, () => {
      for (let index = 0; index < profile.mediaAssets; index += 1) {
        const bytes = deterministicPng(index + seed);
        const hash = createHash("sha256").update(bytes).digest("hex");
        insertAsset.run(padded("asset", index), hash, "image/png", bytes.length, 4, 4, `sha256:${hash}`, bytes, dbTime(index, 2));
      }
      for (let index = 0; index < profile.attachments; index += 1) {
        const messageIndex = Math.floor(index * profile.messages / profile.attachments);
        insertAttachment.run(padded("attachment", index), padded("msg", messageIndex), padded("asset", index % profile.mediaAssets), `fixture-${index % profile.mediaAssets}.png`, dbTime(index, 2));
      }
    });

    runTransaction(db, () => {
      for (let index = 0; index < profile.memories; index += 1) {
        const memoryId = padded("memory", index);
        const chatId = padded("chat", index % profile.chats);
        const deleted = index % 43 === 0;
        const enabled = index % 19 !== 0;
        const revisionCount = 1 + (index % 3);
        const timestamp = dbTime(index, 3);
        const source = firstMessageByChat.get(chatId) ? [firstMessageByChat.get(chatId)] : [];
        const embedding = index % 5 === 0 ? json([0.25, 0.5, 0.75, 1]) : null;
        insertMemory.run(memoryId, chatId, `Memory ${index}`, `Synthetic memory content ${index}`, json([index % 2 ? "keyword" : "关键词"]), 1 + index % 5, enabled ? 1 : 0, deleted ? timestamp : null, revisionCount, "user", deleted ? "manual_delete" : "manual_create", json(source), embedding, embedding ? "mock-embedding" : null, embedding ? "mock" : null, embedding ? 4 : null, embedding ? "ready" : "stale", embedding ? timestamp : null, null, timestamp, timestamp);
        for (let revision = 1; revision <= revisionCount; revision += 1) {
          const snapshot = json({ title: `Memory ${index}`, content: `Synthetic memory content ${index}`, keywords: ["keyword"], importance: 1 + index % 5, enabled: revision === revisionCount ? enabled : true, sourceMessageIds: source });
          insertRevision.run(`${memoryId}-r${revision}`, memoryId, chatId, revision, revision === 1 ? "manual_create" : deleted && revision === revisionCount ? "manual_delete" : "manual_edit", "user", revision === 1 ? null : snapshot, snapshot, json(source), null, "perf_fixture", dbTime(index * 3 + revision, 2));
        }
      }
      const operationCount = Math.max(1, Math.floor(profile.memories / 10));
      for (let index = 0; index < operationCount; index += 1) {
        const status = ["succeeded", "failed", "partial", "running"][index % 4];
        const timestamp = dbTime(index, 2);
        insertOperation.run(padded("operation", index), padded("chat", index % profile.chats), "automatic_maintenance", "automatic_memory", status, timestamp, status === "running" ? null : timestamp, 1, 1, 0, 2, "[]", status === "failed" ? "mock_failure" : null, null, null);
      }
      for (let index = 0; index < Math.max(1, Math.floor(profile.chats / 20)); index += 1) {
        insertProfileRevision.run(padded("profile-revision", index), padded("chat", index % profile.chats), 1, "baseline", "user", `Synthetic profile summary ${index}`, "[]", dbTime(index, 2));
      }
    });

    runTransaction(db, () => {
      const requestCount = Math.min(profile.chats, 1_000);
      const statuses = ["succeeded", "failed", "cancelled", "interrupted"];
      for (let index = 0; index < requestCount; index += 1) {
        const requestId = padded("request", index);
        const status = statuses[index % statuses.length];
        const chatId = padded("chat", index % profile.chats);
        const messageId = firstMessageByChat.get(chatId) ?? null;
        const timestamp = dbTime(index, 2);
        insertRequest.run(requestId, "chat", "reply", chatId, messageId, status, status === "succeeded" ? 1 : 0, status === "failed" ? "provider_unavailable" : null, `diag-${index}`, timestamp, timestamp, timestamp, timestamp);
        insertAttempt.run(`${requestId}-a1`, requestId, "chat", chatId, messageId, "mock", "mock", "mock-model", status === "succeeded" ? "succeeded" : status, timestamp, timestamp, 20, 10, 30, "mock", 1, 2, 1, "USD", status === "failed" ? "provider_unavailable" : null, `diag-${index}`);
      }
      const snapshot = json({ schemaVersion: 1, exportedAt: iso(0), settings: null, characters: [], chats: [], messages: [], memories: [], memoryRevisions: [], memoryOperations: [], profileSummaryRevisions: [], mode: "merge" });
      for (let index = 0; index < 5; index += 1) insertRecovery.run(padded("recovery", index), "perf_fixture", json({ settings: 0, characters: 0, chats: 0, messages: 0, memories: 0, memoryRevisions: 0, memoryOperations: 0, profileSummaryRevisions: 0, mediaAssets: 0, messageAttachments: 0 }), snapshot, dbTime(index));
    });

    db.exec("PRAGMA optimize");
    const counts = Object.fromEntries([
      ["characters", "Character"], ["chats", "Chat"], ["messages", "Message"], ["memories", "ChatMemory"], ["memoryRevisions", "MemoryRevision"], ["memoryOperations", "MemoryOperation"], ["mediaAssets", "MediaAsset"], ["attachments", "MessageAttachment"], ["modelRequests", "ModelRequest"], ["usageAttempts", "ModelUsageAttempt"], ["recoveryPoints", "RecoveryPoint"]
    ].map(([key, table]) => [key, Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)]));
    if (counts.characters !== profile.characters || counts.chats !== profile.chats || counts.messages !== profile.messages || counts.memories !== profile.memories || counts.mediaAssets !== profile.mediaAssets || counts.attachments !== profile.attachments) throw new Error(`Generated counts failed validation: ${json(counts)}`);
    const brokenReferences = Number(db.prepare("PRAGMA foreign_key_check").all().length);
    if (brokenReferences !== 0) throw new Error(`Generated dataset has ${brokenReferences} broken references.`);
    const metadata = { profileName, seed, schemaVersion, generatedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - startedAt) * 100) / 100, counts, brokenReferences, databaseBytes: Number(db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get().bytes) };
    await writeFile(path.join(mediaDirectory, "dataset.json"), `${json(metadata)}\n`);
    return metadata;
  } finally { db.close(); }
};

export const perfMarkerName = MARKER;
