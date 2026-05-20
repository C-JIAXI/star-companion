import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, requireParam } from "../lib/http.js";
import {
  lorebookCreateSchema,
  lorebookUpdateSchema,
  loreEntryCreateSchema,
  loreEntryUpdateSchema
} from "../schemas.js";
import {
  serializeLorebook,
  serializeLorebookWithEntries,
  serializeLoreEntry
} from "../serializers.js";

export const lorebooksRouter = Router();

lorebooksRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const lorebooks = await prisma.lorebook.findMany({
      orderBy: { updatedAt: "desc" }
    });

    response.json({ ok: true, data: lorebooks.map(serializeLorebook) });
  })
);

lorebooksRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(lorebookCreateSchema, request.body);
    const lorebook = await prisma.lorebook.create({ data: body });

    response.status(201).json({ ok: true, data: serializeLorebook(lorebook) });
  })
);

lorebooksRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const lorebook = await prisma.lorebook.findUnique({
      where: { id },
      include: { entries: { orderBy: [{ priority: "desc" }, { updatedAt: "desc" }] } }
    });

    if (!lorebook) {
      throw new HttpError(404, "Lorebook not found");
    }

    response.json({ ok: true, data: serializeLorebookWithEntries(lorebook) });
  })
);

lorebooksRouter.put(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(lorebookUpdateSchema, request.body);

    const lorebook = await prisma.lorebook.update({
      where: { id },
      data: body
    });

    response.json({ ok: true, data: serializeLorebook(lorebook) });
  })
);

lorebooksRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    await prisma.lorebook.delete({ where: { id } });

    response.status(204).send();
  })
);

lorebooksRouter.get(
  "/:lorebookId/entries",
  asyncHandler(async (request, response) => {
    const lorebookId = requireParam(request, "lorebookId");
    const entries = await prisma.loreEntry.findMany({
      where: { lorebookId },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: entries.map(serializeLoreEntry) });
  })
);

lorebooksRouter.post(
  "/:lorebookId/entries",
  asyncHandler(async (request, response) => {
    const lorebookId = requireParam(request, "lorebookId");
    const body = parseBody(loreEntryCreateSchema, request.body);

    const entry = await prisma.loreEntry.create({
      data: {
        ...body,
        lorebookId
      }
    });

    await prisma.lorebook.update({
      where: { id: lorebookId },
      data: { updatedAt: new Date() }
    });

    response.status(201).json({ ok: true, data: serializeLoreEntry(entry) });
  })
);

lorebooksRouter.get(
  "/entries/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const entry = await prisma.loreEntry.findUnique({ where: { id } });

    if (!entry) {
      throw new HttpError(404, "Lore entry not found");
    }

    response.json({ ok: true, data: serializeLoreEntry(entry) });
  })
);

lorebooksRouter.put(
  "/entries/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(loreEntryUpdateSchema, request.body);

    const entry = await prisma.loreEntry.update({
      where: { id },
      data: body
    });

    await prisma.lorebook.update({
      where: { id: entry.lorebookId },
      data: { updatedAt: new Date() }
    });

    response.json({ ok: true, data: serializeLoreEntry(entry) });
  })
);

lorebooksRouter.delete(
  "/entries/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const entry = await prisma.loreEntry.delete({ where: { id } });

    await prisma.lorebook.update({
      where: { id: entry.lorebookId },
      data: { updatedAt: new Date() }
    });

    response.status(204).send();
  })
);
