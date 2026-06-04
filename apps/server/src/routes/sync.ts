import { Router } from "express";
import { networkInterfaces } from "node:os";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { serverConfig } from "../config.js";
import { backupImportSchema, lanSyncRequestSchema } from "../schemas.js";
import { exportBackup, importBackup } from "../services/backups.js";
import type { z } from "zod";

export const syncRouter = Router();

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
type BackupImportData = z.infer<typeof backupImportSchema>;
type BackupImportSummary = Awaited<ReturnType<typeof importBackup>>;

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

const requestPeer = async <T>(
  peerBaseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${peerBaseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      },
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

    if (!response.ok || !payload?.ok) {
      const message = payload && "error" in payload ? payload.error : response.statusText;
      throw new HttpError(response.ok ? 502 : response.status, message || "Peer request failed");
    }

    return payload.data;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Peer request timed out.");
    }
    throw new HttpError(
      502,
      error instanceof Error ? `Peer request failed: ${error.message}` : "Peer request failed"
    );
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
    const peerBackup = await requestPeer<BackupImportData>(peerBaseUrl, "/api/backups/export");
    const backup = parseBody(backupImportSchema, { ...peerBackup, mode: input.mode });
    const summary = await importBackup(backup);

    response.json({
      ok: true,
      data: {
        direction: "pull",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: peerBackup.exportedAt ?? null,
        completedAt: new Date().toISOString(),
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
    const summary = await requestPeer<BackupImportSummary>(peerBaseUrl, "/api/backups/import", {
      method: "POST",
      body: JSON.stringify({ ...localBackup, mode: input.mode })
    });

    response.json({
      ok: true,
      data: {
        direction: "push",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: null,
        completedAt: new Date().toISOString(),
        summary
      }
    });
  })
);
