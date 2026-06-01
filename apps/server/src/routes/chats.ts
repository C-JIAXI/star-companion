import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, requireParam } from "../lib/http.js";
import {
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMemoryUpdateSchema,
  chatUpdateSchema
} from "../schemas.js";
import { serializeChat, serializeChatMemory, serializeMessage } from "../serializers.js";
import { updateChatMemoriesFromTurn } from "../services/chatMemories.js";
import { getOrCreateSettings } from "./settings.js";

export const chatsRouter = Router();

chatsRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const chats = await prisma.chat.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { messages: true } } }
    });

    response.json({ ok: true, data: chats.map((chat) => serializeChat(chat, chat._count.messages)) });
  })
);

chatsRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatCreateSchema, request.body);
    const chat = await prisma.chat.create({ data: body });

    response.status(201).json({ ok: true, data: serializeChat(chat) });
  })
);

chatsRouter.get(
  "/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.post(
  "/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatMemoryCreateSchema, request.body);
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const memory = await prisma.chatMemory.create({
      data: {
        ...body,
        chatId
      }
    });

    response.status(201).json({ ok: true, data: serializeChatMemory(memory) });
  })
);

chatsRouter.put(
  "/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const memoryId = requireParam(request, "memoryId");
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const existing = await prisma.chatMemory.findFirst({ where: { id: memoryId, chatId } });
    if (!existing) {
      throw new HttpError(404, "Memory not found");
    }

    const memory = await prisma.chatMemory.update({
      where: { id: memoryId },
      data: body
    });

    response.json({ ok: true, data: serializeChatMemory(memory) });
  })
);

chatsRouter.delete(
  "/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const memoryId = requireParam(request, "memoryId");
    const existing = await prisma.chatMemory.findFirst({ where: { id: memoryId, chatId } });
    if (!existing) {
      throw new HttpError(404, "Memory not found");
    }

    await prisma.chatMemory.delete({ where: { id: memoryId } });
    response.status(204).send();
  })
);

chatsRouter.post(
  "/:id/memories/refresh",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const settings = await getOrCreateSettings();
    await updateChatMemoriesFromTurn({ chatId, settings });
    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const chat = await prisma.chat.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
      }
    });

    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    response.json({
      ok: true,
      data: {
        ...serializeChat(chat),
        messages: chat.messages.map(serializeMessage),
        memories: chat.memories.map(serializeChatMemory)
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
      data: body,
      include: { _count: { select: { messages: true } } }
    });

    response.json({ ok: true, data: serializeChat(chat, chat._count.messages) });
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
