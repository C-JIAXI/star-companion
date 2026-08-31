import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../lib/http.js";
import { isPrivacyLocked } from "./privacyLock.js";
import { normalizePeerBaseUrl, pullLanSync } from "./lanSync.js";

type StoredAutoSync = {
  version: 1;
  enabled: boolean;
  lastPeerBaseUrl: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
};

type LanAutoSyncStatus = {
  enabled: boolean;
  lastPeerBaseUrl: string;
  state: "disabled" | "idle" | "running" | "succeeded" | "conflicts" | "failed";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  conflictCount: number;
  errorCode: string | null;
  message: string | null;
};

const defaults = (): StoredAutoSync => ({ version: 1, enabled: false, lastPeerBaseUrl: "", lastAttemptAt: null, lastSuccessAt: null });
let loaded: StoredAutoSync | null = null;
let runtime: Pick<LanAutoSyncStatus, "state" | "conflictCount" | "errorCode" | "message"> = {
  state: "disabled", conflictCount: 0, errorCode: null, message: null
};
let activeRun: Promise<LanAutoSyncStatus> | null = null;

const databaseDirectory = () => {
  const value = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!value.startsWith("file:")) return process.cwd();
  const raw = decodeURIComponent(value.slice(5).split("?")[0]);
  const databasePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), "prisma", raw);
  return path.dirname(databasePath);
};
const configPath = () => path.join(path.resolve(process.env.STAR_COMPANION_DATA_DIR?.trim() || databaseDirectory()), "lan-auto-sync.json");

const load = async () => {
  if (loaded) return loaded;
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as Partial<StoredAutoSync>;
    loaded = {
      version: 1,
      enabled: parsed.enabled === true,
      lastPeerBaseUrl: typeof parsed.lastPeerBaseUrl === "string" ? parsed.lastPeerBaseUrl : "",
      lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null
    };
  } catch { loaded = defaults(); }
  runtime.state = loaded.enabled ? "idle" : "disabled";
  return loaded;
};

const persist = async (value: StoredAutoSync) => {
  const target = configPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
  loaded = value;
};

const status = (value: StoredAutoSync): LanAutoSyncStatus => ({
  enabled: value.enabled,
  lastPeerBaseUrl: value.lastPeerBaseUrl,
  state: value.enabled ? runtime.state : "disabled",
  lastAttemptAt: value.lastAttemptAt,
  lastSuccessAt: value.lastSuccessAt,
  conflictCount: runtime.conflictCount,
  errorCode: runtime.errorCode,
  message: runtime.message
});

export const getLanAutoSyncStatus = async () => status(await load());

export const updateLanAutoSyncSettings = async ({ enabled, peerBaseUrl }: { enabled: boolean; peerBaseUrl?: string }) => {
  const current = await load();
  const normalizedPeer = peerBaseUrl?.trim() ? normalizePeerBaseUrl(peerBaseUrl) : current.lastPeerBaseUrl;
  if (enabled && !normalizedPeer) throw new HttpError(400, "Connect to a LAN peer before enabling automatic sync.");
  const next = { ...current, enabled, lastPeerBaseUrl: normalizedPeer };
  runtime = { state: enabled ? "idle" : "disabled", conflictCount: 0, errorCode: null, message: null };
  await persist(next);
  return status(next);
};

export const rememberLanSyncPeer = async (peerBaseUrl: string, completedAt?: string | null) => {
  const current = await load();
  const next = {
    ...current,
    lastPeerBaseUrl: normalizePeerBaseUrl(peerBaseUrl),
    ...(completedAt ? { lastSuccessAt: completedAt } : {})
  };
  await persist(next);
  return status(next);
};

type AutomaticPullResult =
  | { state: "failed"; conflictCount: number; errorCode: "preview_blocked"; message: string; completedAt: null }
  | { state: "conflicts"; conflictCount: number; errorCode: null; message: string; completedAt: null }
  | { state: "succeeded"; conflictCount: 0; errorCode: null; message: string; completedAt: string };

export const performAutomaticPull = async (
  peerBaseUrl: string,
  pull: typeof pullLanSync = pullLanSync
): Promise<AutomaticPullResult> => {
  const preview = await pull({ peerBaseUrl, mode: "merge", phase: "preview", conflictResolutions: [] });
  if (!preview.preview.canExecute) {
    return { state: "failed", conflictCount: preview.preview.conflicts.length, errorCode: "preview_blocked", message: "Automatic sync preview found invalid or incompatible data. Review it manually.", completedAt: null };
  }
  if (preview.preview.conflicts.length) {
    return { state: "conflicts", conflictCount: preview.preview.conflicts.length, errorCode: null, message: "Automatic sync paused because conflicts require your choice.", completedAt: null };
  }
  const result = await pull({ peerBaseUrl, mode: "merge", phase: "execute", previewId: preview.preview.previewId, conflictResolutions: [] });
  return { state: "succeeded", conflictCount: 0, errorCode: null, message: "Automatic LAN sync completed.", completedAt: result.completedAt ?? new Date().toISOString() };
};

export const runAutomaticLanSync = async () => {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    let current = await load();
    if (!current.enabled) return status(current);
    if (!current.lastPeerBaseUrl) throw new HttpError(409, "No previous LAN peer is available for automatic sync.");
    if (isPrivacyLocked()) throw new HttpError(423, "Unlock the app before automatic sync can run.");
    const attemptedAt = new Date().toISOString();
    current = { ...current, lastAttemptAt: attemptedAt };
    await persist(current);
    runtime = { state: "running", conflictCount: 0, errorCode: null, message: null };
    try {
      const result = await performAutomaticPull(current.lastPeerBaseUrl);
      runtime = { state: result.state, conflictCount: result.conflictCount, errorCode: result.errorCode, message: result.message };
      if (result.completedAt) {
        current = { ...current, lastSuccessAt: result.completedAt };
        await persist(current);
      }
      return status(current);
    } catch (error) {
      runtime = {
        state: "failed",
        conflictCount: 0,
        errorCode: error instanceof HttpError && error.status === 504 ? "peer_timeout" : "peer_unreachable",
        message: "Automatic sync could not reach the previous peer. Your local data was not changed."
      };
      return status(current);
    }
  })().finally(() => { activeRun = null; });
  return activeRun;
};
