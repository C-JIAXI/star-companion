import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { listChatPage } from "./chatPaging.js";
import { listMessagePage, locateMessagePage } from "./messagePaging.js";
import { searchMessagesPage } from "./messageSearch.js";
import { listMemoryPage } from "./memoryPaging.js";

const runId = randomUUID();
const characterId = `perf-cursor-character-${runId}`;
const chatId = `perf-cursor-chat-${runId}`;

after(async () => {
  await prisma.chat.deleteMany({ where: { id: { startsWith: `perf-cursor-chat-${runId}` } } });
  await prisma.character.deleteMany({ where: { id: characterId } });
});

describe("stable cursor pagination", () => {
  it("does not duplicate or omit same-timestamp messages across inserts, edits, and deletes", async () => {
    await prisma.character.create({ data: { id: characterId, cardId: characterId, name: "Cursor fixture" } });
    await prisma.chat.create({ data: { id: chatId, title: "Cursor fixture", characterId } });
    const timestamp = new Date("2026-08-31T00:00:00.000Z");
    const ids = ["a", "b", "c", "d", "e"].map((suffix) => `perf-cursor-message-${runId}-${suffix}`);
    for (const id of ids) await prisma.message.create({ data: { id, chatId, role: "user", content: `fixture ${id.at(-1)}`, createdAt: timestamp, updatedAt: timestamp } });

    const first = await listMessagePage({ chatId, limit: 2, includeTotal: true });
    assert.equal(first.total, 5); assert.deepEqual(first.items.map((item) => item.id), ids.slice(3));
    await prisma.message.create({ data: { id: `perf-cursor-message-${runId}-z`, chatId, role: "user", content: "newer fixture", createdAt: new Date(timestamp.getTime() + 1_000) } });
    await prisma.message.update({ where: { id: ids[2] }, data: { content: "edited fixture" } });
    await prisma.message.delete({ where: { id: ids[0] } });

    const second = await listMessagePage({ chatId, limit: 2, cursor: first.nextCursor!, includeTotal: false });
    assert.deepEqual(second.items.map((item) => item.id), ids.slice(1, 3));
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
    assert.equal([...first.items, ...second.items].some((item) => item.id.endsWith("-z")), false);
    await assert.rejects(() => listMessagePage({ chatId, limit: 2, cursor: "not-a-valid-cursor", includeTotal: false }), (error) => error instanceof HttpError && error.status === 400);

    const located = await locateMessagePage({ chatId, messageId: ids[2], radius: 5 });
    assert.equal(located.items.some((item) => item.id === ids[2]), true);
    assert.equal(located.index, 1);

    await prisma.message.updateMany({ where: { id: { in: ids.slice(1) } }, data: { isBookmarked: true } });
    const bookmarkedFirst = await listMessagePage({ chatId, limit: 2, includeTotal: true, bookmarkedOnly: true });
    const bookmarkedSecond = await listMessagePage({ chatId, limit: 2, cursor: bookmarkedFirst.nextCursor!, includeTotal: false, bookmarkedOnly: true });
    assert.equal(bookmarkedFirst.total, 4);
    assert.equal(bookmarkedFirst.items.some((item) => bookmarkedSecond.items.some((other) => other.id === item.id)), false);
    await assert.rejects(
      () => listMessagePage({ chatId, limit: 2, cursor: first.nextCursor!, includeTotal: false, bookmarkedOnly: true }),
      (error) => error instanceof HttpError && error.status === 400
    );
  });

  it("keeps chat and literal special-character search cursors stable", async () => {
    const sameUpdatedAt = new Date("2026-08-31T01:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      await prisma.chat.create({ data: { id: `perf-cursor-chat-${runId}-${index}`, title: `Cursor ${index}`, characterId, folder: runId, updatedAt: sameUpdatedAt } });
    }
    const first = await listChatPage({ scope: "active", folder: runId, limit: 2, includeTotal: false });
    assert.equal(first.items.length, 2); assert.equal(first.hasMore, true);
    const second = await listChatPage({ scope: "active", folder: runId, limit: 2, cursor: first.nextCursor!, includeTotal: false });
    assert.equal(first.items.some((item) => second.items.some((other) => other.id === item.id)), false);

    const search = await searchMessagesPage({ query: "%_", chatId, limit: 2 });
    assert.equal(search.total, 0);
    await prisma.message.create({ data: { id: `perf-cursor-message-${runId}-special`, chatId, role: "user", content: "literal %_ query", createdAt: sameUpdatedAt } });
    const literal = await searchMessagesPage({ query: "%_", chatId, limit: 2 });
    assert.equal(literal.total, 1); assert.equal(literal.results[0]?.message.id.endsWith("-special"), true);
    const indexed = await searchMessagesPage({ query: "literal", chatId, limit: 2 });
    assert.equal(indexed.total, 1);
    await prisma.message.update({ where: { id: `perf-cursor-message-${runId}-special` }, data: { content: "replacement trigram content" } });
    assert.equal((await searchMessagesPage({ query: "literal", chatId, limit: 2 })).total, 0);
    assert.equal((await searchMessagesPage({ query: "trigram", chatId, limit: 2 })).total, 1);
  });

  it("pages same-timestamp memories without loading embedding vectors or duplicating rows", async () => {
    const timestamp = new Date("2026-08-31T02:00:00.000Z");
    const ids = ["a", "b", "c", "d", "e"].map((suffix) => `perf-cursor-memory-${runId}-${suffix}`);
    for (const id of ids) {
      await prisma.chatMemory.create({
        data: { id, chatId, title: `Memory ${id.at(-1)}`, content: "deterministic fixture", embedding: [0.1, 0.2], updatedAt: timestamp, createdAt: timestamp }
      });
    }
    const first = await listMemoryPage(chatId, { limit: 2, includeTotal: true });
    const second = await listMemoryPage(chatId, { limit: 2, cursor: first.nextCursor!, includeTotal: false });

    assert.equal(first.total, 5);
    assert.equal(first.hasMore, true);
    assert.equal(first.items.some((memory) => "embedding" in memory), false);
    assert.equal(first.items.some((memory) => second.items.some((other) => other.id === memory.id)), false);
    await assert.rejects(
      () => listMemoryPage(chatId, { limit: 2, cursor: `${first.nextCursor}x`, includeTotal: false }),
      (error) => error instanceof HttpError && error.status === 400
    );
  });
});
