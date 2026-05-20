import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { testModelConnection } from "../services/openaiCompatible.js";
import { settingsUpdateSchema } from "../schemas.js";
import { serializeSettings } from "../serializers.js";

export const settingsRouter = Router();

export const getOrCreateSettings = async () => {
  const existing = await prisma.userSettings.findFirst({
    orderBy: { createdAt: "asc" }
  });

  if (existing) {
    return existing;
  }

  return prisma.userSettings.create({ data: {} });
};

settingsRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: Boolean(settings.apiKey)
      }
    });
  })
);

settingsRouter.post(
  "/test",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();
    const result = await testModelConnection(settings);

    response.json({
      ok: true,
      data: result
    });
  })
);

settingsRouter.put(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const existing = await getOrCreateSettings();

    const settings = await prisma.userSettings.update({
      where: { id: existing.id },
      data: body
    });

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: Boolean(settings.apiKey)
      }
    });
  })
);
