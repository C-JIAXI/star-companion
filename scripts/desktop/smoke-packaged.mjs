import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

if (process.platform !== "win32") {
  console.log("Packaged desktop smoke is only applicable to Windows.");
  process.exit(0);
}

const root = process.cwd();
const executable = path.join(root, "dist", "desktop", "win-unpacked", "Star Companion.exe");
await stat(executable);
const temporary = await mkdtemp(path.join(os.tmpdir(), "star-companion-packaged-smoke-"));
const logPath = path.join(temporary, "startup.log");
const dataDirectory = path.join(temporary, "data");
const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: {
    ...process.env,
    STAR_COMPANION_DATA_DIR: dataDirectory,
    DESKTOP_STARTUP_LOG: logPath
  },
  stdio: "ignore",
  windowsHide: true
});

try {
  const startedAt = Date.now();
  let log = "";
  while (Date.now() - startedAt < 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { log = await readFile(logPath, "utf8"); } catch { /* startup log not created yet */ }
    if (log.includes("serverReady=true")) break;
    if (child.exitCode !== null) throw new Error(`Packaged app exited before startup completed (code ${child.exitCode}).`);
  }
  assert.match(log, /migrationStatus=ready/);
  assert.match(log, /serverReady=true/);
  assert.ok(!log.includes(root));
  assert.ok(!/api.?key|persona|chat content/i.test(log));
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 750));
  const databasePath = path.join(dataDirectory, "star-companion.db");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='RecoveryPoint'").get().count, 1);
    assert.equal(db.prepare("SELECT schema_version FROM _star_companion_meta WHERE id=1").get().schema_version, "20260810000300_add_recovery_points");
  } finally {
    db.close();
  }
  console.log("Packaged desktop smoke passed: resources, server, fresh protected migration, and Web startup completed.");
} finally {
  if (child.exitCode === null) child.kill();
  await rm(temporary, { recursive: true, force: true });
}
