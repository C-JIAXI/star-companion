import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  MobileMigrationSafetyError,
  runProtectedMobileMigrations
} from "../../apps/mobile-backend/src/migration-safety.mjs";

const require = createRequire(new URL("../../apps/mobile-backend/package.json", import.meta.url));
const initSqlJs = require("sql.js");
const migrations = [
  { name: "001_records", sql: "CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL);" },
  { name: "002_timestamp", sql: "ALTER TABLE records ADD COLUMN createdAt TEXT;" },
  { name: "003_broken", sql: "INSERT INTO records (id, value) VALUES ('transient', 'rollback'); THIS IS NOT SQL;" }
];
const workspace = () => fs.mkdtemp(path.join(os.tmpdir(), "star-companion-mobile-migration-"));

test("mobile migrations initialize, upgrade once, and preserve a recovery copy", async () => {
  const SQL = await initSqlJs();
  const root = await workspace();
  const filePath = path.join(root, "mobile.sqlite");
  let result = await runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.0.0", migrations: migrations.slice(0, 1) });
  assert.equal(result.report.recoveryCreated, false);
  result.db.run("INSERT INTO records (id, value) VALUES (?, ?)", ["preserved", "safe"]);
  await fs.writeFile(filePath, Buffer.from(result.db.export()));
  result.db.close();

  result = await runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.1.0", migrations: migrations.slice(0, 2) });
  assert.deepEqual(result.report.appliedMigrations, ["002_timestamp"]);
  assert.equal(result.report.recoveryCreated, true);
  result.db.close();
  const repeated = await runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.1.0", migrations: migrations.slice(0, 2) });
  assert.deepEqual(repeated.report.appliedMigrations, []);
  repeated.db.close();
  assert.ok((await fs.readdir(path.join(root, "upgrade-recovery"))).some((name) => name.endsWith(".sqlite")));
  await fs.rm(root, { recursive: true, force: true });
});

test("mobile checksum mismatch and newer schema are rejected without changing the file", async () => {
  const SQL = await initSqlJs();
  const root = await workspace();
  const filePath = path.join(root, "mobile.sqlite");
  const current = await runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.1.0", migrations: migrations.slice(0, 2) });
  current.db.close();
  const before = await fs.readFile(filePath);
  await assert.rejects(
    runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.1.0", migrations: [{ ...migrations[0], sql: `${migrations[0].sql} -- changed` }, migrations[1]] }),
    (error) => error instanceof MobileMigrationSafetyError && error.code === "CHECKSUM_MISMATCH"
  );
  assert.deepEqual(await fs.readFile(filePath), before);
  await assert.rejects(
    runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.0.0", migrations: migrations.slice(0, 1) }),
    (error) => error instanceof MobileMigrationSafetyError && error.code === "SCHEMA_TOO_NEW"
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("a failed mobile migration leaves the original database usable", async () => {
  const SQL = await initSqlJs();
  const root = await workspace();
  const filePath = path.join(root, "mobile.sqlite");
  const current = await runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.1.0", migrations: migrations.slice(0, 2) });
  current.db.close();
  const before = await fs.readFile(filePath);
  await assert.rejects(
    runProtectedMobileMigrations({ SQL, filePath, appVersion: "1.2.0", migrations }),
    (error) => error instanceof MobileMigrationSafetyError && error.code === "MIGRATION_FAILED"
  );
  assert.deepEqual(await fs.readFile(filePath), before);
  const reopened = new SQL.Database(before);
  assert.equal(reopened.exec("SELECT COUNT(*) FROM records WHERE id='transient'")[0].values[0][0], 0);
  reopened.close();
  await fs.rm(root, { recursive: true, force: true });
});
