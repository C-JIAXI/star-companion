import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../db.js";
import {
  deleteMessageTimeline,
  getUserMessageResendTarget,
  prepareUserMessageResend
} from "./messageTimeline.js";

const prefix = `Message Timeline Test ${Date.now()}`;
const createdChatIds: string[] = [];
let characterId = "";

const createTimeline = async () => {
  const chat = await prisma.chat.create({
    data: { title: `${prefix} chat`, characterId }
  });
  createdChatIds.push(chat.id);

  const baseTime = Date.now() - 10_000;
  const entries = await Promise.all(
    [
      ["user", "Opening message"],
      ["assistant", "Opening reply"],
      ["user", "Change direction"],
      ["assistant", "Old direction reply"]
    ].map(([role, content], index) =>
      prisma.message.create({
        data: {
          chatId: chat.id,
          role,
          content,
          variants: role === "assistant" ? [content] : [],
          activeVariantIndex: 0,
          createdAt: new Date(baseTime + index * 1_000)
        }
      })
    )
  );

  return { chat, entries };
};

describe("message timeline operations", () => {
  before(async () => {
    const character = await prisma.character.create({
      data: { name: prefix }
    });
    characterId = character.id;
  });

  after(async () => {
    await prisma.chat.deleteMany({ where: { id: { in: createdChatIds } } }).catch(() => {});
    if (characterId) {
      await prisma.character.delete({ where: { id: characterId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("deletes a user message and its following timeline atomically", async () => {
    const { chat, entries } = await createTimeline();
    const [retiredMemory, retainedMemory] = await Promise.all([
      prisma.chatMemory.create({
        data: {
          chatId: chat.id,
          title: "Retired direction",
          content: "This belongs to the removed branch.",
          sourceMessageIds: [entries[2].id]
        }
      }),
      prisma.chatMemory.create({
        data: {
          chatId: chat.id,
          title: "Retained opening",
          content: "This belongs to the retained opening.",
          sourceMessageIds: [entries[0].id]
        }
      })
    ]);
    await prisma.chat.update({
      where: { id: chat.id },
      data: { memoryUpdatedAt: new Date() }
    });
    const result = await deleteMessageTimeline(entries[2].id);
    const remaining = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" }
    });

    assert.equal(result.chatId, chat.id);
    assert.equal(result.deletedCount, 2);
    assert.equal(result.disabledMemoryCount, 1);
    assert.deepEqual(remaining.map((message) => message.content), ["Opening message", "Opening reply"]);
    const [disabledMemory, enabledMemory, updatedChat] = await Promise.all([
      prisma.chatMemory.findUniqueOrThrow({ where: { id: retiredMemory.id } }),
      prisma.chatMemory.findUniqueOrThrow({ where: { id: retainedMemory.id } }),
      prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })
    ]);
    assert.equal(disabledMemory.enabled, false);
    const timelineRevision = await prisma.memoryRevision.findFirstOrThrow({ where: { memoryId: retiredMemory.id }, orderBy: { revision: "desc" } });
    assert.equal(timelineRevision.actor, "timeline_cleanup");
    assert.equal(timelineRevision.action, "timeline_disable");
    assert.equal(timelineRevision.afterSnapshot && typeof timelineRevision.afterSnapshot === "object" && !Array.isArray(timelineRevision.afterSnapshot) ? timelineRevision.afterSnapshot.enabled : null, false);
    assert.equal(enabledMemory.enabled, true);
    assert.equal(updatedChat.memoryUpdatedAt, null);
  });

  it("deletes only the selected assistant message", async () => {
    const { chat, entries } = await createTimeline();
    const result = await deleteMessageTimeline(entries[1].id);
    const remaining = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" }
    });

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(remaining.map((message) => message.content), [
      "Opening message",
      "Change direction",
      "Old direction reply"
    ]);
  });

  it("replaces a user message and following timeline in one transaction", async () => {
    const { chat, entries } = await createTimeline();
    const retiredMemory = await prisma.chatMemory.create({
      data: {
        chatId: chat.id,
        title: "Old direction",
        content: "This should no longer be recalled.",
        sourceMessageIds: [entries[2].id, entries[3].id]
      }
    });
    const result = await prepareUserMessageResend(entries[2].id);
    const remaining = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" }
    });

    assert.equal(result.chat.id, chat.id);
    assert.equal(result.replacedCount, 1);
    assert.equal(result.disabledMemoryCount, 1);
    assert.notEqual(result.userMessage.id, entries[2].id);
    assert.deepEqual(remaining.map((message) => message.content), [
      "Opening message",
      "Opening reply",
      "Change direction"
    ]);
    assert.equal(remaining[2].role, "user");
    assert.equal(
      (await prisma.chatMemory.findUniqueOrThrow({ where: { id: retiredMemory.id } })).enabled,
      false
    );
  });

  it("prepares resend context without changing the current timeline", async () => {
    const { chat, entries } = await createTimeline();
    const result = await getUserMessageResendTarget(entries[2].id);
    const remaining = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" }
    });

    assert.equal(result.chat.id, chat.id);
    assert.deepEqual(result.excludedMessageIds, [entries[3].id]);
    assert.deepEqual(remaining.map((message) => message.id), entries.map((message) => message.id));
  });

  it("rejects assistant targets without changing the timeline", async () => {
    const { chat, entries } = await createTimeline();

    await assert.rejects(() => prepareUserMessageResend(entries[1].id), /User message not found/);

    const remaining = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" }
    });
    assert.deepEqual(remaining.map((message) => message.id), entries.map((message) => message.id));
  });
});
