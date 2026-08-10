import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { runProtectedMigrations } = require("../../apps/desktop/migration-safety.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "star-companion-e2e-"));
const databasePath = path.join(temporary, "e2e.db");
runProtectedMigrations({
  databasePath,
  migrationsDirectory: path.join(root, "apps", "server", "prisma", "migrations"),
  recoveryDirectory: path.join(temporary, "upgrade-recovery"),
  appVersion: packageJson.version
});

const child = spawn(process.execPath, [path.join(root, "apps", "server", "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
  cwd: path.join(root, "apps", "server"),
  env: {
    ...process.env,
    DATABASE_URL: `file:${databasePath.replace(/\\/g, "/")}`,
    SERVER_PORT: "4010",
    CORS_ORIGIN: "http://127.0.0.1:5174",
    API_KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
    STAR_COMPANION_PLATFORM: "web",
    STAR_COMPANION_BUILD_TYPE: "development"
  },
  stdio: "inherit"
});

let closing = false;
const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  if (child.exitCode === null) child.kill();
  await rm(temporary, { recursive: true, force: true });
  process.exit(code);
};
process.on("SIGINT", () => void close(0));
process.on("SIGTERM", () => void close(0));
child.on("error", () => void close(1));
child.on("exit", (code) => void close(code ?? 1));
