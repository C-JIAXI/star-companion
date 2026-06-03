import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const prismaDir = path.join(repoRoot, "apps", "server", "prisma");
const migrationsDir = path.join(prismaDir, "migrations");
const dbPath = path.join(prismaDir, "dev.db");

const log = (message) => console.log(`[init-dev-db] ${message}`);

const removeDatabaseFiles = () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const getMigrationNames = () =>
  readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const readMigrationSql = (migrationName) =>
  readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");

if (existsSync(dbPath)) {
  console.error(`[init-dev-db] Refusing to overwrite existing database: ${dbPath}`);
  process.exit(1);
}

mkdirSync(prismaDir, { recursive: true });

let db;

try {
  const migrationNames = getMigrationNames();
  db = new DatabaseSync(dbPath);

  for (const migrationName of migrationNames) {
    db.exec(readMigrationSql(migrationName));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )
  `);

  const insertMigration = db.prepare(`
    INSERT INTO "_prisma_migrations" (
      "id",
      "checksum",
      "finished_at",
      "migration_name",
      "logs",
      "rolled_back_at",
      "started_at",
      "applied_steps_count"
    ) VALUES (?, ?, datetime('now'), ?, NULL, NULL, datetime('now'), 1)
  `);

  for (const migrationName of migrationNames) {
    const checksum = createHash("sha256").update(readMigrationSql(migrationName)).digest("hex");
    insertMigration.run(randomUUID(), checksum, migrationName);
  }

  log(`Initialized ${dbPath} from ${migrationNames.length} migrations.`);
} catch (error) {
  if (db) {
    db.close();
    db = undefined;
  }

  removeDatabaseFiles();
  console.error(`[init-dev-db] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  if (db) {
    db.close();
  }
}
