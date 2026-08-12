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
import { deleteMessageTimeline } from "../services/messageTimeline.js";

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

const normalizeJsonArray = <T>(value: T[] | null | undefined) =>
  value === null ? Prisma.JsonNull : value;

const normalizeJsonObject = <T extends object>(value: T | null | undefined) =>
  value === null ? Prisma.JsonNull : value;

messagesRouter.get(
  "/",
  asyncHandler(async (request, response) => {
    const query = parseQuery(messageListQuerySchema, request.query);
    const messages = await prisma.message.findMany({
      where: {
        chat: { deletedAt: null },
        ...(query.chatId ? { chatId: query.chatId } : {})
      },
      orderBy: { createdAt: "asc" }
    });

    response.json({ ok: true, data: messages.map(serializeMessage) });
  })
);

messagesRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageCreateSchema, request.body);
    const chat = await prisma.chat.findFirst({
      where: { id: body.chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }
    const data: Prisma.MessageUncheckedCreateInput = {
      ...body,
      tokenUsage: normalizeTokenUsage(body.tokenUsage),
      generationMetadata: normalizeJsonObject(body.generationMetadata),
      variantMetadata: body.variantMetadata as Prisma.InputJsonValue,
      promptBreakdown: normalizeJsonObject(body.promptBreakdown),
      loreMatches: normalizeJsonArray(body.loreMatches),
      memoryMatches: normalizeJsonArray(body.memoryMatches)
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
    const message = await prisma.message.findFirst({
      where: { id, chat: { deletedAt: null } }
    });

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
    const existing = await prisma.message.findFirst({
      where: { id, chat: { deletedAt: null } },
      select: { id: true }
    });
    if (!existing) {
      throw new HttpError(404, "Message not found");
    }
    const data: Prisma.MessageUncheckedUpdateInput = {
      ...body,
      tokenUsage: normalizeTokenUsage(body.tokenUsage),
      generationMetadata: normalizeJsonObject(body.generationMetadata),
      variantMetadata: body.variantMetadata as Prisma.InputJsonValue | undefined,
      promptBreakdown: normalizeJsonObject(body.promptBreakdown),
      loreMatches: normalizeJsonArray(body.loreMatches),
      memoryMatches: normalizeJsonArray(body.memoryMatches)
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
  "/:id/timeline",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const result = await deleteMessageTimeline(id);

    response.json({ ok: true, data: result });
  })
);

messagesRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    await deleteMessageTimeline(id);
    response.status(204).send();
  })
);
