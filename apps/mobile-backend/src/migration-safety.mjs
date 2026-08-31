import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class MobileMigrationSafetyError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "MobileMigrationSafetyError";
    this.code = code;
  }
}

export const MOBILE_MIGRATIONS = [
  {
    name: "001_records",
    sql: `
      CREATE TABLE IF NOT EXISTS records (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        cardId TEXT,
        chatId TEXT,
        characterId TEXT,
        role TEXT,
        enabled INTEGER,
        importance INTEGER,
        createdAt TEXT,
        updatedAt TEXT,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_type_updated ON records(type, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_records_type_created ON records(type, createdAt);
      CREATE INDEX IF NOT EXISTS idx_records_type_card ON records(type, cardId);
      CREATE INDEX IF NOT EXISTS idx_records_type_chat ON records(type, chatId);
    `
  },
  {
    name: "002_message_image_assets",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_records_type_role ON records(type, role);
    `
  },
  {
    name: "003_cursor_pagination",
    sql: `
      ALTER TABLE records ADD COLUMN isPinned INTEGER;
      ALTER TABLE records ADD COLUMN isArchived INTEGER;
      ALTER TABLE records ADD COLUMN isCheckpoint INTEGER;
      ALTER TABLE records ADD COLUMN deletedAt TEXT;
      ALTER TABLE records ADD COLUMN folder TEXT;
      ALTER TABLE records ADD COLUMN title TEXT;
      ALTER TABLE records ADD COLUMN name TEXT;
      ALTER TABLE records ADD COLUMN messageId TEXT;
      ALTER TABLE records ADD COLUMN draftId TEXT;
      ALTER TABLE records ADD COLUMN contextIncluded INTEGER;
      ALTER TABLE records ADD COLUMN embeddingStatus TEXT;
      ALTER TABLE records ADD COLUMN assetId TEXT;
      UPDATE records SET
        isPinned = json_extract(data, '$.isPinned'),
        isArchived = json_extract(data, '$.isArchived'),
        isCheckpoint = json_extract(data, '$.isCheckpoint'),
        deletedAt = json_extract(data, '$.deletedAt'),
        folder = json_extract(data, '$.folder'),
        title = json_extract(data, '$.title'),
        name = json_extract(data, '$.name'),
        messageId = json_extract(data, '$.messageId'),
        draftId = json_extract(data, '$.draftId'),
        contextIncluded = COALESCE(json_extract(data, '$.contextIncluded'), 1),
        embeddingStatus = json_extract(data, '$.embeddingStatus'),
        assetId = json_extract(data, '$.assetId');
      CREATE INDEX IF NOT EXISTS idx_records_message_timeline ON records(type, chatId, createdAt, id);
      CREATE INDEX IF NOT EXISTS idx_records_chat_page ON records(type, deletedAt, isArchived, isCheckpoint, isPinned, updatedAt, id);
      CREATE INDEX IF NOT EXISTS idx_records_message_attachment ON records(type, messageId);
      CREATE INDEX IF NOT EXISTS idx_records_draft_attachment ON records(type, draftId);
      CREATE INDEX IF NOT EXISTS idx_records_memory_recall ON records(type, chatId, enabled, deletedAt, importance, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_records_message_role_timeline ON records(type, chatId, role, createdAt, id);
      CREATE INDEX IF NOT EXISTS idx_records_attachment_asset ON records(type, assetId);
    `
  }
];

const checksum = (value) => createHash("sha256").update(value).digest("hex");
const tableExists = (db, name) => db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name])[0]?.values.length > 0;
const selectObjects = (db, sql, params = []) => {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
};
const compareVersions = (left, right) => {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""))?.slice(1).map(Number);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
};
const checkIntegrity = (db) => {
  const value = db.exec("PRAGMA integrity_check")[0]?.values?.[0]?.[0];
  if (String(value).toLowerCase() !== "ok") {
    throw new MobileMigrationSafetyError("INTEGRITY_FAILED", "The mobile database did not pass its integrity check. No upgrade was attempted.");
  }
};
const ensureMetaTables = (db) => db.run(`
  CREATE TABLE IF NOT EXISTS _star_companion_mobile_migrations (
    migration_name TEXT PRIMARY KEY NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _star_companion_mobile_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    schema_checksum TEXT NOT NULL,
    migration_status TEXT NOT NULL,
    previous_app_version TEXT,
    previous_schema_version TEXT,
    updated_at TEXT NOT NULL
  );
`);

const createSafetyCopy = async ({ filePath, recoveryDirectory, previousAppVersion, previousSchemaVersion }) => {
  await mkdir(recoveryDirectory, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const databaseFile = path.join(recoveryDirectory, `${id}.sqlite`);
  await copyFile(filePath, databaseFile);
  const size = (await stat(databaseFile)).size;
  await writeFile(path.join(recoveryDirectory, `${id}.json`), JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    reason: "before_schema_upgrade",
    previousAppVersion: previousAppVersion || null,
    previousSchemaVersion: previousSchemaVersion || null,
    databaseFile: path.basename(databaseFile),
    sizeBytes: size
  }, null, 2), { encoding: "utf8", flag: "wx" });
  return id;
};

const pruneSafetyCopies = async (recoveryDirectory, limit) => {
  let names;
  try { names = await readdir(recoveryDirectory); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const manifests = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const fullPath = path.join(recoveryDirectory, name);
    manifests.push({ name, fullPath, modified: (await stat(fullPath)).mtimeMs });
  }
  manifests.sort((left, right) => right.modified - left.modified);
  for (const stale of manifests.slice(limit)) {
    try {
      const manifest = JSON.parse(await readFile(stale.fullPath, "utf8"));
      await rm(path.join(recoveryDirectory, path.basename(manifest.databaseFile)), { force: true });
      await rm(stale.fullPath, { force: true });
    } catch {
      // Retain unreadable recovery metadata for manual inspection.
    }
  }
};

const writeAtomically = async (filePath, bytes) => {
  const temporary = `${filePath}.upgrade-${randomUUID()}`;
  const displaced = `${filePath}.before-upgrade-${randomUUID()}`;
  await writeFile(temporary, Buffer.from(bytes), { flag: "wx" });
  let movedOriginal = false;
  try {
    try { await rename(filePath, displaced); movedOriginal = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(temporary, filePath);
    if (movedOriginal) await rm(displaced, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedOriginal) await rename(displaced, filePath);
    throw error;
  }
};

export async function runProtectedMobileMigrations({ SQL, filePath, appVersion, migrations = MOBILE_MIGRATIONS, recoveryLimit = 5 }) {
  const catalog = migrations.map((migration) => ({ ...migration, checksum: checksum(migration.sql) }));
  if (catalog.length === 0) throw new MobileMigrationSafetyError("MIGRATION_CATALOG_EMPTY", "No mobile database migrations are bundled with this application.");
  let originalBytes = null;
  try { originalBytes = await readFile(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  let db;
  try { db = originalBytes ? new SQL.Database(originalBytes) : new SQL.Database(); } catch (error) {
    throw new MobileMigrationSafetyError("INTEGRITY_FAILED", "The mobile database cannot be opened. No upgrade was attempted.", error);
  }
  checkIntegrity(db);
  const known = new Map(catalog.map((migration) => [migration.name, migration]));
  const applied = tableExists(db, "_star_companion_mobile_migrations")
    ? selectObjects(db, "SELECT migration_name, checksum FROM _star_companion_mobile_migrations ORDER BY migration_name")
    : [];
  const meta = tableExists(db, "_star_companion_mobile_meta")
    ? selectObjects(db, "SELECT app_version, schema_version, schema_checksum FROM _star_companion_mobile_meta WHERE id=1")[0] || null
    : null;
  for (const row of applied) {
    const migration = known.get(row.migration_name);
    if (!migration) {
      db.close();
      throw new MobileMigrationSafetyError("SCHEMA_TOO_NEW", "This mobile database was upgraded by a newer Star Companion version.");
    }
    if (row.checksum !== migration.checksum) {
      db.close();
      throw new MobileMigrationSafetyError("CHECKSUM_MISMATCH", `Mobile migration ${row.migration_name} does not match this application build.`);
    }
  }
  if (meta) {
    const metadataMigration = known.get(meta.schema_version);
    if (!metadataMigration) {
      db.close();
      throw new MobileMigrationSafetyError("SCHEMA_TOO_NEW", "This mobile database records a schema version that this build does not support.");
    }
    if (meta.schema_checksum !== metadataMigration.checksum) {
      db.close();
      throw new MobileMigrationSafetyError("CHECKSUM_MISMATCH", "The recorded mobile schema checksum does not match this application build.");
    }
  }
  if (meta && compareVersions(meta.app_version, appVersion) > 0) {
    db.close();
    throw new MobileMigrationSafetyError("APP_TOO_OLD", "This mobile database belongs to a newer Star Companion version.");
  }
  const appliedNames = new Set(applied.map((row) => row.migration_name));
  const pending = catalog.filter((migration) => !appliedNames.has(migration.name));
  const legacyRecords = applied.length === 0 && tableExists(db, "records");
  const previousSchemaVersion = applied.at(-1)?.migration_name || meta?.schema_version || (legacyRecords ? "legacy_records" : null);
  const previousAppVersion = meta?.app_version || null;
  let recoveryId = null;
  if (pending.length > 0 && originalBytes) {
    recoveryId = await createSafetyCopy({ filePath, recoveryDirectory: path.join(path.dirname(filePath), "upgrade-recovery"), previousAppVersion, previousSchemaVersion });
  }
  try {
    db.run("BEGIN");
    ensureMetaTables(db);
    for (const migration of pending) {
      db.run(migration.sql);
      db.run("INSERT INTO _star_companion_mobile_migrations (migration_name, checksum, applied_at) VALUES (?, ?, ?)", [migration.name, migration.checksum, new Date().toISOString()]);
    }
    const latest = catalog.at(-1);
    const status = pending.length > 0 && originalBytes ? "upgraded" : "ready";
    db.run(`INSERT INTO _star_companion_mobile_meta (id, app_version, schema_version, schema_checksum, migration_status, previous_app_version, previous_schema_version, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET app_version=excluded.app_version, schema_version=excluded.schema_version, schema_checksum=excluded.schema_checksum,
      migration_status=excluded.migration_status, previous_app_version=excluded.previous_app_version, previous_schema_version=excluded.previous_schema_version, updated_at=excluded.updated_at`,
    [appVersion, latest.name, latest.checksum, status, previousAppVersion, previousSchemaVersion, new Date().toISOString()]);
    db.run("COMMIT");
    checkIntegrity(db);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeAtomically(filePath, db.export());
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* already rolled back */ }
    db.close();
    throw error instanceof MobileMigrationSafetyError ? error : new MobileMigrationSafetyError(
      "MIGRATION_FAILED",
      "The mobile database upgrade failed. The original database and pre-upgrade recovery copy were preserved.",
      error
    );
  }
  if (recoveryId) await pruneSafetyCopies(path.join(path.dirname(filePath), "upgrade-recovery"), recoveryLimit);
  return {
    db,
    report: {
      status: pending.length > 0 && originalBytes ? "upgraded" : "ready",
      appVersion,
      schemaVersion: catalog.at(-1).name,
      schemaChecksum: catalog.at(-1).checksum,
      previousAppVersion,
      previousSchemaVersion,
      appliedMigrations: pending.map((migration) => migration.name),
      recoveryCreated: Boolean(recoveryId),
      recoveryId
    }
  };
}
