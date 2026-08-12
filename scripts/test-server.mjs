import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(repoRoot, "apps", "server");
const migrationsDir = path.join(serverDir, "prisma", "migrations");
const runId = `server-test-${process.pid}-${Date.now()}`;
const tempDir = path.join(serverDir, "prisma", ".tmp", runId);
const dbPath = path.join(tempDir, "test.db");

const initialize = async () => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL,"checksum" TEXT NOT NULL,"finished_at" DATETIME,"migration_name" TEXT NOT NULL,"logs" TEXT,"rolled_back_at" DATETIME,"started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"applied_steps_count" INTEGER NOT NULL DEFAULT 0);');
    const migrations = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const name of migrations) {
      const sql = await readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
      db.exec(sql);
      const at = new Date().toISOString();
      db.prepare('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)')
        .run(randomUUID(), createHash("sha256").update(sql).digest("hex"), at, name, at);
    }
  } finally { db.close(); }
};

await mkdir(tempDir, { recursive: true });
try {
  await initialize();
  const child = spawn(process.execPath, [path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs"), "--test", "--test-concurrency=1", "src/**/*.test.ts", ...process.argv.slice(2)], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: `file:./.tmp/${runId}/test.db`, API_KEY_ENCRYPTION_SECRET: `test-secret-${runId}-0123456789abcdef` },
    stdio: "inherit"
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
