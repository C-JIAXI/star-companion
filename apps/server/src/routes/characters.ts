import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, parseQuery, requireParam } from "../lib/http.js";
import {
  characterCreateSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUnlockSchema,
  characterUpdateRequestSchema
} from "../schemas.js";
import { serializeCharacter } from "../serializers.js";
import { listCharactersPage } from "../services/characterPaging.js";
import {
  assertCharacterUnlockPassword,
  buildCharacterUpdateData,
  canExportCharacterPublicly,
  createCharacterExportCard,
  importCharacterCard,
  reEncryptImportedCharacter
} from "../services/characterCards.js";

export const charactersRouter = Router();

charactersRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const characters = await prisma.character.findMany({
      orderBy: { updatedAt: "desc" }
    });

    response.json({ ok: true, data: characters.map((character) => serializeCharacter(character)) });
  })
);

charactersRouter.get(
  "/page",
  asyncHandler(async (request, response) => {
    const query = parseQuery(characterPageQuerySchema, request.query);
    const page = await listCharactersPage(query);

    response.json({ ok: true, data: page });
  })
);

charactersRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterCreateSchema, request.body);
    const character = await prisma.character.create({ data: body });

    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

charactersRouter.post(
  "/import",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterImportSchema, request.body);
    const character = await prisma.character.create({
      data: importCharacterCard(body)
    });

    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

charactersRouter.post(
  "/:id/export",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(characterExportSchema, request.body);
    const character = await prisma.character.findUnique({ where: { id } });

    if (!character) {
      throw new HttpError(404, "Character not found");
    }

    if (body.visibility === "public" && !canExportCharacterPublicly(character, body.password)) {
      throw new HttpError(403, "Private character password is required to export this character publicly");
    }

    response.json({
      ok: true,
      data: createCharacterExportCard(character, body.visibility, body.password)
    });
  })
);

charactersRouter.post(
  "/:id/unlock",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(characterUnlockSchema, request.body);
    const character = await prisma.character.findUnique({ where: { id } });

    if (!character) {
      throw new HttpError(404, "Character not found");
    }

    assertCharacterUnlockPassword(character, body.password);

    const loreEntries = character.loreEntries as Record<string, unknown> | null;
    const privateData = loreEntries?.__privateCharacter as Record<string, unknown> | undefined;
    const isImportedCard = Boolean(privateData?.exportSalt);

    if (isImportedCard) {
      const reEncrypted = reEncryptImportedCharacter(character, body.password);
      const updated = await prisma.character.update({
        where: { id },
        data: { loreEntries: reEncrypted }
      });
      response.json({ ok: true, data: serializeCharacter(updated, body.password) });
      return;
    }

    response.json({
      ok: true,
      data: serializeCharacter(character, body.password)
    });
  })
);

charactersRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const character = await prisma.character.findUnique({ where: { id } });

    if (!character) {
      throw new HttpError(404, "Character not found");
    }

    response.json({ ok: true, data: serializeCharacter(character) });
  })
);

charactersRouter.put(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(characterUpdateRequestSchema, request.body);
    const existing = await prisma.character.findUnique({ where: { id } });

    if (!existing) {
      throw new HttpError(404, "Character not found");
    }

    const { accessPassword, ...updates } = body;

    const character = await prisma.character.update({
      where: { id },
      data: buildCharacterUpdateData(existing, updates, accessPassword)
    });

    response.json({ ok: true, data: serializeCharacter(character, accessPassword) });
  })
);

charactersRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    await prisma.character.delete({ where: { id } });

    response.status(204).send();
  })
);
