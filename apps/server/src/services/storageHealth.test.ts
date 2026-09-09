import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import {
  createStorageCleanupPlan,
  cancelActiveStorageScan,
  executeStorageCleanupPlan,
  expireStorageCleanupPlanForTests,
  forceStorageCleanupFailureForTests,
  getStorageDeepScan,
  getStorageHealthSnapshot,
  startStorageDeepScan
} from "./storageHealth.js";

const createdAssetIds: string[] = [];
const pngBytes = () => { const image = new PNG({ width: 2, height: 2 }); image.data.fill(190); return PNG.sync.write(image); };
const createAsset = async (suffix: string, overrides: Partial<{ contentHash: string; data: Buffer; byteSize: number }> = {}) => {
  const data = overrides.data ?? pngBytes();
  const asset = await prisma.mediaAsset.create({ data: { contentHash: overrides.contentHash ?? `storage-health-${suffix}-${Date.now()}`, mimeType: "image/png", byteSize: overrides.byteSize ?? data.length, width: 2, height: 2, storageKey: `storage-health:${suffix}:${Date.now()}`, data } });
  createdAssetIds.push(asset.id); return asset;
};

after(async () => {
  await prisma.mediaAsset.deleteMany({ where: { id: { in: createdAssetIds }, attachments: { none: {} }, recoveryPoints: { none: {} } } });
});

describe("storage health", () => {
  it("produces read-only category statistics and fast health results", async () => {
    const before = { characters: await prisma.character.count(), messages: await prisma.message.count(), assets: await prisma.mediaAsset.count(), recovery: await prisma.recoveryPoint.count() };
    const snapshot = await getStorageHealthSnapshot();
    const afterCounts = { characters: await prisma.character.count(), messages: await prisma.message.count(), assets: await prisma.mediaAsset.count(), recovery: await prisma.recoveryPoint.count() };
    assert.deepEqual(afterCounts, before);
    assert.ok(snapshot.categories.some((entry) => entry.id === "media_orphans" && entry.measurement === "exact"));
    assert.ok(snapshot.categories.some((entry) => entry.id === "memory_revisions"));
    assert.equal(JSON.stringify(snapshot).includes(process.cwd()), false);
  });

  it("detects corrupted media without deleting or exposing it", async () => {
    const asset = await createAsset(`corrupt-${Date.now()}`, { contentHash: "0".repeat(64), byteSize: 999 });
    const scan = startStorageDeepScan();
    let completed = getStorageDeepScan(scan.id);
    for (let attempt = 0; attempt < 100 && completed.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed = getStorageDeepScan(scan.id);
    }
    assert.equal(completed.state, "completed");
    assert.ok(completed.issues.some((entry) => entry.code === "media_integrity_mismatch"));
    assert.ok(await prisma.mediaAsset.findUnique({ where: { id: asset.id } }));
  });

  it("cancels an active deep scan when the privacy boundary requests it", async () => {
    const started = startStorageDeepScan();
    cancelActiveStorageScan();
    let completed = getStorageDeepScan(started.id);
    for (let attempt = 0; attempt < 100 && completed.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = getStorageDeepScan(started.id);
    }
    assert.equal(completed.state, "cancelled");
  });

  it("rejects changed, expired, and reused cleanup plans", async () => {
    const first = await createStorageCleanupPlan(["orphan_media"]);
    await createAsset(`changed-${Date.now()}`);
    await assert.rejects(() => executeStorageCleanupPlan(first.id), (error) => error instanceof HttpError && error.status === 409);

    const expired = await createStorageCleanupPlan(["rebuild_database_indexes"]);
    expireStorageCleanupPlanForTests(expired.id);
    await assert.rejects(() => executeStorageCleanupPlan(expired.id), (error) => error instanceof HttpError && error.status === 410);

    const reusable = await createStorageCleanupPlan(["orphan_media"]);
    const result = await executeStorageCleanupPlan(reusable.id);
    assert.equal(result.items[0]?.status, "completed");
    await assert.rejects(() => executeStorageCleanupPlan(reusable.id), (error) => error instanceof HttpError && error.status === 409);
  });

  it("isolates partial cleanup failures and runs VACUUM only from an exclusive plan", async () => {
    const partial = await createStorageCleanupPlan(["rebuild_database_indexes", "app_temp_cache"]);
    forceStorageCleanupFailureForTests("app_temp_cache");
    try {
      const result = await executeStorageCleanupPlan(partial.id);
      assert.deepEqual(result.items.map((item) => item.status), ["completed", "failed"]);
      assert.equal(result.items[1]?.errorCode, "cleanup_action_failed");
    } finally {
      forceStorageCleanupFailureForTests(null);
    }

    const vacuum = await createStorageCleanupPlan(["vacuum_database"]);
    assert.deepEqual(vacuum.items.map((item) => item.action), ["vacuum_database"]);
    const result = await executeStorageCleanupPlan(vacuum.id);
    assert.equal(result.items[0]?.status, "completed");
  });

  for (const aliasedRoot of [false, true]) it(`does not follow linked or traversal-like entries during temp cleanup${aliasedRoot ? " through a root alias" : ""}`, async (context) => {
    const originalRoot = process.env.STAR_COMPANION_DATA_DIR;
    const root = await mkdtemp(path.join(os.tmpdir(), "star-companion-storage-test-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "star-companion-storage-outside-"));
    const rootAlias = `${root}-alias`;
    try {
      if (aliasedRoot) await symlink(root, rootAlias, process.platform === "win32" ? "junction" : "dir");
      process.env.STAR_COMPANION_DATA_DIR = aliasedRoot ? rootAlias : root;
      await mkdir(path.join(root, "temp"), { recursive: true });
      await writeFile(path.join(root, "temp", "owned.tmp"), "owned");
      const outsideFile = path.join(outside, "keep.txt");
      await writeFile(outsideFile, "keep");
      try { await symlink(outsideFile, path.join(root, "temp", "linked.tmp"), "file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") context.diagnostic("Windows did not permit creating a test symlink; containment still covers the owned file."); else throw error; }
      const plan = await createStorageCleanupPlan(["app_temp_cache"]);
      assert.equal(plan.items[0]?.count, 1);
      await executeStorageCleanupPlan(plan.id);
      assert.equal(await readFile(outsideFile, "utf8"), "keep");
      await assert.rejects(() => readFile(path.join(root, "temp", "owned.tmp"), "utf8"));
    } finally {
      if (originalRoot === undefined) delete process.env.STAR_COMPANION_DATA_DIR; else process.env.STAR_COMPANION_DATA_DIR = originalRoot;
      if (aliasedRoot) await rm(rootAlias, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
    }
  });
});
