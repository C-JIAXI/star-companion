import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, requireParam } from "../lib/http.js";
import { chatCreateSchema, chatUpdateSchema } from "../schemas.js";
import { serializeChat, serializeMessage } from "../serializers.js";
import { createInitialCharacterMessages } from "../services/promptBuilder.js";

export const chatsRouter = Router();

chatsRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const chats = await prisma.chat.findMany({
      orderBy: { updatedAt: "desc" }
    });

    response.json({ ok: true, data: chats.map(serializeChat) });
  })
);

chatsRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatCreateSchema, request.body);
    const chat = await prisma.chat.create({ data: body });
    await createInitialCharacterMessages(chat.id, body.characterIds);

    response.status(201).json({ ok: true, data: serializeChat(chat) });
  })
);

chatsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const chat = await prisma.chat.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } }
    });

    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    response.json({
      ok: true,
      data: {
        ...serializeChat(chat),
        messages: chat.messages.map(serializeMessage)
      }
    });
  })
);

chatsRouter.put(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(chatUpdateSchema, request.body);

    const chat = await prisma.chat.update({
      where: { id },
      data: body
    });

    response.json({ ok: true, data: serializeChat(chat) });
  })
);

chatsRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    await prisma.chat.delete({ where: { id } });

    response.status(204).send();
  })
);
