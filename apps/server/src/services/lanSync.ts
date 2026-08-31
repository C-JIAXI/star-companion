import type { z } from "zod";
import { HttpError } from "../lib/http.js";
import { backupExecuteSchema, backupPreviewRequestSchema, type lanSyncRequestSchema } from "../schemas.js";
import { exportBackup, importBackup, previewBackup } from "./backups.js";

type LanSyncInput = z.infer<typeof lanSyncRequestSchema>;
type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

export const normalizePeerBaseUrl = (raw: string) => {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try { url = new URL(withProtocol); }
  catch { throw new HttpError(400, "Peer address must be a valid http(s) URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "Peer address must use http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
};

const LAN_DEFAULT_TIMEOUT_MS = 15_000;
const LAN_PREVIEW_TIMEOUT_MS = 3 * 60_000;
const LAN_EXECUTE_TIMEOUT_MS = 10 * 60_000;

export const requestLanPeer = async <T>(peerBaseUrl: string, path: string, options: RequestInit = {}, timeoutMs = LAN_DEFAULT_TIMEOUT_MS): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${peerBaseUrl}${path}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!response.ok || !payload?.ok) {
      const message = payload && "error" in payload ? payload.error : response.statusText;
      throw new HttpError(response.ok ? 502 : response.status, message || "Peer request failed");
    }
    return payload.data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new HttpError(504, "Peer request timed out.");
    throw new HttpError(502, "The peer could not be reached. Check its address and try again.");
  } finally { clearTimeout(timeout); }
};

export const pullLanSync = async (input: LanSyncInput) => {
  const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
  const peerBackup = await requestLanPeer<Record<string, unknown>>(peerBaseUrl, "/api/backups/export", {}, LAN_PREVIEW_TIMEOUT_MS);
  const candidate = backupPreviewRequestSchema.parse({ ...peerBackup, mode: input.mode });
  const preview = await previewBackup(candidate);
  const summary = input.phase === "execute"
    ? await importBackup(backupExecuteSchema.parse({ ...candidate, previewId: input.previewId, conflictResolutions: input.conflictResolutions }))
    : null;
  return { direction: "pull" as const, phase: input.phase, mode: input.mode, peerBaseUrl, peerExportedAt: typeof peerBackup.exportedAt === "string" ? peerBackup.exportedAt : null, completedAt: summary?.completedAt ?? null, preview, summary };
};

export const pushLanSync = async (input: LanSyncInput) => {
  const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
  const localBackup = await exportBackup();
  const preview = await requestLanPeer<Awaited<ReturnType<typeof previewBackup>>>(peerBaseUrl, "/api/backups/preview", {
    method: "POST", body: JSON.stringify({ ...localBackup, mode: input.mode })
  }, LAN_PREVIEW_TIMEOUT_MS);
  const summary = input.phase === "execute"
    ? await requestLanPeer<Awaited<ReturnType<typeof importBackup>>>(peerBaseUrl, "/api/backups/import", {
        method: "POST",
        body: JSON.stringify({ ...localBackup, mode: input.mode, previewId: input.previewId, conflictResolutions: input.conflictResolutions })
      }, LAN_EXECUTE_TIMEOUT_MS)
    : null;
  return { direction: "push" as const, phase: input.phase, mode: input.mode, peerBaseUrl, peerExportedAt: null, completedAt: summary?.completedAt ?? null, preview, summary };
};
