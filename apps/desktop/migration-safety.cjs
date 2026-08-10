const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const META_TABLE = "_star_companion_meta";
const MIGRATION_TABLE = "_prisma_migrations";
const DEFAULT_RECOVERY_LIMIT = 5;

class MigrationSafetyError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "MigrationSafetyError";
    this.code = code;
  }
}

const checksum = (content) => crypto.createHash("sha256").update(content).digest("hex");

const compareVersions = (left, right) => {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || ""));
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || null];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3].localeCompare(b[3], "en", { numeric: true });
};

const loadMigrationCatalog = (migrationsDirectory) => fs
  .readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right))
  .map((name) => {
    const sql = fs.readFileSync(path.join(migrationsDirectory, name, "migration.sql"), "utf8");
    return { name, sql, checksum: checksum(sql) };
  });

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

const checkIntegrity = (db) => {
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || String(Object.values(rows[0])[0]).toLowerCase() !== "ok") {
    throw new MigrationSafetyError("INTEGRITY_FAILED", "The local database did not pass its integrity check. No upgrade was attempted.");
  }
};

const readApplied = (db) => {
  if (!tableExists(db, MIGRATION_TABLE)) return [];
  return db.prepare(`SELECT migration_name, checksum FROM "${MIGRATION_TABLE}" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`).all();
};

const readMeta = (db) => {
  if (!tableExists(db, META_TABLE)) return null;
  return db.prepare(`SELECT app_version, schema_version, schema_checksum, migration_status, updated_at FROM "${META_TABLE}" WHERE id=1`).get() || null;
};

const hasUserDataSchema = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?) LIMIT 1").get(MIGRATION_TABLE, META_TABLE));

const ensureMetadataTables = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "${META_TABLE}" (
      "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
      "app_version" TEXT NOT NULL,
      "schema_version" TEXT NOT NULL,
      "schema_checksum" TEXT NOT NULL,
      "migration_status" TEXT NOT NULL,
      "previous_app_version" TEXT,
      "previous_schema_version" TEXT,
      "updated_at" TEXT NOT NULL
    );
  `);
};

const validateCurrentState = ({ db, catalog, appVersion }) => {
  const known = new Map(catalog.map((migration) => [migration.name, migration]));
  const applied = readApplied(db);
  const meta = readMeta(db);
  for (const row of applied) {
    const migration = known.get(row.migration_name);
    if (!migration) {
      throw new MigrationSafetyError("SCHEMA_TOO_NEW", "This database was upgraded by a newer Star Companion version. Install that version or a newer one before opening it.");
    }
    if (row.checksum !== migration.checksum) {
      throw new MigrationSafetyError("CHECKSUM_MISMATCH", `Database migration ${row.migration_name} does not match this application build. The database was left unchanged.`);
    }
  }
  if (meta) {
    const metadataMigration = known.get(meta.schema_version);
    if (!metadataMigration) {
      throw new MigrationSafetyError("SCHEMA_TOO_NEW", "This database records a schema version that this Star Companion build does not support.");
    }
    if (meta.schema_checksum !== metadataMigration.checksum) {
      throw new MigrationSafetyError("CHECKSUM_MISMATCH", "The recorded database schema checksum does not match this application build. The database was left unchanged.");
    }
  }
  if (meta && compareVersions(meta.app_version, appVersion) > 0) {
    throw new MigrationSafetyError("APP_TOO_OLD", "This database belongs to a newer Star Companion version. Update the application before continuing.");
  }
  if (applied.length === 0 && hasUserDataSchema(db)) {
    throw new MigrationSafetyError("UNTRACKED_SCHEMA", "The database schema has no trusted migration history. Use a backup or a supported previous version to recover it before upgrading.");
  }
  return { applied, meta };
};

const createSafetyCopy = ({ databasePath, recoveryDirectory, previousAppVersion, previousSchemaVersion }) => {
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const databaseFile = path.join(recoveryDirectory, `${id}.db`);
  const source = new DatabaseSync(databasePath);
  try {
    checkIntegrity(source);
    source.exec(`VACUUM INTO '${databaseFile.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    reason: "before_schema_upgrade",
    previousAppVersion: previousAppVersion || null,
    previousSchemaVersion: previousSchemaVersion || null,
    databaseFile: path.basename(databaseFile),
    sizeBytes: fs.statSync(databaseFile).size
  };
  fs.writeFileSync(path.join(recoveryDirectory, `${id}.json`), JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });
  return { ...manifest, databaseFile };
};

const pruneSafetyCopies = (recoveryDirectory, limit = DEFAULT_RECOVERY_LIMIT) => {
  if (!fs.existsSync(recoveryDirectory)) return;
  const manifests = fs.readdirSync(recoveryDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, fullPath: path.join(recoveryDirectory, name), mtime: fs.statSync(path.join(recoveryDirectory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const stale of manifests.slice(limit)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(stale.fullPath, "utf8"));
      const databaseFile = path.join(recoveryDirectory, path.basename(manifest.databaseFile || ""));
      if (databaseFile !== recoveryDirectory && fs.existsSync(databaseFile)) fs.unlinkSync(databaseFile);
      fs.unlinkSync(stale.fullPath);
    } catch {
      // Unreadable recovery metadata is retained for manual inspection.
    }
  }
};

const runProtectedMigrations = ({ databasePath, migrationsDirectory, recoveryDirectory, appVersion, recoveryLimit = DEFAULT_RECOVERY_LIMIT }) => {
  const catalog = loadMigrationCatalog(migrationsDirectory);
  if (catalog.length === 0) throw new MigrationSafetyError("MIGRATION_CATALOG_EMPTY", "No database migrations are bundled with this application.");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const existed = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  let db = new DatabaseSync(databasePath);
  let state;
  try {
    checkIntegrity(db);
    state = validateCurrentState({ db, catalog, appVersion });
  } finally {
    db.close();
  }
  const appliedNames = new Set(state.applied.map((row) => row.migration_name));
  const pending = catalog.filter((migration) => !appliedNames.has(migration.name));
  const previousSchemaVersion = state.applied.at(-1)?.migration_name || state.meta?.schema_version || null;
  const previousAppVersion = state.meta?.app_version || null;
  let recovery = null;
  if (pending.length > 0 && existed) {
    recovery = createSafetyCopy({ databasePath, recoveryDirectory, previousAppVersion, previousSchemaVersion });
  }

  db = new DatabaseSync(databasePath);
  try {
    checkIntegrity(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      ensureMetadataTables(db);
      for (const migration of pending) {
        db.exec(migration.sql);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO "${MIGRATION_TABLE}" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)`).run(
          crypto.randomUUID(), migration.checksum, now, migration.name, now
        );
      }
      const latest = catalog.at(-1);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO "${META_TABLE}" (id, app_version, schema_version, schema_checksum, migration_status, previous_app_version, previous_schema_version, updated_at)
        VALUES (1, ?, ?, ?, 'ready', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET app_version=excluded.app_version, schema_version=excluded.schema_version, schema_checksum=excluded.schema_checksum,
        migration_status='ready', previous_app_version=excluded.previous_app_version, previous_schema_version=excluded.previous_schema_version, updated_at=excluded.updated_at`).run(
        appVersion, latest.name, latest.checksum, previousAppVersion, previousSchemaVersion, now
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
      throw new MigrationSafetyError("MIGRATION_FAILED", "The database upgrade failed and was rolled back. Your original data and the pre-upgrade recovery copy were preserved.", error);
    }
    checkIntegrity(db);
  } finally {
    db.close();
  }
  if (recovery) pruneSafetyCopies(recoveryDirectory, recoveryLimit);
  return {
    status: "ready",
    appVersion,
    schemaVersion: catalog.at(-1).name,
    previousAppVersion,
    previousSchemaVersion,
    appliedMigrations: pending.map((migration) => migration.name),
    recoveryCreated: Boolean(recovery),
    recoveryId: recovery?.id || null
  };
};

const restoreSafetyCopy = ({ databasePath, recoveryDirectory, recoveryId }) => {
  const manifestPath = path.join(recoveryDirectory, `${path.basename(recoveryId)}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const source = path.join(recoveryDirectory, path.basename(manifest.databaseFile));
  const temporary = `${databasePath}.restore-${crypto.randomUUID()}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  const db = new DatabaseSync(temporary);
  try { checkIntegrity(db); } finally { db.close(); }
  const displaced = `${databasePath}.before-restore-${crypto.randomUUID()}`;
  const displacedSidecars = [];
  try {
    if (fs.existsSync(databasePath)) fs.renameSync(databasePath, displaced);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        const target = `${displaced}${suffix}`;
        fs.renameSync(sidecar, target);
        displacedSidecars.push([sidecar, target]);
      }
    }
    fs.renameSync(temporary, databasePath);
    if (fs.existsSync(displaced)) fs.unlinkSync(displaced);
    for (const [, target] of displacedSidecars) if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (!fs.existsSync(databasePath) && fs.existsSync(displaced)) fs.renameSync(displaced, databasePath);
    for (const [sidecar, target] of displacedSidecars) if (!fs.existsSync(sidecar) && fs.existsSync(target)) fs.renameSync(target, sidecar);
    throw error;
  }
};

module.exports = {
  MigrationSafetyError,
  checkIntegrity,
  loadMigrationCatalog,
  restoreSafetyCopy,
  runProtectedMigrations
};
