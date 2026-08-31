import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeMessage } from "../serializers.js";
import { decodeCursor, encodeCursor } from "./cursorPagination.js";
import { messageIncludeAttachments } from "./messageAttachments.js";

const ascending = (left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }) =>
  left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);

export const listMessagePage = async ({ chatId, limit, cursor, includeTotal }: { chatId: string; limit: number; cursor?: string; includeTotal: boolean }) => {
  const decoded = decodeCursor(cursor, { kind: "messages", scope: chatId });
  if (decoded && !decoded.createdAt) throw new HttpError(400, "The message cursor is incomplete.");
  const boundary = decoded ? new Date(decoded.createdAt!) : null;
  const where = {
    chatId,
    chat: { deletedAt: null },
    ...(boundary ? { OR: [{ createdAt: { lt: boundary } }, { createdAt: boundary, id: { lt: decoded!.id } }] } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.message.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, include: messageIncludeAttachments }),
    includeTotal ? prisma.message.count({ where: { chatId, chat: { deletedAt: null } } }) : Promise.resolve(null)
  ]);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const oldest = page.at(-1);
  return {
    chatId,
    order: "ascending" as const,
    items: page.reverse().map(serializeMessage),
    hasMore,
    nextCursor: hasMore && oldest ? encodeCursor({ version: 1, kind: "messages", scope: chatId, createdAt: oldest.createdAt.toISOString(), id: oldest.id }) : null,
    total
  };
};

export const locateMessagePage = async ({ chatId, messageId, radius }: { chatId: string; messageId: string; radius: number }) => {
  const target = await prisma.message.findFirst({ where: { id: messageId, chatId, chat: { deletedAt: null } }, include: messageIncludeAttachments });
  if (!target) throw new HttpError(404, "The referenced message is unavailable.");
  const olderWhere = { chatId, OR: [{ createdAt: { lt: target.createdAt } }, { createdAt: target.createdAt, id: { lt: target.id } }] };
  const newerWhere = { chatId, OR: [{ createdAt: { gt: target.createdAt } }, { createdAt: target.createdAt, id: { gt: target.id } }] };
  const [older, newer, index, total] = await Promise.all([
    prisma.message.findMany({ where: olderWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: radius, include: messageIncludeAttachments }),
    prisma.message.findMany({ where: newerWhere, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: radius, include: messageIncludeAttachments }),
    prisma.message.count({ where: olderWhere }),
    prisma.message.count({ where: { chatId } })
  ]);
  const items = [...older, target, ...newer].sort(ascending);
  const oldest = items[0];
  const hasOlder = index > older.length;
  return {
    chatId,
    messageId,
    index,
    total,
    items: items.map(serializeMessage),
    olderCursor: hasOlder && oldest
      ? encodeCursor({ version: 1, kind: "messages", scope: chatId, createdAt: oldest.createdAt.toISOString(), id: oldest.id })
      : null,
    hasOlder,
    hasNewer: total - index - 1 > newer.length
  };
};
