import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseAppVersion(value) {
  const match = SEMVER_PATTERN.exec(String(value ?? ""));
  if (!match) {
    throw new Error("Application version must use semantic versioning (for example 1.2.3). ");
  }
  return {
    raw: String(value),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null
  };
}

export function compareAppVersions(left, right) {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

export function androidVersionCode(version) {
  const parsed = parseAppVersion(version);
  if (parsed.major > 1999 || parsed.minor > 999 || parsed.patch > 999) {
    throw new Error("Application version is too large for the Android versionCode strategy.");
  }
  return parsed.major * 1_000_000 + parsed.minor * 1_000 + parsed.patch;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function readMigrationCatalog(migrationsDirectory) {
  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const migrations = [];
  for (const name of entries) {
    const sql = await readFile(path.join(migrationsDirectory, name, "migration.sql"), "utf8");
    migrations.push({ name, checksum: sha256(sql), sql });
  }
  if (migrations.length === 0) throw new Error("No database migrations were found.");
  return migrations;
}

export function publicBuildInfo({ version, migrations, platform = "server", buildType = "development", commit = null }) {
  parseAppVersion(version);
  const latest = migrations.at(-1);
  if (!latest) throw new Error("No schema version is available.");
  return {
    appVersion: version,
    schemaVersion: latest.name,
    schemaChecksum: latest.checksum,
    platform,
    buildType,
    buildCommit: commit || null
  };
}
