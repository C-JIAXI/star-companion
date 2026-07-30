import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const databasePath = process.env.STAR_COMPANION_DEV_DATABASE_PATH
  ? path.resolve(process.env.STAR_COMPANION_DEV_DATABASE_PATH)
  : path.join(repoRoot, "apps", "server", "prisma", "dev.db");

if (existsSync(databasePath)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "dev", "init-dev-db.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
