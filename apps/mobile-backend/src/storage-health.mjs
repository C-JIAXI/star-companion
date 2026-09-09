import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";

const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_TTL_MS = 5 * 60 * 1000;
const LOW_DISK_RESERVE_BYTES = 128 * 1024 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value ?? null));
const sum = (values) => values.reduce((total, value) => total + value, 0);

export const createMobileStorageHealth = ({ store, dataDir, validateStoredImage }) => {
  const plans = new Map();
  const planEpochs = new Map();
  const scans = new Map();
  let activeScanId = null;
  let busy = false;
  let maintenanceEpoch = 0;
  const root = path.resolve(dataDir);
  const within = (candidate) => {
    const expected = root.toLocaleLowerCase("en-US");
    const value = path.resolve(candidate).toLocaleLowerCase("en-US");
    return value === expected || value.startsWith(`${expected}${path.sep}`);
  };
  const directory = async (name) => {
    const target = path.resolve(root, name);
    if (!within(target)) return { count: 0, bytes: null, anomalies: 1, files: [] };
    try {
      const rootReal = await realpath(root);
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) return { count: 0, bytes: 0, anomalies: 1, files: [] };
      const targetReal = await realpath(target);
      if (!targetReal.toLocaleLowerCase("en-US").startsWith(rootReal.toLocaleLowerCase("en-US"))) return { count: 0, bytes: 0, anomalies: 1, files: [] };
      const files = []; let anomalies = 0;
      for (const entry of await readdir(target, { withFileTypes: true })) {
        const file = path.resolve(target, entry.name);
        if (!within(file) || entry.isSymbolicLink() || !entry.isFile()) { anomalies += 1; continue; }
        const metadata = await lstat(file);
        if (metadata.isFile() && !metadata.isSymbolicLink()) files.push({ path: file, size: metadata.size }); else anomalies += 1;
      }
      return { count: files.length, bytes: sum(files.map((entry) => entry.size)), anomalies, files };
    } catch (error) { return error?.code === "ENOENT" ? { count: 0, bytes: 0, anomalies: 0, files: [] } : { count: 0, bytes: null, anomalies: 1, files: [] }; }
  };
  const freeDisk = async () => { try { const value = await statfs(root); return Number(value.bavail) * Number(value.bsize); } catch { return null; } };
  const dbBytes = async () => { try { return (await stat(store.filePath)).size; } catch { return null; } };
  const records = (type) => store.readRecords(type);
  const issue = (code, severity, category, message, extra = {}) => ({ code, severity, category, message, ...extra });

  const summary = async () => {
    const localDrafts = store.select("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(json_extract(data, '$.content') AS BLOB)) + length(CAST(json_extract(data, '$.attachments') AS BLOB))), 0) AS bytes FROM records WHERE type IN ('chatDraft', 'draftHandoff')")[0];
    const characters = records("character"); const chats = records("chat"); const messages = records("message"); const memories = records("memory");
    const revisions = records("memoryRevision"); const operations = records("memoryOperation"); const profiles = records("profileSummaryRevision");
    const assets = records("mediaAsset"); const attachments = records("messageAttachment"); const recovery = records("recoveryPoint"); const recoveryRefs = records("recoveryPointMediaAsset");
    const requests = records("modelRequest"); const attempts = records("usageAttempt");
    const [databaseBytes, disk, temp, cache] = await Promise.all([dbBytes(), freeDisk(), directory("temp"), directory("cache")]);
    const expiredDrafts = attachments.filter((entry) => entry.draftId && !entry.messageId && Date.parse(entry.createdAt) < Date.now() - DRAFT_MAX_AGE_MS);
    const referenced = new Set([...attachments.map((entry) => entry.assetId), ...recoveryRefs.map((entry) => entry.assetId)]);
    const orphans = assets.filter((entry) => !referenced.has(entry.id));
    const dataUrlBytes = (value) => typeof value === "string" && value.startsWith("data:") ? Math.floor((value.split(",")[1]?.length ?? 0) * 0.75) : 0;
    const nestedDataUrls = (value) => typeof value === "string" ? dataUrlBytes(value) : Array.isArray(value) ? sum(value.map(nestedDataUrls)) : value && typeof value === "object" ? sum(Object.values(value).map(nestedDataUrls)) : 0;
    const characterImageBytes = sum(characters.map((entry) => dataUrlBytes(entry.avatar)));
    const personaImageBytes = sum(chats.map((entry) => dataUrlBytes(entry.userAvatar))) + nestedDataUrls(store.getSettings().userPersonaPresets);
    const backgroundImageBytes = sum(chats.map((entry) => dataUrlBytes(entry.backgroundUrl)));
    const categories = [
      { id: "database", label: "Mobile SQLite database", count: 1, bytes: databaseBytes, measurement: databaseBytes === null ? "unavailable" : "exact", reclaimableBytes: null },
      { id: "core", label: "Characters, chats and messages", count: characters.length + chats.length + messages.length, bytes: bytesOf([...characters, ...chats, ...messages]), measurement: "estimated", reclaimableBytes: null },
      { id: "memory_current", label: "Current long-term memories", count: memories.length, bytes: bytesOf(memories.map(({ embedding: _embedding, ...entry }) => entry)), measurement: "estimated", reclaimableBytes: null },
      { id: "memory_revisions", label: "Memory revisions", count: revisions.length, bytes: bytesOf(revisions), measurement: "estimated", reclaimableBytes: null },
      { id: "memory_operations", label: "Memory operations", count: operations.length, bytes: bytesOf(operations), measurement: "estimated", reclaimableBytes: null },
      { id: "profile_revisions", label: "Profile summary revisions", count: profiles.length, bytes: bytesOf(profiles), measurement: "estimated", reclaimableBytes: null },
      { id: "media", label: "Chat image media", count: assets.length, bytes: sum(assets.map((entry) => entry.byteSize ?? 0)), measurement: "exact", reclaimableBytes: sum(orphans.map((entry) => entry.byteSize ?? 0)) },
      { id: "media_sent", label: "Sent image references", count: attachments.filter((entry) => entry.messageId).length, bytes: null, measurement: "unavailable", reclaimableBytes: null },
      { id: "media_drafts", label: "Draft image references", count: attachments.filter((entry) => entry.draftId && !entry.messageId).length, bytes: null, measurement: "unavailable", reclaimableBytes: null },
      { id: "chat_drafts", label: "Local drafts and send receipts", count: Number(localDrafts.count), bytes: Number(localDrafts.bytes), measurement: "estimated", reclaimableBytes: null },
      { id: "media_recovery_refs", label: "Recovery-point media references", count: recoveryRefs.length, bytes: null, measurement: "unavailable", reclaimableBytes: null },
      { id: "media_orphans", label: "Unreferenced media assets", count: orphans.length, bytes: sum(orphans.map((entry) => entry.byteSize ?? 0)), measurement: "exact", reclaimableBytes: sum(orphans.map((entry) => entry.byteSize ?? 0)) },
      { id: "character_images", label: "Local character images", count: null, bytes: characterImageBytes, measurement: "estimated", reclaimableBytes: null },
      { id: "persona_images", label: "Local persona images", count: null, bytes: personaImageBytes, measurement: "estimated", reclaimableBytes: null },
      { id: "background_images", label: "Local chat backgrounds", count: null, bytes: backgroundImageBytes, measurement: "estimated", reclaimableBytes: null },
      { id: "embeddings", label: "Memory embeddings and indexes", count: memories.filter((entry) => Array.isArray(entry.embedding)).length, bytes: bytesOf(memories.map((entry) => entry.embedding)), measurement: "estimated", reclaimableBytes: bytesOf(memories.map((entry) => entry.embedding)) },
      { id: "recovery_points", label: "Local recovery points", count: recovery.length, bytes: bytesOf(recovery), measurement: "estimated", reclaimableBytes: null },
      { id: "upgrade_recovery", label: "Upgrade recovery copies", count: 0, bytes: null, measurement: "unavailable", reclaimableBytes: null },
      { id: "trash", label: "Chat trash and memory tombstones", count: chats.filter((entry) => entry.deletedAt).length + memories.filter((entry) => entry.deletedAt).length, bytes: null, measurement: "unavailable", reclaimableBytes: null },
      { id: "usage", label: "Model request and usage ledger", count: requests.length + attempts.length, bytes: bytesOf([...requests, ...attempts]), measurement: "estimated", reclaimableBytes: null },
      { id: "temp_cache", label: "Application temporary files and cache", count: temp.count + cache.count, bytes: temp.bytes === null || cache.bytes === null ? null : temp.bytes + cache.bytes, measurement: temp.bytes === null || cache.bytes === null ? "unavailable" : "exact", reclaimableBytes: null },
      { id: "other_private_files", label: "Other application-private files", count: null, bytes: null, measurement: "unavailable", reclaimableBytes: null }
    ];
    const issues = [];
    try { const check = store.select("PRAGMA quick_check"); if (check.length !== 1 || String(Object.values(check[0])[0]).toLowerCase() !== "ok") issues.push(issue("database_quick_check_failed", "error", "database", "The local database quick check did not pass.")); } catch { issues.push(issue("database_quick_check_unavailable", "warning", "database", "The local database quick check could not be completed.")); }
    if (expiredDrafts.length) issues.push(issue("expired_drafts", "info", "media", "Expired unattached draft images can be removed.", { count: expiredDrafts.length, repairAction: "expired_drafts" }));
    if (orphans.length) issues.push(issue("orphan_media", "info", "media", "Unreferenced image assets can be safely removed.", { count: orphans.length, repairAction: "orphan_media" }));
    if (temp.anomalies + cache.anomalies) issues.push(issue("private_directory_anomaly", "warning", "filesystem", "Unexpected or linked entries were left untouched.", { count: temp.anomalies + cache.anomalies }));
    if (disk !== null && disk < LOW_DISK_RESERVE_BYTES) issues.push(issue("low_disk_space", "error", "filesystem", "Free space is critically low. Imports and image uploads are temporarily blocked."));
    return { generatedAt: new Date().toISOString(), platform: "android", databaseBytes, reclaimableDatabaseBytes: null, freeDiskBytes: disk, categories, issues, overall: issues.some((entry) => entry.severity === "error") ? "error" : issues.some((entry) => entry.severity === "warning") ? "attention" : "healthy", capabilities: { deepScan: true, fileSystemInspection: true, upgradeRecoveryCleanup: false, appTempCleanup: true, vacuum: false }, activeDeepScanId: activeScanId };
  };

  const startScan = () => {
    if (busy || activeScanId) throw Object.assign(new Error("Storage maintenance is busy."), { status: 409 });
    for (const [id, entry] of scans) if (entry.completedAt && Date.parse(entry.completedAt) < Date.now() - 60 * 60 * 1000) scans.delete(id);
    busy = true;
    maintenanceEpoch += 1;
    const scan = { id: randomUUID(), state: "running", startedAt: new Date().toISOString(), completedAt: null, progress: 0, checkedItems: 0, totalItems: records("mediaAsset").length + records("memory").length + 1, issues: [], errorCode: null, cancelled: false };
    scans.set(scan.id, scan); activeScanId = scan.id;
    void (async () => {
      try {
        const integrity = store.select("PRAGMA integrity_check");
        if (integrity.length !== 1 || String(Object.values(integrity[0])[0]).toLowerCase() !== "ok") scan.issues.push(issue("database_integrity_failed", "error", "database", "The full SQLite integrity check did not pass."));
        for (const asset of records("mediaAsset")) {
          if (scan.cancelled) throw new Error("cancelled");
          const data = Buffer.from(asset.dataBase64 ?? "", "base64"); const hash = createHash("sha256").update(data).digest("hex");
          if (data.length !== asset.byteSize || hash !== asset.contentHash) scan.issues.push(issue("media_integrity_mismatch", "error", "media", "An image asset failed its stored length or integrity check.", { count: 1 }));
          else { try { validateStoredImage({ data, mimeType: asset.mimeType, width: asset.width, height: asset.height }); } catch { scan.issues.push(issue("media_decode_failed", "error", "media", "An image asset cannot be decoded with its stored metadata.", { count: 1 })); } }
          scan.checkedItems += 1; scan.progress = Math.round(scan.checkedItems / Math.max(1, scan.totalItems) * 100); await new Promise((resolve) => setImmediate(resolve));
        }
        for (const memory of records("memory")) {
          if (scan.cancelled) throw new Error("cancelled");
          if (Array.isArray(memory.embedding) && (memory.embedding.some((value) => !Number.isFinite(value)) || (memory.embeddingDimensions && memory.embedding.length !== memory.embeddingDimensions))) scan.issues.push(issue("embedding_invalid", "warning", "embeddings", "A memory embedding has invalid dimensions or values and can be rebuilt.", { count: 1, repairAction: "clear_embeddings" }));
          scan.checkedItems += 1; scan.progress = Math.round(scan.checkedItems / Math.max(1, scan.totalItems) * 100); await new Promise((resolve) => setImmediate(resolve));
        }
        scan.state = "completed"; scan.progress = 100;
      } catch { scan.state = scan.cancelled ? "cancelled" : "failed"; scan.errorCode = scan.cancelled ? "scan_cancelled" : "scan_failed"; }
      scan.completedAt = new Date().toISOString(); activeScanId = null; busy = false;
    })();
    const { cancelled: _cancelled, ...dto } = scan; return clone(dto);
  };
  const getScan = (id) => { const scan = scans.get(id); if (!scan) throw Object.assign(new Error("Storage scan not found."), { status: 404 }); const { cancelled: _cancelled, ...dto } = scan; return clone(dto); };
  const cancelScan = (id) => { const scan = scans.get(id); if (!scan) throw Object.assign(new Error("Storage scan not found."), { status: 404 }); scan.cancelled = true; const { cancelled: _cancelled, ...dto } = scan; return clone(dto); };
  const cancelActive = () => { if (activeScanId) { const scan = scans.get(activeScanId); if (scan) scan.cancelled = true; } };

  const candidates = async () => {
    const attachments = records("messageAttachment"); const assets = records("mediaAsset"); const recoveryRefs = records("recoveryPointMediaAsset"); const recovery = records("recoveryPoint").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const referenced = new Set([...attachments.map((entry) => entry.assetId), ...recoveryRefs.map((entry) => entry.assetId)]);
    const drafts = attachments.filter((entry) => entry.draftId && !entry.messageId && Date.parse(entry.createdAt) < Date.now() - DRAFT_MAX_AGE_MS);
    const orphans = assets.filter((entry) => !referenced.has(entry.id)); const embeddings = records("memory").filter((entry) => Array.isArray(entry.embedding));
    const staleRecovery = recovery.filter((entry, index) => index >= 10 || Date.parse(entry.createdAt) < Date.now() - RECOVERY_MAX_AGE_MS);
    const [temp, cache] = await Promise.all([directory("temp"), directory("cache")]);
    return { expired_drafts: { count: drafts.length, bytes: sum(drafts.map((entry) => store.getMediaAsset(entry.assetId)?.byteSize ?? 0)) }, orphan_media: { count: orphans.length, bytes: sum(orphans.map((entry) => entry.byteSize ?? 0)) }, clear_embeddings: { count: embeddings.length, bytes: bytesOf(embeddings.map((entry) => entry.embedding)) }, expired_recovery_points: { count: staleRecovery.length, bytes: null }, old_upgrade_recovery: { count: 0, bytes: null }, usage_ledger: { count: records("usageAttempt").length + records("modelRequest").filter((entry) => !["queued", "running"].includes(entry.status)).length, bytes: null }, app_temp_cache: { count: temp.count + cache.count, bytes: temp.bytes === null || cache.bytes === null ? null : temp.bytes + cache.bytes }, rebuild_database_indexes: { count: 1, bytes: null }, vacuum_database: { count: 0, bytes: null }, drafts, orphans, embeddings, staleRecovery, temp, cache, stateVersion: store.mutationVersion };
  };
  const fingerprint = (value, actions) => createHash("sha256").update(JSON.stringify({ stateVersion: value.stateVersion, actions: actions.map((action) => [action, value[action]]) })).digest("hex");
  const createPlan = async (actions) => {
    if (busy) throw Object.assign(new Error("Storage maintenance is busy."), { status: 409 });
    for (const [id, entry] of plans) if (entry.used || Date.parse(entry.expiresAt) <= Date.now()) { plans.delete(id); planEpochs.delete(id); }
    const value = await candidates(); const createdAt = new Date().toISOString();
    const plan = { id: randomUUID(), createdAt, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(), fingerprint: fingerprint(value, actions), used: false, items: actions.map((action) => ({ action, count: value[action].count, estimatedBytes: value[action].bytes, supported: !["old_upgrade_recovery", "vacuum_database"].includes(action), warning: action === "vacuum_database" ? "VACUUM is unavailable because this mobile backend cannot guarantee an atomic file replacement." : action === "old_upgrade_recovery" ? "Upgrade-recovery cleanup is managed by the mobile migration layer." : null })) };
    plans.set(plan.id, plan); planEpochs.set(plan.id, maintenanceEpoch); const { used: _used, ...dto } = plan; return clone(dto);
  };
  const removeFiles = async (entries) => { let count = 0; for (const entry of entries) { if (!within(entry.path)) continue; try { const info = await lstat(entry.path); if (info.isFile() && !info.isSymbolicLink()) { await rm(entry.path); count += 1; } } catch { /* changed targets are skipped */ } } return count; };
  const executePlan = async (id) => {
    const plan = plans.get(id); if (!plan) throw Object.assign(new Error("Storage cleanup plan not found."), { status: 404 }); if (plan.used) throw Object.assign(new Error("This cleanup plan has already been used."), { status: 409 }); if (Date.parse(plan.expiresAt) <= Date.now()) throw Object.assign(new Error("This cleanup plan expired. Create a new preview."), { status: 410 }); if (planEpochs.get(id) !== maintenanceEpoch) throw Object.assign(new Error("Storage maintenance ran after this preview. Create a new cleanup plan."), { status: 409 });
    const before = await candidates(); if (fingerprint(before, plan.items.map((entry) => entry.action)) !== plan.fingerprint) throw Object.assign(new Error("Storage changed after the preview. Create a new cleanup plan."), { status: 409 }); plan.used = true; busy = true; maintenanceEpoch += 1; const results = [];
    for (const item of plan.items) {
      if (!item.supported) { results.push({ action: item.action, status: "skipped", count: 0, reclaimedBytes: null, errorCode: "unsupported_on_mobile" }); continue; }
      try {
        let count = 0;
        if (item.action === "expired_drafts") count = await store.cleanupExpiredDraftAttachments();
        else if (item.action === "orphan_media") { await store.cleanupOrphanAssets(); count = before.orphans.length; }
        else if (item.action === "clear_embeddings") await store.atomicWrite(async () => { for (const memory of before.embeddings) { await store.writeRecord("memory", { ...memory, embedding: null, embeddingModel: null, embeddingSource: null, embeddingDimensions: null, embeddingStatus: "stale", embeddingUpdatedAt: null }); count += 1; } });
        else if (item.action === "expired_recovery_points") await store.atomicWrite(async () => { for (const point of before.staleRecovery) { await store.deleteRecord("recoveryPoint", point.id); for (const ref of records("recoveryPointMediaAsset").filter((entry) => entry.recoveryPointId === point.id)) await store.deleteRecord("recoveryPointMediaAsset", ref.id); count += 1; } await store.cleanupOrphanAssets(); });
        else if (item.action === "usage_ledger") { const result = await store.clearUsageHistory(); count = result.attempts + result.requests; }
        else if (item.action === "app_temp_cache") count = await removeFiles([...before.temp.files, ...before.cache.files]);
        else if (item.action === "rebuild_database_indexes") { await store.atomicWrite(async () => store.db.run("REINDEX")); count = 1; }
        results.push({ action: item.action, status: "completed", count, reclaimedBytes: item.estimatedBytes, errorCode: null });
      } catch { results.push({ action: item.action, status: "failed", count: 0, reclaimedBytes: null, errorCode: "cleanup_action_failed" }); }
    }
    busy = false; return { planId: id, completedAt: new Date().toISOString(), items: results };
  };
  const assertCapacity = async (incomingBytes) => { const free = await freeDisk(); if (free !== null && free - Math.max(0, incomingBytes) < LOW_DISK_RESERVE_BYTES) throw Object.assign(new Error("Free space is too low for this operation. Export diagnostics or remove data before trying again."), { status: 507 }); };
  const registerMutation = () => { if (busy) throw Object.assign(new Error("Storage maintenance is busy. Try this write again after it finishes."), { status: 409 }); maintenanceEpoch += 1; };
  return { summary, startScan, getScan, cancelScan, cancelActive, createPlan, executePlan, assertCapacity, registerMutation };
};
