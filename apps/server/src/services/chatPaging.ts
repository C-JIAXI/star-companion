import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeChat } from "../serializers.js";
import { decodeCursor, encodeCursor } from "./cursorPagination.js";

const preview = (content: string) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
};

type Scope = "active" | "archived" | "trash" | "all";
const scopeWhere = (scope: Scope): Prisma.ChatWhereInput => {
  if (scope === "active") return { deletedAt: null, isArchived: false, isCheckpoint: false };
  if (scope === "archived") return { deletedAt: null, isArchived: true, isCheckpoint: false };
  if (scope === "trash") return { deletedAt: { not: null }, isCheckpoint: false };
  return { isCheckpoint: false };
};

export const listChatPage = async ({ scope, folder, q, limit, cursor, includeTotal }: { scope: Scope; folder?: string; q?: string; limit: number; cursor?: string; includeTotal: boolean }) => {
  const normalizedQuery = q?.trim() ?? "";
  const cursorScope = `${scope}:${folder ?? "*"}:${normalizedQuery.toLocaleLowerCase()}`;
  const decoded = decodeCursor(cursor, { kind: "chats", scope: cursorScope });
  if (decoded && (!decoded.updatedAt || decoded.pinned === undefined)) throw new HttpError(400, "The chat cursor is incomplete.");
  const baseWhere: Prisma.ChatWhereInput = {
    ...scopeWhere(scope),
    ...(folder !== undefined ? { folder } : {}),
    ...(normalizedQuery ? {
      OR: [
        { title: { contains: normalizedQuery } },
        { character: { is: { name: { contains: normalizedQuery } } } }
      ]
    } : {})
  };
  const boundary = decoded?.updatedAt ? new Date(decoded.updatedAt) : null;
  const cursorWhere: Prisma.ChatWhereInput | undefined = boundary ? {
    OR: [
      ...(decoded!.pinned ? [{ isPinned: false }] : []),
      { isPinned: decoded!.pinned, updatedAt: { lt: boundary } },
      { isPinned: decoded!.pinned, updatedAt: boundary, id: { lt: decoded!.id } }
    ]
  } : undefined;
  const where: Prisma.ChatWhereInput = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;
  const [rows, total] = await Promise.all([
    prisma.chat.findMany({
      where,
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        _count: { select: { messages: true } },
        messages: { where: { role: { in: ["user", "assistant"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { role: true, content: true, createdAt: true } }
      }
    }),
    includeTotal ? prisma.chat.count({ where: baseWhere }) : Promise.resolve(null)
  ]);
  const hasMore = rows.length > limit; const page = rows.slice(0, limit); const last = page.at(-1);
  return {
    scope,
    items: page.map((chat) => {
      const lastMessage = chat.messages[0];
      return { ...serializeChat(chat, chat._count.messages, false), lastMessagePreview: lastMessage && (lastMessage.role === "user" || lastMessage.role === "assistant") ? { role: lastMessage.role, content: preview(lastMessage.content), createdAt: lastMessage.createdAt.toISOString() } : null };
    }),
    total,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ version: 1, kind: "chats", scope: cursorScope, updatedAt: last.updatedAt.toISOString(), id: last.id, pinned: last.isPinned }) : null
  };
};
