import { createHash, randomUUID } from "node:crypto";
import { access, lstat, readdir, readFile, realpath, rm, stat, statfs } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { getAppInfo } from "./appInfo.js";
import { validateStoredImage } from "./imageNormalization.js";

type AppPlatform = "web" | "windows" | "android" | "server";
type StorageCleanupAction = "expired_drafts" | "orphan_media" | "clear_embeddings" | "expired_recovery_points" | "old_upgrade_recovery" | "usage_ledger" | "app_temp_cache" | "rebuild_database_indexes" | "vacuum_database";
type StorageCategoryDTO = { id: string; label: string; count: number | null; bytes: number | null; measurement: "exact" | "estimated" | "unavailable"; reclaimableBytes: number | null };
type StorageHealthIssueDTO = { code: string; severity: "info" | "warning" | "error"; category: string; message: string; count?: number; chatId?: string; messageId?: string; messageIndex?: number; repairAction?: StorageCleanupAction };
type StorageHealthSnapshotDTO = { generatedAt: string; platform: AppPlatform; databaseBytes: number | null; reclaimableDatabaseBytes: number | null; freeDiskBytes: number | null; categories: StorageCategoryDTO[]; issues: StorageHealthIssueDTO[]; overall: "healthy" | "attention" | "error"; capabilities: { deepScan: boolean; fileSystemInspection: boolean; upgradeRecoveryCleanup: boolean; appTempCleanup: boolean; vacuum: boolean }; activeDeepScanId: string | null };
type StorageDeepScanDTO = { id: string; state: "idle" | "running" | "completed" | "cancelled" | "failed"; startedAt: string; completedAt: string | null; progress: number; checkedItems: number; totalItems: number; issues: StorageHealthIssueDTO[]; errorCode: string | null };
type StorageCleanupPlanDTO = { id: string; createdAt: string; expiresAt: string; items: Array<{ action: StorageCleanupAction; count: number; estimatedBytes: number | null; supported: boolean; warning: string | null }>; fingerprint: string };
type StorageCleanupResultDTO = { planId: string; completedAt: string; items: Array<{ action: StorageCleanupAction; status: "completed" | "skipped" | "failed"; count: number; reclaimedBytes: number | null; errorCode: string | null }> };

const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_LIMIT = 10;
const UPGRADE_RECOVERY_LIMIT = 5;
const PLAN_TTL_MS = 5 * 60 * 1000;
const LOW_DISK_RESERVE_BYTES = 128 * 1024 * 1024;

type PlanRecord = StorageCleanupPlanDTO & { used: boolean };
type MutableDeepScan = StorageDeepScanDTO & { cancelled: boolean };

const plans = new Map<string, PlanRecord>();
const planEpochs = new Map<string, number>();
const scans = new Map<string, MutableDeepScan>();
let activeScanId: string | null = null;
let maintenanceBusy = false;
let maintenanceEpoch = 0;

const now = () => new Date().toISOString();
const platform = (): AppPlatform => {
  const value = process.env.STAR_COMPANION_PLATFORM;
  return value === "windows" || value === "android" || value === "web" ? value : "server";
};

const databasePath = () => {
  const value = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!value.startsWith("file:")) return null;
  const raw = decodeURIComponent(value.slice(5).split("?")[0]);
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(process.cwd(), "prisma", raw);
};

const privateRoot = () => {
  const configured = process.env.STAR_COMPANION_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dbPath = databasePath();
  return dbPath ? path.dirname(dbPath) : null;
};

const within = (root: string, candidate: string) => {
  const normalizedRoot = path.resolve(root).toLocaleLowerCase("en-US");
  const normalizedCandidate = path.resolve(candidate).toLocaleLowerCase("en-US");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
};

const estimateDataUrlBytes = (value: unknown) => {
  if (typeof value !== "string" || !value.startsWith("data:")) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const payload = value.slice(comma + 1);
  if (value.slice(0, comma).includes(";base64")) return Math.floor(payload.length * 0.75);
  try { return Buffer.byteLength(decodeURIComponent(payload)); } catch { return Buffer.byteLength(payload); }
};
const estimateNestedDataUrls = (value: unknown): number => {
  if (typeof value === "string") return estimateDataUrlBytes(value);
  if (Array.isArray(value)) return sum(value.map(estimateNestedDataUrls));
  if (value && typeof value === "object") return sum(Object.values(value).map(estimateNestedDataUrls));
  return 0;
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const issue = (code: string, severity: StorageHealthIssueDTO["severity"], category: string, message: string, extra: Partial<StorageHealthIssueDTO> = {}): StorageHealthIssueDTO => ({ code, severity, category, message, ...extra });
const category = (id: string, label: string, count: number | null, bytes: number | null, measurement: StorageCategoryDTO["measurement"], reclaimableBytes: number | null = null): StorageCategoryDTO => ({ id, label, count, bytes, measurement, reclaimableBytes });

const fileSize = async (candidate: string | null) => {
  if (!candidate) return null;
  try { return (await stat(candidate)).size; } catch { return null; }
};

const directoryInventory = async (name: "upgrade-recovery" | "temp" | "cache") => {
  const root = privateRoot();
  if (!root) return { count: 0, bytes: null as number | null, anomalies: 0, files: [] as Array<{ path: string; size: number; mtimeMs: number }> };
  const directory = path.resolve(root, name);
  if (!within(root, directory)) return { count: 0, bytes: null, anomalies: 1, files: [] };
  try {
    const rootReal = await realpath(root);
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return { count: 0, bytes: 0, anomalies: 1, files: [] };
    const directoryReal = await realpath(directory);
    if (!within(rootReal, directoryReal)) return { count: 0, bytes: 0, anomalies: 1, files: [] };
    const entries = await readdir(directory, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let anomalies = 0;
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (!within(directoryReal, candidate) || entry.isSymbolicLink() || !entry.isFile()) { anomalies += 1; continue; }
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) { anomalies += 1; continue; }
      files.push({ path: candidate, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }
    return { count: files.length, bytes: sum(files.map((entry) => entry.size)), anomalies, files };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, bytes: 0, anomalies: 0, files: [] };
    return { count: 0, bytes: null, anomalies: 1, files: [] };
  }
};

const oldUpgradeRecoveryFiles = async (inventory: Awaited<ReturnType<typeof directoryInventory>>) => {
  const byName = new Map(inventory.files.map((entry) => [path.basename(entry.path), entry]));
  const manifests: Array<{ createdAt: number; files: Array<{ path: string; size: number; mtimeMs: number }> }> = [];
  for (const entry of inventory.files) {
    const name = path.basename(entry.path);
    if (!/^[0-9TZ-]+-[a-f0-9]{8}\.json$/i.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(entry.path, "utf8")) as Record<string, unknown>;
      const stem = name.slice(0, -5);
      if (parsed.id !== stem || parsed.databaseFile !== `${stem}.db`) continue;
      const database = byName.get(`${stem}.db`);
      if (!database) continue;
      manifests.push({ createdAt: Date.parse(String(parsed.createdAt)) || entry.mtimeMs, files: [entry, database] });
    } catch { /* malformed metadata is quarantined and retained */ }
  }
  return manifests.sort((a, b) => b.createdAt - a.createdAt).slice(UPGRADE_RECOVERY_LIMIT).flatMap((entry) => entry.files);
};

const otherPrivateFiles = async () => {
  const configured = process.env.STAR_COMPANION_DATA_DIR?.trim();
  if (!configured) return { count: 0, bytes: null as number | null, anomalies: 0 };
  const root = path.resolve(configured);
  try {
    const rootReal = await realpath(root); let count = 0; let bytes = 0; let anomalies = 0;
    const knownDatabase = databasePath();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const candidate = path.resolve(root, entry.name);
      if (!within(rootReal, candidate) || entry.isSymbolicLink()) { anomalies += 1; continue; }
      if (!entry.isFile() || candidate === knownDatabase || candidate === `${knownDatabase}-wal` || candidate === `${knownDatabase}-shm`) continue;
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) { anomalies += 1; continue; }
      count += 1; bytes += metadata.size;
    }
    return { count, bytes, anomalies };
  } catch { return { count: 0, bytes: null, anomalies: 1 }; }
};

const databaseMetrics = async () => {
  try {
    const [page] = await prisma.$queryRawUnsafe<Array<{ page_count: bigint | number }>>("PRAGMA page_count");
    const [size] = await prisma.$queryRawUnsafe<Array<{ page_size: bigint | number }>>("PRAGMA page_size");
    const [free] = await prisma.$queryRawUnsafe<Array<{ freelist_count: bigint | number }>>("PRAGMA freelist_count");
    const pageSize = Number(size?.page_size ?? 0);
    return { bytes: Number(page?.page_count ?? 0) * pageSize, reclaimable: Number(free?.freelist_count ?? 0) * pageSize };
  } catch {
    return { bytes: await fileSize(databasePath()), reclaimable: null };
  }
};

const freeDiskBytes = async () => {
  const root = privateRoot();
  if (!root) return null;
  try { const value = await statfs(root); return Number(value.bavail) * Number(value.bsize); } catch { return null; }
};

const fastIssues = async (): Promise<StorageHealthIssueDTO[]> => {
  const issues: StorageHealthIssueDTO[] = [];
  try {
    const integrity = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("PRAGMA quick_check");
    if (integrity.length !== 1 || String(Object.values(integrity[0] ?? {})[0]).toLowerCase() !== "ok") issues.push(issue("database_quick_check_failed", "error", "database", "The local database quick check did not pass."));
  } catch { issues.push(issue("database_quick_check_unavailable", "warning", "database", "The local database quick check could not be completed.")); }
  try {
    const foreignKeys = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("PRAGMA foreign_key_check");
    if (foreignKeys.length) issues.push(issue("foreign_key_violation", "error", "database", "Some local records have broken database references.", { count: foreignKeys.length }));
  } catch { issues.push(issue("foreign_key_check_unavailable", "warning", "database", "Database reference checks are unavailable.")); }

  const [danglingMessages, danglingMemories, invalidAttachments, requestMismatches, expiredDrafts, staleRequests] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>('SELECT COUNT(*) AS count FROM "Message" m LEFT JOIN "Chat" c ON c.id=m.chatId WHERE c.id IS NULL'),
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>('SELECT COUNT(*) AS count FROM "ChatMemory" m LEFT JOIN "Chat" c ON c.id=m.chatId WHERE c.id IS NULL'),
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>('SELECT COUNT(*) AS count FROM "MessageAttachment" a LEFT JOIN "MediaAsset" m ON m.id=a.assetId WHERE m.id IS NULL OR (a.messageId IS NULL AND a.draftId IS NULL) OR (a.messageId IS NOT NULL AND a.draftId IS NOT NULL)'),
    prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>('SELECT COUNT(*) AS count FROM "ModelRequest" r LEFT JOIN "ModelUsageAttempt" a ON a.id=r.activeAttemptId WHERE (r.status IN (\'queued\', \'running\') AND r.activeAttemptId IS NOT NULL AND a.id IS NULL) OR (r.status NOT IN (\'queued\', \'running\') AND EXISTS (SELECT 1 FROM "ModelUsageAttempt" x WHERE x.requestId=r.id AND x.status=\'running\'))'),
    prisma.messageAttachment.count({ where: { messageId: null, draftId: { not: null }, createdAt: { lt: new Date(Date.now() - DRAFT_MAX_AGE_MS) } } }),
    prisma.modelRequest.count({ where: { status: { in: ["queued", "running"] }, updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } })
  ]);
  const addCount = (rows: Array<{ count: bigint | number }>, code: string, message: string, categoryId: string) => {
    const count = Number(rows[0]?.count ?? 0);
    if (count) issues.push(issue(code, "error", categoryId, message, { count }));
  };
  addCount(danglingMessages, "message_chat_reference_missing", "Some messages no longer refer to an available chat.", "core");
  addCount(danglingMemories, "memory_chat_reference_missing", "Some memories no longer refer to an available chat.", "memory");
  addCount(invalidAttachments, "attachment_reference_invalid", "Some image attachment references are incomplete.", "media");
  addCount(requestMismatches, "model_reservation_inconsistent", "Some active model reservations do not match their request lifecycle.", "usage");
  if (expiredDrafts) issues.push(issue("expired_drafts", "info", "media", "Expired unattached draft images can be removed.", { count: expiredDrafts, repairAction: "expired_drafts" }));
  if (staleRequests) issues.push(issue("stale_model_reservation", "warning", "usage", "Some model requests still appear active after an interruption.", { count: staleRequests }));

  const available = await freeDiskBytes();
  if (available !== null && available < LOW_DISK_RESERVE_BYTES) issues.push(issue("low_disk_space", "error", "filesystem", "Free space is critically low. Imports and image uploads are temporarily blocked."));
  const root = privateRoot();
  if (root) {
    try { await access(root, fsConstants.R_OK | fsConstants.W_OK); }
    catch { issues.push(issue("private_directory_not_writable", "error", "filesystem", "The application-private data directory is not readable and writable.")); }
  }
  const appInfo = getAppInfo();
  try {
    const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string; checksum: string }>>('SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1');
    if (applied[0]?.migration_name !== appInfo.schemaVersion || applied[0]?.checksum !== appInfo.schemaChecksum) issues.push(issue("migration_state_mismatch", "error", "database", "The database migration state does not match this application build."));
  } catch { issues.push(issue("migration_state_unavailable", "warning", "database", "Migration state could not be verified.")); }
  return issues;
};

export const getStorageHealthSnapshot = async (): Promise<StorageHealthSnapshotDTO> => {
  const [characters, chats, messages, memories, revisions, operations, profiles, assets, sentAttachments, draftAttachments, recoveryRefs, recoveryPoints, requests, attempts, db, disk, upgrade, temp, cache, otherFiles] = await Promise.all([
    prisma.character.findMany(),
    prisma.chat.findMany(),
    prisma.message.findMany(),
    prisma.chatMemory.findMany(),
    prisma.memoryRevision.findMany(), prisma.memoryOperation.findMany(), prisma.profileSummaryRevision.findMany(),
    prisma.mediaAsset.findMany({ select: { id: true, byteSize: true, attachments: { select: { id: true } }, recoveryPoints: { select: { recoveryPointId: true } } } }),
    prisma.messageAttachment.count({ where: { messageId: { not: null } } }), prisma.messageAttachment.count({ where: { messageId: null, draftId: { not: null } } }),
    prisma.recoveryPointMediaAsset.count(), prisma.recoveryPoint.findMany({ select: { summary: true, snapshot: true, createdAt: true } }),
    prisma.modelRequest.findMany(), prisma.modelUsageAttempt.findMany(), databaseMetrics(), freeDiskBytes(), directoryInventory("upgrade-recovery"), directoryInventory("temp"), directoryInventory("cache"), otherPrivateFiles()
  ]);
  const settings = await prisma.userSettings.findFirst({ select: { userPersonaPresets: true } });
  const characterImageBytes = sum(characters.map((item) => estimateDataUrlBytes(item.avatar)));
  const backgroundImageBytes = sum(chats.map((item) => estimateDataUrlBytes(item.backgroundUrl)));
  const chatPersonaImageBytes = sum(chats.map((item) => estimateDataUrlBytes(item.userAvatar)));
  const personaImageBytes = chatPersonaImageBytes + estimateNestedDataUrls(settings?.userPersonaPresets);
  const coreBytes = Math.max(0, jsonBytes(characters) + jsonBytes(chats) + jsonBytes(messages) - characterImageBytes - backgroundImageBytes - chatPersonaImageBytes);
  const currentMemoryBytes = jsonBytes(memories.map(({ embedding: _embedding, ...item }) => item));
  const revisionBytes = jsonBytes(revisions);
  const operationBytes = jsonBytes(operations);
  const profileBytes = jsonBytes(profiles);
  const embeddingBytes = sum(memories.map((item) => jsonBytes(item.embedding)));
  const orphanAssets = assets.filter((item) => item.attachments.length === 0 && item.recoveryPoints.length === 0);
  const mediaBytes = sum(assets.map((item) => item.byteSize));
  const recoveryBytes = sum(recoveryPoints.map((item) => jsonBytes(item.summary) + jsonBytes(item.snapshot)));
  const tombstones = memories.filter((item) => item.deletedAt).length;
  const trash = chats.filter((item) => item.deletedAt).length;
  const categories = [
    category("database", "SQLite database", 1, db.bytes, db.bytes === null ? "unavailable" : "exact", db.reclaimable),
    category("core", "Characters, chats and messages", characters.length + chats.length + messages.length, coreBytes, "estimated"),
    category("memory_current", "Current long-term memories", memories.length, currentMemoryBytes, "estimated"),
    category("memory_revisions", "Memory revisions", revisions.length, revisionBytes, "estimated"),
    category("memory_operations", "Memory operations", operations.length, operationBytes, "estimated"),
    category("profile_revisions", "Profile summary revisions", profiles.length, profileBytes, "estimated"),
    category("media", "Chat image media", assets.length, mediaBytes, "exact", sum(orphanAssets.map((item) => item.byteSize))),
    category("media_sent", "Sent image references", sentAttachments, null, "unavailable"),
    category("media_drafts", "Draft image references", draftAttachments, null, "unavailable"),
    category("media_recovery_refs", "Recovery-point media references", recoveryRefs, null, "unavailable"),
    category("media_orphans", "Unreferenced media assets", orphanAssets.length, sum(orphanAssets.map((item) => item.byteSize)), "exact", sum(orphanAssets.map((item) => item.byteSize))),
    category("character_images", "Local character images", null, characterImageBytes, "estimated"),
    category("persona_images", "Local persona images", null, personaImageBytes, "estimated"),
    category("background_images", "Local chat backgrounds", null, backgroundImageBytes, "estimated"),
    category("embeddings", "Memory embeddings and indexes", memories.filter((item) => item.embedding !== null).length, embeddingBytes, "estimated", embeddingBytes),
    category("recovery_points", "Local recovery points", recoveryPoints.length, recoveryBytes, "estimated"),
    category("upgrade_recovery", "Upgrade recovery copies", upgrade.count, upgrade.bytes, upgrade.bytes === null ? "unavailable" : "exact"),
    category("trash", "Chat trash and memory tombstones", trash + tombstones, null, "unavailable"),
    category("usage", "Model request and usage ledger", requests.length + attempts.length, jsonBytes(requests) + jsonBytes(attempts), "estimated"),
    category("temp_cache", "Application temporary files and cache", temp.count + cache.count, temp.bytes === null || cache.bytes === null ? null : temp.bytes + cache.bytes, temp.bytes === null || cache.bytes === null ? "unavailable" : "exact"),
    category("other_private_files", "Other application-private files", otherFiles.count, otherFiles.bytes, otherFiles.bytes === null ? "unavailable" : "exact")
  ];
  const issues = await fastIssues();
  if (orphanAssets.length) issues.push(issue("orphan_media", "info", "media", "Unreferenced image assets can be safely removed.", { count: orphanAssets.length, repairAction: "orphan_media" }));
  if (upgrade.anomalies + temp.anomalies + cache.anomalies + otherFiles.anomalies) issues.push(issue("private_directory_anomaly", "warning", "filesystem", "Unexpected or linked entries were found in an application-private directory and were left untouched.", { count: upgrade.anomalies + temp.anomalies + cache.anomalies + otherFiles.anomalies }));
  return {
    generatedAt: now(), platform: platform(), databaseBytes: db.bytes, reclaimableDatabaseBytes: db.reclaimable, freeDiskBytes: disk, categories, issues,
    overall: issues.some((entry) => entry.severity === "error") ? "error" : issues.some((entry) => entry.severity === "warning") ? "attention" : "healthy",
    capabilities: { deepScan: true, fileSystemInspection: true, upgradeRecoveryCleanup: true, appTempCleanup: true, vacuum: true },
    activeDeepScanId: activeScanId
  };
};

const scanDeep = async (scan: MutableDeepScan) => {
  try {
    const [assets, memories, recoveryPoints, revisions] = await Promise.all([
      prisma.mediaAsset.findMany({ include: { attachments: true, recoveryPoints: true } }),
      prisma.chatMemory.findMany({ select: { id: true, chatId: true, embedding: true, embeddingDimensions: true, embeddingStatus: true, currentRevision: true } }),
      prisma.recoveryPoint.findMany({ select: { id: true, createdAt: true, snapshot: true }, orderBy: { createdAt: "desc" } }),
      prisma.memoryRevision.findMany({ select: { memoryId: true, revision: true } })
    ]);
    scan.totalItems = assets.length + memories.length + recoveryPoints.length + revisions.length + 1;
    const advance = async () => { scan.checkedItems += 1; scan.progress = Math.min(100, Math.round(scan.checkedItems / Math.max(1, scan.totalItems) * 100)); if (scan.cancelled) throw new HttpError(499, "Scan cancelled."); await new Promise<void>((resolve) => setImmediate(resolve)); };
    const fullIntegrity = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("PRAGMA integrity_check");
    if (fullIntegrity.length !== 1 || String(Object.values(fullIntegrity[0] ?? {})[0]).toLowerCase() !== "ok") scan.issues.push(issue("database_integrity_failed", "error", "database", "The full SQLite integrity check did not pass."));
    await advance();
    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='index'");
    const indexNames = new Set(indexes.map((entry) => entry.name));
    for (const expected of ["Chat_characterId_idx", "Message_chatId_createdAt_idx", "MessageAttachment_assetId_idx", "RecoveryPoint_createdAt_idx", "ModelRequest_status_updatedAt_idx"]) {
      if (!indexNames.has(expected)) scan.issues.push(issue("database_index_missing", "error", "database", "A required database index is missing. No data was changed; review migration health before maintenance.", { count: 1 }));
    }
    const hashes = new Map<string, number>();
    for (const asset of assets) {
      const bytes = Buffer.from(asset.data);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const attachment = asset.attachments.find((entry) => entry.messageId);
      const location = attachment?.messageId ? await prisma.message.findUnique({ where: { id: attachment.messageId }, select: { chatId: true, createdAt: true } }) : null;
      const messageIndex = location ? await prisma.message.count({ where: { chatId: location.chatId, createdAt: { lt: location.createdAt } } }) : null;
      const link = attachment?.messageId && location ? { messageId: attachment.messageId, chatId: location.chatId, messageIndex: messageIndex ?? 0 } : {};
      if (bytes.length !== asset.byteSize || digest !== asset.contentHash) scan.issues.push(issue("media_integrity_mismatch", "error", "media", "An image asset failed its stored length or integrity check. The attachment remains represented as unavailable.", { count: 1, ...link }));
      else {
        try { validateStoredImage({ data: bytes, mimeType: asset.mimeType as "image/png" | "image/jpeg", width: asset.width, height: asset.height }); }
        catch { scan.issues.push(issue("media_decode_failed", "error", "media", "An image asset cannot be decoded with its stored metadata. The attachment remains represented as unavailable.", { count: 1, ...link })); }
      }
      hashes.set(asset.contentHash, (hashes.get(asset.contentHash) ?? 0) + 1);
      if (!asset.attachments.length && !asset.recoveryPoints.length) scan.issues.push(issue("orphan_media", "info", "media", "An unreferenced image asset can be removed.", { count: 1, repairAction: "orphan_media" }));
      await advance();
    }
    if ([...hashes.values()].some((count) => count > 1)) scan.issues.push(issue("duplicate_media_hash", "warning", "media", "Duplicate image content records were found; no referenced image was changed."));
    const revisionMax = new Map<string, number>();
    for (const revision of revisions) { revisionMax.set(revision.memoryId, Math.max(revisionMax.get(revision.memoryId) ?? 0, revision.revision)); await advance(); }
    for (const memory of memories) {
      const embedding = Array.isArray(memory.embedding) ? memory.embedding : null;
      if (embedding && (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value)) || (memory.embeddingDimensions !== null && embedding.length !== memory.embeddingDimensions))) scan.issues.push(issue("embedding_invalid", "warning", "embeddings", "A memory embedding has invalid dimensions or values and can be rebuilt.", { count: 1, repairAction: "clear_embeddings" }));
      if ((revisionMax.get(memory.id) ?? 0) > memory.currentRevision) scan.issues.push(issue("memory_revision_pointer_behind", "error", "memory", "A memory revision pointer is not monotonic.", { count: 1 }));
      await advance();
    }
    for (const [index, point] of recoveryPoints.entries()) {
      const snapshot = point.snapshot && typeof point.snapshot === "object" && !Array.isArray(point.snapshot) ? point.snapshot as Record<string, unknown> : null;
      if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.characters) || !Array.isArray(snapshot.chats) || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.memories)) scan.issues.push(issue("recovery_snapshot_invalid", "error", "recovery_points", "A recovery point snapshot is unreadable and was not modified.", { count: 1 }));
      if (index >= RECOVERY_LIMIT || point.createdAt.getTime() < Date.now() - RECOVERY_MAX_AGE_MS) scan.issues.push(issue("expired_recovery_point", "info", "recovery_points", "A recovery point is outside the retention policy and can be removed.", { count: 1, repairAction: "expired_recovery_points" }));
      await advance();
    }
    const directories = await Promise.all([directoryInventory("upgrade-recovery"), directoryInventory("temp"), directoryInventory("cache")]);
    const anomalies = sum(directories.map((entry) => entry.anomalies));
    if (anomalies) scan.issues.push(issue("private_directory_anomaly", "warning", "filesystem", "Unexpected or linked entries were quarantined from automated cleanup.", { count: anomalies }));
    scan.progress = 100; scan.state = "completed"; scan.completedAt = now();
  } catch {
    scan.state = scan.cancelled ? "cancelled" : "failed";
    scan.errorCode = scan.cancelled ? "scan_cancelled" : "scan_failed";
    scan.completedAt = now();
  } finally {
    if (activeScanId === scan.id) activeScanId = null;
    maintenanceBusy = false;
  }
};

export const startStorageDeepScan = (): StorageDeepScanDTO => {
  if (maintenanceBusy || activeScanId) throw new HttpError(409, "Storage maintenance is busy. Wait for the current operation to finish.");
  for (const [id, scan] of scans) if (scan.completedAt && Date.parse(scan.completedAt) < Date.now() - 60 * 60 * 1000) scans.delete(id);
  maintenanceBusy = true;
  maintenanceEpoch += 1;
  const scan: MutableDeepScan = { id: randomUUID(), state: "running", startedAt: now(), completedAt: null, progress: 0, checkedItems: 0, totalItems: 0, issues: [], errorCode: null, cancelled: false };
  scans.set(scan.id, scan); activeScanId = scan.id; void scanDeep(scan);
  const { cancelled: _cancelled, ...dto } = scan;
  return dto;
};

export const getStorageDeepScan = (id: string): StorageDeepScanDTO => {
  const scan = scans.get(id); if (!scan) throw new HttpError(404, "Storage scan not found."); const { cancelled: _cancelled, ...dto } = scan; return dto;
};
export const cancelStorageDeepScan = (id: string) => { const scan = scans.get(id); if (!scan) throw new HttpError(404, "Storage scan not found."); if (scan.state === "running") scan.cancelled = true; const { cancelled: _cancelled, ...dto } = scan; return dto; };
export const cancelActiveStorageScan = () => { if (activeScanId) { const scan = scans.get(activeScanId); if (scan) scan.cancelled = true; } };

export const registerStorageMutation = () => {
  if (maintenanceBusy) throw new HttpError(409, "Storage maintenance is busy. Try this write again after it finishes.");
  maintenanceEpoch += 1;
};

const cleanupCandidates = async () => {
  const cutoff = new Date(Date.now() - DRAFT_MAX_AGE_MS);
  const recovery = await prisma.recoveryPoint.findMany({ select: { id: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  const staleRecoveryIds = recovery.filter((entry, index) => index >= RECOVERY_LIMIT || entry.createdAt.getTime() < Date.now() - RECOVERY_MAX_AGE_MS).map((entry) => entry.id);
  const [drafts, orphans, embeddings, attempts, terminalRequests, activeRequests, upgrade, temp, cache, db, databaseState] = await Promise.all([
    prisma.messageAttachment.findMany({ where: { messageId: null, draftId: { not: null }, createdAt: { lt: cutoff } }, include: { asset: true } }),
    prisma.mediaAsset.findMany({ where: { attachments: { none: {} }, recoveryPoints: { none: {} } }, select: { id: true, byteSize: true } }),
    prisma.chatMemory.findMany({ where: { embedding: { not: Prisma.AnyNull } }, select: { id: true, embedding: true } }),
    prisma.modelUsageAttempt.count(), prisma.modelRequest.count({ where: { status: { in: ["succeeded", "failed", "cancelled", "interrupted", "blocked"] } } }), prisma.modelRequest.count({ where: { status: { in: ["queued", "running"] } } }),
    directoryInventory("upgrade-recovery"), directoryInventory("temp"), directoryInventory("cache"), databaseMetrics(),
    prisma.$queryRawUnsafe<Array<Record<string, bigint | number | string | null>>>('SELECT (SELECT COUNT(*) FROM "Character") AS characters, (SELECT COUNT(*) FROM "Chat") AS chats, (SELECT COUNT(*) FROM "Message") AS messages, (SELECT COUNT(*) FROM "ChatMemory") AS memories, (SELECT COUNT(*) FROM "MessageAttachment") AS attachments, (SELECT COUNT(*) FROM "MediaAsset") AS assets, (SELECT COUNT(*) FROM "RecoveryPoint") AS recoveryPoints, (SELECT COUNT(*) FROM "ModelRequest") AS requests, (SELECT COUNT(*) FROM "ModelUsageAttempt") AS attempts, (SELECT MAX(updatedAt) FROM "UserSettings") AS latestSettings, (SELECT MAX(updatedAt) FROM "Character") AS latestCharacter, (SELECT MAX(updatedAt) FROM "Chat") AS latestChat, (SELECT MAX(updatedAt) FROM "Message") AS latestMessage, (SELECT MAX(updatedAt) FROM "ChatMemory") AS latestMemory, (SELECT MAX(updatedAt) FROM "ModelRequest") AS latestRequest, (SELECT MAX(completedAt) FROM "ModelUsageAttempt") AS latestAttempt, (SELECT COALESCE(SUM(reservedCostMicros),0) FROM "ModelUsageAttempt") AS reservations')
  ]);
  const oldUpgrade = await oldUpgradeRecoveryFiles(upgrade);
  return {
    expired_drafts: { count: drafts.length, bytes: sum(drafts.map((entry) => entry.asset.byteSize)) },
    orphan_media: { count: orphans.length, bytes: sum(orphans.map((entry) => entry.byteSize)) },
    clear_embeddings: { count: embeddings.length, bytes: sum(embeddings.map((entry) => jsonBytes(entry.embedding))) },
    expired_recovery_points: { count: staleRecoveryIds.length, bytes: null },
    old_upgrade_recovery: { count: oldUpgrade.length, bytes: sum(oldUpgrade.map((entry) => entry.size)) },
    usage_ledger: { count: attempts + terminalRequests, bytes: null, activeRequests },
    app_temp_cache: { count: temp.count + cache.count, bytes: temp.bytes === null || cache.bytes === null ? null : temp.bytes + cache.bytes },
    rebuild_database_indexes: { count: 1, bytes: null },
    vacuum_database: { count: db.reclaimable ? 1 : 0, bytes: db.reclaimable },
    staleRecoveryIds, oldUpgrade, stateVersion: Object.fromEntries(Object.entries(databaseState[0] ?? {}).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]))
  };
};

const fingerprintCandidates = (value: Awaited<ReturnType<typeof cleanupCandidates>>, actions: StorageCleanupAction[]) => createHash("sha256").update(JSON.stringify({ stateVersion: value.stateVersion, actions: actions.map((action) => [action, value[action]]) })).digest("hex");

export const createStorageCleanupPlan = async (actions: StorageCleanupAction[]): Promise<StorageCleanupPlanDTO> => {
  if (maintenanceBusy) throw new HttpError(409, "Storage maintenance is busy. Wait for the current operation to finish.");
  for (const [id, plan] of plans) if (plan.used || Date.parse(plan.expiresAt) <= Date.now()) { plans.delete(id); planEpochs.delete(id); }
  const candidates = await cleanupCandidates();
  const createdAt = now();
  const plan: PlanRecord = {
    id: randomUUID(), createdAt, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(), fingerprint: fingerprintCandidates(candidates, actions), used: false,
    items: actions.map((action) => ({
      action, count: candidates[action].count, estimatedBytes: candidates[action].bytes, supported: true,
      warning: action === "vacuum_database" ? "VACUUM needs exclusive database access and may temporarily require additional free space." : action === "usage_ledger" && candidates.usage_ledger.activeRequests ? "Active requests are always retained." : null
    }))
  };
  plans.set(plan.id, plan);
  planEpochs.set(plan.id, maintenanceEpoch);
  const { used: _used, ...dto } = plan;
  return dto;
};

const removeControlledFiles = async (files: Array<{ path: string }>, expectedDirectory: string) => {
  const root = privateRoot(); if (!root) return 0;
  const directory = path.resolve(root, expectedDirectory); let removed = 0;
  for (const entry of files) {
    if (!within(directory, entry.path)) continue;
    try { const metadata = await lstat(entry.path); if (metadata.isFile() && !metadata.isSymbolicLink()) { await rm(entry.path); removed += 1; } } catch { /* changed targets are skipped */ }
  }
  return removed;
};

export const executeStorageCleanupPlan = async (id: string): Promise<StorageCleanupResultDTO> => {
  const plan = plans.get(id);
  if (!plan) throw new HttpError(404, "Storage cleanup plan not found.");
  if (plan.used) throw new HttpError(409, "This cleanup plan has already been used.");
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new HttpError(410, "This cleanup plan expired. Create a new preview.");
  if (planEpochs.get(id) !== maintenanceEpoch) throw new HttpError(409, "Storage maintenance ran after this preview. Create a new cleanup plan.");
  if (maintenanceBusy) throw new HttpError(409, "Storage maintenance is busy. Wait for the current operation to finish.");
  const before = await cleanupCandidates();
  if (fingerprintCandidates(before, plan.items.map((item) => item.action)) !== plan.fingerprint) throw new HttpError(409, "Storage changed after the preview. Create a new cleanup plan.");
  plan.used = true; maintenanceBusy = true; maintenanceEpoch += 1;
  const items: StorageCleanupResultDTO["items"] = [];
  for (const item of plan.items) {
    try {
      if (forcedCleanupFailureForTests === item.action) throw new Error("Injected cleanup failure");
      let count = 0;
      if (item.action === "expired_drafts") count = await prisma.$transaction(async (tx) => { const removed = await tx.messageAttachment.deleteMany({ where: { messageId: null, draftId: { not: null }, createdAt: { lt: new Date(Date.now() - DRAFT_MAX_AGE_MS) } } }); await tx.mediaAsset.deleteMany({ where: { attachments: { none: {} }, recoveryPoints: { none: {} } } }); return removed.count; });
      else if (item.action === "orphan_media") count = (await prisma.mediaAsset.deleteMany({ where: { attachments: { none: {} }, recoveryPoints: { none: {} } } })).count;
      else if (item.action === "clear_embeddings") count = (await prisma.chatMemory.updateMany({ where: { embedding: { not: Prisma.AnyNull } }, data: { embedding: Prisma.JsonNull, embeddingModel: null, embeddingSource: null, embeddingDimensions: null, embeddingStatus: "stale", embeddingUpdatedAt: null } })).count;
      else if (item.action === "expired_recovery_points") count = (await prisma.recoveryPoint.deleteMany({ where: { id: { in: before.staleRecoveryIds } } })).count;
      else if (item.action === "usage_ledger") count = await prisma.$transaction(async (tx) => { const attempts = await tx.modelUsageAttempt.deleteMany({ where: { request: { status: { notIn: ["queued", "running"] } } } }); const requests = await tx.modelRequest.deleteMany({ where: { status: { in: ["succeeded", "failed", "cancelled", "interrupted", "blocked"] } } }); return attempts.count + requests.count; });
      else if (item.action === "old_upgrade_recovery") count = await removeControlledFiles(before.oldUpgrade, "upgrade-recovery");
      else if (item.action === "app_temp_cache") { const [temp, cache] = await Promise.all([directoryInventory("temp"), directoryInventory("cache")]); count = await removeControlledFiles(temp.files, "temp") + await removeControlledFiles(cache.files, "cache"); }
      else if (item.action === "rebuild_database_indexes") { await prisma.$executeRawUnsafe("REINDEX"); count = 1; }
      else if (item.action === "vacuum_database") { if ((await freeDiskBytes()) !== null && (await freeDiskBytes())! < (before.vacuum_database.bytes ?? 0) + LOW_DISK_RESERVE_BYTES) throw new HttpError(409, "Not enough free space to run VACUUM safely."); await prisma.$executeRawUnsafe("VACUUM"); count = 1; }
      items.push({ action: item.action, status: count || item.count === 0 ? "completed" : "skipped", count, reclaimedBytes: item.estimatedBytes, errorCode: null });
    } catch { items.push({ action: item.action, status: "failed", count: 0, reclaimedBytes: null, errorCode: "cleanup_action_failed" }); }
  }
  maintenanceBusy = false;
  return { planId: id, completedAt: now(), items };
};

export const assertStorageCapacity = async (incomingBytes: number) => {
  const free = await freeDiskBytes();
  if (free !== null && free - Math.max(0, incomingBytes) < LOW_DISK_RESERVE_BYTES) throw new HttpError(507, "Free space is too low for this operation. Export diagnostics or remove data before trying again.");
};

/** Test-only clock hook; plans are otherwise opaque and server-owned. */
export const expireStorageCleanupPlanForTests = (id: string) => {
  const plan = plans.get(id);
  if (plan) plan.expiresAt = new Date(0).toISOString();
};

let forcedCleanupFailureForTests: StorageCleanupAction | null = null;
/** Test-only fault injection used to verify that one failed action does not hide successful actions. */
export const forceStorageCleanupFailureForTests = (action: StorageCleanupAction | null) => {
  forcedCleanupFailureForTests = action;
};
