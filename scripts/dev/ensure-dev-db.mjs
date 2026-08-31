import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const require = createRequire(import.meta.url);
const { runProtectedMigrations } = require("../../apps/desktop/migration-safety.cjs");
const databasePath = process.env.STAR_COMPANION_DEV_DATABASE_PATH
  ? path.resolve(process.env.STAR_COMPANION_DEV_DATABASE_PATH)
  : path.join(repoRoot, "apps", "server", "prisma", "dev.db");
const migrationsDirectory = process.env.STAR_COMPANION_DEV_MIGRATIONS_PATH
  ? path.resolve(process.env.STAR_COMPANION_DEV_MIGRATIONS_PATH)
  : path.join(repoRoot, "apps", "server", "prisma", "migrations");
const recoveryDirectory = process.env.STAR_COMPANION_DEV_RECOVERY_PATH
  ? path.resolve(process.env.STAR_COMPANION_DEV_RECOVERY_PATH)
  : path.join(path.dirname(databasePath), "upgrade-recovery");

if (existsSync(databasePath)) {
  try {
    const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const report = runProtectedMigrations({
      databasePath,
      migrationsDirectory,
      recoveryDirectory,
      appVersion: version
    });
    if (report.appliedMigrations.length > 0) {
      console.log(
        `[ensure-dev-db] Applied ${report.appliedMigrations.length} migration(s) through ${report.schemaVersion}; recovery ${report.recoveryId}.`
      );
    }
    process.exit(0);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "MIGRATION_FAILED";
    const message = error instanceof Error ? error.message : "The development database could not be upgraded safely.";
    console.error(`[ensure-dev-db] ${code}: ${message}`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "dev", "init-dev-db.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
