import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { serializeChatMemory } from "../serializers.js";
import { decodeCursor, encodeCursor } from "./cursorPagination.js";

const publicMemorySelect = {
  id: true,
  chatId: true,
  title: true,
  content: true,
  keywords: true,
  importance: true,
  enabled: true,
  deletedAt: true,
  currentRevision: true,
  lastActor: true,
  lastAction: true,
  sourceMessageIds: true,
  embeddingModel: true,
  embeddingSource: true,
  embeddingDimensions: true,
  embeddingStatus: true,
  embeddingUpdatedAt: true,
  lastMatchedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.ChatMemorySelect;

export const listMemoryPage = async (
  chatId: string,
  { cursor, limit, includeTotal }: { cursor?: string; limit: number; includeTotal: boolean }
) => {
  const boundary = decodeCursor(cursor, { kind: "memories", scope: chatId });
  const where: Prisma.ChatMemoryWhereInput = {
    chatId,
    ...(boundary?.updatedAt
      ? { OR: [{ updatedAt: { lt: new Date(boundary.updatedAt) } }, { updatedAt: new Date(boundary.updatedAt), id: { lt: boundary.id } }] }
      : {})
  };
  const [rows, total] = await Promise.all([
    prisma.chatMemory.findMany({
      where,
      select: publicMemorySelect,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1
    }),
    includeTotal ? prisma.chatMemory.count({ where: { chatId } }) : Promise.resolve(undefined)
  ]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(serializeChatMemory),
    nextCursor: rows.length > limit && last
      ? encodeCursor({ version: 1, kind: "memories", scope: chatId, updatedAt: last.updatedAt.toISOString(), id: last.id })
      : null,
    hasMore: rows.length > limit,
    total: total ?? null
  };
};
