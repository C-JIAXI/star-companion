import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeMessage } from "../serializers.js";
import { decodeCursor, encodeCursor } from "./cursorPagination.js";
import { messageIncludeAttachments } from "./messageAttachments.js";

const snippet = (content: string, query: string) => {
  const normalizedContent = content.toLowerCase(); const normalizedQuery = query.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex < 0) return content.slice(0, 160);
  const start = Math.max(0, matchIndex - 60); const end = Math.min(content.length, matchIndex + query.length + 100);
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
};
const queryScope = (query: string, chatId?: string) => `${chatId ?? "global"}:${createHash("sha256").update(query.toLocaleLowerCase()).digest("hex").slice(0, 24)}`;

type SearchRow = { id: string; chatId: string; createdAt: Date; messageIndex: bigint };

export const searchMessagesPage = async ({ query, limit, cursor, chatId }: { query: string; limit: number; cursor?: string; chatId?: string }) => {
  const scope = queryScope(query, chatId);
  const decoded = decodeCursor(cursor, { kind: "message-search", scope });
  if (decoded && !decoded.createdAt) throw new HttpError(400, "The search cursor is incomplete.");
  const boundary = decoded?.createdAt ? new Date(decoded.createdAt) : null;
  const chatPredicate = chatId ? Prisma.sql`m.chatId = ${chatId}` : Prisma.sql`c.deletedAt IS NULL`;
  const indexedChatPredicate = chatId ? Prisma.sql`search.chatId = ${chatId}` : Prisma.sql`c.deletedAt IS NULL`;
  const cursorPredicate = boundary
    ? Prisma.sql`AND (m.createdAt < ${boundary} OR (m.createdAt = ${boundary} AND m.id < ${decoded!.id}))`
    : Prisma.empty;
  const useTrigramIndex = [...query].length >= 3;
  const trigramQuery = `"${query.replaceAll('"', '""')}"`;
  const indexedOverflow = useTrigramIndex
    ? await prisma.$queryRaw<Array<{ overflow: bigint }>>(Prisma.sql`
        SELECT EXISTS(
          SELECT 1 FROM MessageSearch AS search
          JOIN Chat c ON c.id = search.chatId
          WHERE ${indexedChatPredicate} AND search.content MATCH ${trigramQuery}
          LIMIT 1 OFFSET 5000
        ) AS overflow
      `)
    : [];
  const useTrigramRows = useTrigramIndex && Number(indexedOverflow[0]?.overflow ?? 0) === 0;
  const totalRows = useTrigramRows
    ? await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM MessageSearch AS search
        JOIN Chat c ON c.id = search.chatId
        WHERE ${indexedChatPredicate} AND search.content MATCH ${trigramQuery}
      `)
    : await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM Message AS m NOT INDEXED JOIN Chat c ON c.id = m.chatId
        WHERE ${chatPredicate} AND instr(lower(m.content), lower(${query})) > 0
      `);
  const total = Number(totalRows[0]?.count ?? 0);
  const rows = useTrigramRows
    ? await prisma.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT m.id, m.chatId, m.createdAt,
          (SELECT COUNT(*) FROM Message AS prior INDEXED BY Message_chatId_createdAt_id_idx WHERE prior.chatId = m.chatId AND (prior.createdAt < m.createdAt OR (prior.createdAt = m.createdAt AND prior.id < m.id))) AS messageIndex
        FROM MessageSearch AS search JOIN Message AS m ON m.id = search.messageId JOIN Chat c ON c.id = m.chatId
        WHERE ${chatPredicate} AND search.content MATCH ${trigramQuery} ${cursorPredicate}
        ORDER BY m.createdAt DESC, m.id DESC LIMIT ${limit + 1}
      `)
    : await prisma.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT m.id, m.chatId, m.createdAt,
          (SELECT COUNT(*) FROM Message AS prior INDEXED BY Message_chatId_createdAt_id_idx WHERE prior.chatId = m.chatId AND (prior.createdAt < m.createdAt OR (prior.createdAt = m.createdAt AND prior.id < m.id))) AS messageIndex
        FROM Message AS m INDEXED BY Message_createdAt_id_idx JOIN Chat c ON c.id = m.chatId
        WHERE ${chatPredicate} AND instr(lower(m.content), lower(${query})) > 0 ${cursorPredicate}
        ORDER BY m.createdAt DESC, m.id DESC LIMIT ${limit + 1}
      `);
  const hasMore = rows.length > limit; const pageRows = rows.slice(0, limit);
  const records = pageRows.length ? await prisma.message.findMany({ where: { id: { in: pageRows.map((row) => row.id) } }, include: { ...messageIncludeAttachments, ...(!chatId ? { chat: { select: { id: true, title: true, characterId: true, isArchived: true } } } : {}) } }) : [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const results = pageRows.flatMap((row) => {
    const message = byId.get(row.id); if (!message) return [];
    return [{ ...(!chatId && "chat" in message ? { chat: message.chat } : {}), message: serializeMessage(message), index: Number(row.messageIndex), snippet: snippet(message.content, query) }];
  });
  const last = pageRows.at(-1);
  return { query, total, results, hasMore, nextCursor: hasMore && last ? encodeCursor({ version: 1, kind: "message-search", scope, createdAt: new Date(last.createdAt).toISOString(), id: last.id }) : null };
};
