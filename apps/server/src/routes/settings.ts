import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { testModelConnection } from "../services/openaiCompatible.js";
import { settingsUpdateSchema } from "../schemas.js";
import { serializeSettings } from "../serializers.js";
import { encryptApiKey, hasStoredApiKey } from "../services/apiKeyVault.js";

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
        hasApiKey: hasStoredApiKey(settings.apiKey)
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
    const data: Prisma.UserSettingsUpdateInput = {
      activeProvider: body.activeProvider,
      apiBaseUrl: body.apiBaseUrl,
      model: body.model,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      apiKey: "apiKey" in body ? encryptApiKey(body.apiKey) : undefined
    };

    const settings = await prisma.userSettings.update({
      where: { id: existing.id },
      data
    });

    response.json({
      ok: true,
      data: {
        ...serializeSettings(settings),
        hasApiKey: hasStoredApiKey(settings.apiKey)
      }
    });
  })
);
