import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { MigrationSafetyError, restoreSafetyCopy, runProtectedMigrations } = require("../../apps/desktop/migration-safety.cjs");

const migrationSql = [
  'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY, "value" TEXT NOT NULL);',
  'ALTER TABLE "Example" ADD COLUMN "createdAt" TEXT;',
  'INSERT INTO "Example" ("id", "value") VALUES (\'transient\', \'must rollback\');\nTHIS IS NOT SQL;'
];

const makeWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "star-companion-migration-"));
const writeCatalog = (root, count, override = {}) => {
  const directory = path.join(root, `migrations-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const name = `00${index + 1}_migration`;
    fs.mkdirSync(path.join(directory, name));
    fs.writeFileSync(path.join(directory, name, "migration.sql"), override[index] ?? migrationSql[index], "utf8");
  }
  return directory;
};
const open = (databasePath) => new DatabaseSync(databasePath);

test("protected desktop migrations initialize, upgrade once, and create a restorable safety copy", () => {
  const root = makeWorkspace();
  const databasePath = path.join(root, "app.db");
  const recoveryDirectory = path.join(root, "recovery");
  const firstCatalog = writeCatalog(root, 1);
  const first = runProtectedMigrations({ databasePath, migrationsDirectory: firstCatalog, recoveryDirectory, appVersion: "1.0.0" });
  assert.deepEqual(first.appliedMigrations, ["001_migration"]);
  assert.equal(first.recoveryCreated, false);
  let db = open(databasePath);
  db.prepare('INSERT INTO "Example" (id, value) VALUES (?, ?)').run("preserved", "safe");
  db.close();

  const secondCatalog = writeCatalog(root, 2);
  const upgraded = runProtectedMigrations({ databasePath, migrationsDirectory: secondCatalog, recoveryDirectory, appVersion: "1.1.0" });
  assert.deepEqual(upgraded.appliedMigrations, ["002_migration"]);
  assert.equal(upgraded.recoveryCreated, true);
  const repeated = runProtectedMigrations({ databasePath, migrationsDirectory: secondCatalog, recoveryDirectory, appVersion: "1.1.0" });
  assert.deepEqual(repeated.appliedMigrations, []);

  db = open(databasePath);
  db.prepare('UPDATE "Example" SET value=? WHERE id=?').run("changed", "preserved");
  db.close();
  restoreSafetyCopy({ databasePath, recoveryDirectory, recoveryId: upgraded.recoveryId });
  db = open(databasePath);
  assert.equal(db.prepare('SELECT value FROM "Example" WHERE id=?').get("preserved").value, "safe");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('Example') WHERE name='createdAt'").get().count, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("checksum mismatch and newer schemas are rejected without writes", () => {
  const root = makeWorkspace();
  const databasePath = path.join(root, "app.db");
  const recoveryDirectory = path.join(root, "recovery");
  const catalog = writeCatalog(root, 2);
  runProtectedMigrations({ databasePath, migrationsDirectory: catalog, recoveryDirectory, appVersion: "1.1.0" });
  const before = fs.readFileSync(databasePath);
  const changedCatalog = writeCatalog(root, 2, { 0: `${migrationSql[0]}\n-- changed` });
  assert.throws(
    () => runProtectedMigrations({ databasePath, migrationsDirectory: changedCatalog, recoveryDirectory, appVersion: "1.1.0" }),
    (error) => error instanceof MigrationSafetyError && error.code === "CHECKSUM_MISMATCH"
  );
  assert.deepEqual(fs.readFileSync(databasePath), before);
  const olderCatalog = writeCatalog(root, 1);
  assert.throws(
    () => runProtectedMigrations({ databasePath, migrationsDirectory: olderCatalog, recoveryDirectory, appVersion: "1.0.0" }),
    (error) => error instanceof MigrationSafetyError && error.code === "SCHEMA_TOO_NEW"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a failed desktop migration rolls back and keeps the pre-upgrade copy", () => {
  const root = makeWorkspace();
  const databasePath = path.join(root, "app.db");
  const recoveryDirectory = path.join(root, "recovery");
  runProtectedMigrations({ databasePath, migrationsDirectory: writeCatalog(root, 2), recoveryDirectory, appVersion: "1.1.0" });
  assert.throws(
    () => runProtectedMigrations({ databasePath, migrationsDirectory: writeCatalog(root, 3), recoveryDirectory, appVersion: "1.2.0" }),
    (error) => error instanceof MigrationSafetyError && error.code === "MIGRATION_FAILED"
  );
  const db = open(databasePath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "Example" WHERE id=?').get("transient").count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "_prisma_migrations"').get().count, 2);
  db.close();
  assert.ok(fs.readdirSync(recoveryDirectory).some((name) => name.endsWith(".db")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the bundled Prisma SQL catalog initializes a fresh desktop database deterministically", () => {
  const root = makeWorkspace();
  const databasePath = path.join(root, "app.db");
  const report = runProtectedMigrations({
    databasePath,
    migrationsDirectory: path.resolve("apps/server/prisma/migrations"),
    recoveryDirectory: path.join(root, "recovery"),
    appVersion: "1.0.2"
  });
  assert.equal(report.appliedMigrations.length > 20, true);
  assert.equal(report.schemaVersion, "20260812000200_add_memory_history");
  const db = open(databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='RecoveryPoint'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='ModelRequest'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='ModelUsageAttempt'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='MemoryRevision'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='MemoryOperation'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='ProfileSummaryRevision'").get().count, 1);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
