import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  asyncHandler,
  HttpError,
  parseBody,
  parseQuery,
  requireParam
} from "../lib/http.js";
import { messageCreateSchema, messageListQuerySchema, messageUpdateSchema } from "../schemas.js";
import { serializeMessage } from "../serializers.js";

export const messagesRouter = Router();

const normalizeTokenUsage = (
  tokenUsage:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimated: boolean;
      }
    | null
    | undefined
) => (tokenUsage === null ? Prisma.JsonNull : tokenUsage);

messagesRouter.get(
  "/",
  asyncHandler(async (request, response) => {
    const query = parseQuery(messageListQuerySchema, request.query);
    const messages = await prisma.message.findMany({
      where: query.chatId ? { chatId: query.chatId } : undefined,
      orderBy: { createdAt: "asc" }
    });

    response.json({ ok: true, data: messages.map(serializeMessage) });
  })
);

messagesRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageCreateSchema, request.body);
    const data: Prisma.MessageUncheckedCreateInput = {
      ...body,
      tokenUsage: normalizeTokenUsage(body.tokenUsage)
    };
    const message = await prisma.message.create({ data });

    await prisma.chat.update({
      where: { id: body.chatId },
      data: { updatedAt: new Date() }
    });

    response.status(201).json({ ok: true, data: serializeMessage(message) });
  })
);

messagesRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const message = await prisma.message.findUnique({ where: { id } });

    if (!message) {
      throw new HttpError(404, "Message not found");
    }

    response.json({ ok: true, data: serializeMessage(message) });
  })
);

messagesRouter.put(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(messageUpdateSchema, request.body);
    const data: Prisma.MessageUncheckedUpdateInput = {
      ...body,
      tokenUsage: normalizeTokenUsage(body.tokenUsage)
    };

    const message = await prisma.message.update({
      where: { id },
      data
    });

    await prisma.chat.update({
      where: { id: message.chatId },
      data: { updatedAt: new Date() }
    });

    response.json({ ok: true, data: serializeMessage(message) });
  })
);

messagesRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const message = await prisma.message.delete({ where: { id } });

    await prisma.chat.update({
      where: { id: message.chatId },
      data: { updatedAt: new Date() }
    });

    response.status(204).send();
  })
);
