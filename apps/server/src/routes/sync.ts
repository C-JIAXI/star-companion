import { Router } from "express";
import { networkInterfaces } from "node:os";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { serverConfig } from "../config.js";
import { backupExecuteSchema, backupPreviewRequestSchema, lanSyncRequestSchema } from "../schemas.js";
import { exportBackup, importBackup, previewBackup } from "../services/backups.js";

export const syncRouter = Router();

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

const getLanHosts = () =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index);

const normalizePeerBaseUrl = (raw: string) => {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new HttpError(400, "Peer address must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Peer address must use http or https.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
};

const requestPeer = async <T>(peerBaseUrl: string, path: string, options: RequestInit = {}): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
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
  } finally {
    clearTimeout(timeout);
  }
};

syncRouter.get(
  "/info",
  asyncHandler(async (request, response) => {
    const port = serverConfig.port;
    const localUrl = `http://127.0.0.1:${port}`;
    const lanUrls = getLanHosts().map((host) => `http://${host}:${port}`);
    response.json({
      ok: true,
      data: {
        localUrl,
        lanUrls,
        currentOrigin: `${request.protocol}://${request.get("host") ?? `127.0.0.1:${port}`}`,
        port,
        listeningHost: "0.0.0.0",
        lanReachable: lanUrls.length > 0,
        checkedAt: new Date().toISOString()
      }
    });
  })
);

syncRouter.post(
  "/pull",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const peerBackup = await requestPeer<Record<string, unknown>>(peerBaseUrl, "/api/backups/export");
    const candidate = parseBody(backupPreviewRequestSchema, { ...peerBackup, mode: input.mode });
    const preview = await previewBackup(candidate);
    const summary = input.phase === "execute"
      ? await importBackup(parseBody(backupExecuteSchema, {
          ...candidate,
          previewId: input.previewId,
          conflictResolutions: input.conflictResolutions
        }))
      : null;
    response.json({
      ok: true,
      data: {
        direction: "pull",
        phase: input.phase,
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: typeof peerBackup.exportedAt === "string" ? peerBackup.exportedAt : null,
        completedAt: summary?.completedAt ?? null,
        preview,
        summary
      }
    });
  })
);

syncRouter.post(
  "/push",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const localBackup = await exportBackup();
    const preview = await requestPeer<Awaited<ReturnType<typeof previewBackup>>>(peerBaseUrl, "/api/backups/preview", {
      method: "POST",
      body: JSON.stringify({ ...localBackup, mode: input.mode })
    });
    const summary = input.phase === "execute"
      ? await requestPeer<Awaited<ReturnType<typeof importBackup>>>(peerBaseUrl, "/api/backups/import", {
          method: "POST",
          body: JSON.stringify({
            ...localBackup,
            mode: input.mode,
            previewId: input.previewId,
            conflictResolutions: input.conflictResolutions
          })
        })
      : null;
    response.json({
      ok: true,
      data: {
        direction: "push",
        phase: input.phase,
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: null,
        completedAt: summary?.completedAt ?? null,
        preview,
        summary
      }
    });
  })
);
