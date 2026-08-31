import { Router } from "express";
import { networkInterfaces } from "node:os";
import { asyncHandler, parseBody } from "../lib/http.js";
import { serverConfig } from "../config.js";
import { lanAutoSyncSettingsSchema, lanSyncRequestSchema } from "../schemas.js";
import { pullLanSync, pushLanSync } from "../services/lanSync.js";
import { getLanAutoSyncStatus, rememberLanSyncPeer, runAutomaticLanSync, updateLanAutoSyncSettings } from "../services/lanAutoSync.js";

export const syncRouter = Router();

syncRouter.get("/auto", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await getLanAutoSyncStatus() });
}));

syncRouter.put("/auto", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await updateLanAutoSyncSettings(parseBody(lanAutoSyncSettingsSchema, request.body)) });
}));

syncRouter.post("/auto/run", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await runAutomaticLanSync() });
}));

const getLanHosts = () =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index);

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
    const result = await pullLanSync(parseBody(lanSyncRequestSchema, request.body));
    if (result.phase === "execute") await rememberLanSyncPeer(result.peerBaseUrl, result.completedAt);
    response.json({ ok: true, data: result });
  })
);

syncRouter.post(
  "/push",
  asyncHandler(async (request, response) => {
    const result = await pushLanSync(parseBody(lanSyncRequestSchema, request.body));
    if (result.phase === "execute") await rememberLanSyncPeer(result.peerBaseUrl, result.completedAt);
    response.json({ ok: true, data: result });
  })
);
