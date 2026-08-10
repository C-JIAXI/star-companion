import { generatedBuildInfo } from "../generated/buildInfo.js";

type AppPlatform = "web" | "windows" | "android" | "server";
type AppBuildType = "development" | "preview" | "release";
type DatabaseMigrationStatus = "ready" | "upgraded" | "failed" | "too_new" | "unknown";
interface AppInfoDTO {
  appVersion: string;
  schemaVersion: string;
  schemaChecksum: string;
  platform: AppPlatform;
  buildType: AppBuildType;
  buildCommit: string | null;
  migration: {
    status: DatabaseMigrationStatus;
    previousAppVersion: string | null;
    previousSchemaVersion: string | null;
    appliedCount: number;
    recoveryCreated: boolean;
  };
  update: { capability: "desktop" | "external_store" | "disabled"; externalUrl: string | null };
}

const platforms = new Set<AppPlatform>(["web", "windows", "android", "server"]);
const buildTypes = new Set<AppBuildType>(["development", "preview", "release"]);
const migrationStatuses = new Set<DatabaseMigrationStatus>(["ready", "upgraded", "failed", "too_new", "unknown"]);

interface SafeMigrationReport {
  status?: unknown;
  previousAppVersion?: unknown;
  previousSchemaVersion?: unknown;
  appliedMigrations?: unknown;
  recoveryCreated?: unknown;
}

const parseMigrationReport = (value: string | undefined): SafeMigrationReport => {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as SafeMigrationReport : {};
  } catch {
    return {};
  }
};

const safeCommit = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed.slice(0, 12) : null;
};

const safeExternalUrl = (value: string | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

export const getAppInfo = (environment: NodeJS.ProcessEnv = process.env): AppInfoDTO => {
  const platformCandidate = environment.STAR_COMPANION_PLATFORM as AppPlatform | undefined;
  const buildTypeCandidate = environment.STAR_COMPANION_BUILD_TYPE as AppBuildType | undefined;
  const report = parseMigrationReport(environment.STAR_COMPANION_MIGRATION_REPORT);
  const statusCandidate = report.status as DatabaseMigrationStatus | undefined;
  const platform = platformCandidate && platforms.has(platformCandidate) ? platformCandidate : "server";
  const externalUrl = safeExternalUrl(environment.STAR_COMPANION_ANDROID_STORE_URL);
  return {
    appVersion: environment.STAR_COMPANION_APP_VERSION || generatedBuildInfo.appVersion,
    schemaVersion: generatedBuildInfo.schemaVersion,
    schemaChecksum: generatedBuildInfo.schemaChecksum,
    platform,
    buildType: buildTypeCandidate && buildTypes.has(buildTypeCandidate)
      ? buildTypeCandidate
      : environment.NODE_ENV === "production" ? "release" : "development",
    buildCommit: safeCommit(environment.STAR_COMPANION_BUILD_COMMIT || environment.GITHUB_SHA),
    migration: {
      status: statusCandidate && migrationStatuses.has(statusCandidate) ? statusCandidate : "unknown",
      previousAppVersion: typeof report.previousAppVersion === "string" ? report.previousAppVersion : null,
      previousSchemaVersion: typeof report.previousSchemaVersion === "string" ? report.previousSchemaVersion : null,
      appliedCount: Array.isArray(report.appliedMigrations) ? report.appliedMigrations.length : 0,
      recoveryCreated: report.recoveryCreated === true
    },
    update: {
      capability: platform === "windows" ? "desktop" : platform === "android" && externalUrl ? "external_store" : "disabled",
      externalUrl
    }
  };
};

export const createSafeDiagnostics = (info: AppInfoDTO) => JSON.stringify({
  product: "Star Companion",
  appVersion: info.appVersion,
  schemaVersion: info.schemaVersion,
  schemaChecksum: info.schemaChecksum,
  platform: info.platform,
  buildType: info.buildType,
  buildCommit: info.buildCommit,
  migration: info.migration,
  updateCapability: info.update.capability
}, null, 2);
