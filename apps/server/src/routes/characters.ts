import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, requireParam } from "../lib/http.js";
import { characterCreateSchema, characterUpdateSchema } from "../schemas.js";
import { serializeCharacter } from "../serializers.js";

export const charactersRouter = Router();

charactersRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const characters = await prisma.character.findMany({
      orderBy: { updatedAt: "desc" }
    });

    response.json({ ok: true, data: characters.map(serializeCharacter) });
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
    const body = parseBody(characterUpdateSchema, request.body);

    const character = await prisma.character.update({
      where: { id },
      data: body
    });

    response.json({ ok: true, data: serializeCharacter(character) });
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
