import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { webSearchConfigSchema } from "../schemas.js";
import { decryptApiKey, encryptApiKey } from "../services/apiKeyVault.js";

export const webSearchRouter = Router();

export const getDesktopWebSearchKey = async () => {
  const row = await prisma.webSearchConfig.findUnique({ where: { id: "default" } });
  return decryptApiKey(row?.apiKeyEncrypted);
};

webSearchRouter.get("/", asyncHandler(async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: { hasApiKey: Boolean(await getDesktopWebSearchKey()) } });
}));

webSearchRouter.put("/", asyncHandler(async (request, response) => {
  const { apiKey } = parseBody(webSearchConfigSchema, request.body);
  const encrypted = encryptApiKey(apiKey);
  await prisma.webSearchConfig.upsert({ where: { id: "default" }, create: { id: "default", apiKeyEncrypted: encrypted },
    update: { apiKeyEncrypted: encrypted } });
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: { hasApiKey: Boolean(encrypted) } });
}));
