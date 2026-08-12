import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { updateMemoryInTransaction } from "./memoryHistory.js";
import { deleteUnreferencedAssets, messageIncludeAttachments } from "./messageAttachments.js";

const listTimelineMessageIdsFrom = async (
  transaction: Prisma.TransactionClient,
  chatId: string,
  targetMessageId: string
) => {
  const timeline = await transaction.message.findMany({
    where: { chatId },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  const targetIndex = timeline.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0) {
    throw new HttpError(404, "Message not found");
  }

  return timeline.slice(targetIndex).map((message) => message.id);
};

const toStringArray = (value: Prisma.JsonValue) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const disableMemoriesFromTimeline = async (
  transaction: Prisma.TransactionClient,
  chatId: string,
  removedMessageIds: string[]
) => {
  const removedIds = new Set(removedMessageIds);
  const memories = await transaction.chatMemory.findMany({ where: { chatId, enabled: true, deletedAt: null } });
  const affected = memories.filter((memory) => toStringArray(memory.sourceMessageIds).some((id) => removedIds.has(id)));
  for (const memory of affected) {
    await updateMemoryInTransaction(transaction, memory, { enabled: false }, {
      actor: "timeline_cleanup",
      action: "timeline_disable",
      reasonCode: "source_timeline_deleted",
      allowMissingSources: true
    });
  }
  return affected.length;
};

export const deleteMessageTimeline = (messageId: string) =>
  prisma.$transaction(async (transaction) => {
    const existing = await transaction.message.findFirst({
      where: { id: messageId, chat: { deletedAt: null } },
      select: { id: true, chatId: true, role: true }
    });
    if (!existing) {
      throw new HttpError(404, "Message not found");
    }

    const messageIds =
      existing.role === "user"
        ? await listTimelineMessageIdsFrom(transaction, existing.chatId, existing.id)
        : [existing.id];
    const deleted = await transaction.message.deleteMany({
      where: { id: { in: messageIds } }
    });
    await deleteUnreferencedAssets(transaction);
    const disabledMemoryCount = await disableMemoriesFromTimeline(
      transaction,
      existing.chatId,
      messageIds
    );
    await transaction.chat.update({
      where: { id: existing.chatId },
      data: { updatedAt: new Date(), memoryUpdatedAt: null }
    });

    return { chatId: existing.chatId, deletedCount: deleted.count, disabledMemoryCount };
  });

export const prepareUserMessageResend = (messageId: string) =>
  prisma.$transaction(async (transaction) => {
    const targetMessage = await transaction.message.findFirst({
      where: { id: messageId, chat: { deletedAt: null } },
      include: messageIncludeAttachments
    });
    if (!targetMessage || targetMessage.role !== "user") {
      throw new HttpError(404, "User message not found");
    }

    const chat = await transaction.chat.findFirst({
      where: { id: targetMessage.chatId, deletedAt: null }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const messageIds = await listTimelineMessageIdsFrom(
      transaction,
      targetMessage.chatId,
      targetMessage.id
    );
    await transaction.message.deleteMany({ where: { id: { in: messageIds } } });
    const disabledMemoryCount = await disableMemoriesFromTimeline(
      transaction,
      targetMessage.chatId,
      messageIds
    );
    const userMessage = await transaction.message.create({
      data: {
        chatId: targetMessage.chatId,
        role: "user",
        content: targetMessage.content,
        variants: [],
        activeVariantIndex: 0
      }
    });
    if (targetMessage.attachments.length) {
      await transaction.messageAttachment.createMany({ data: targetMessage.attachments.map((attachment) => ({
        messageId: userMessage.id,
        assetId: attachment.assetId,
        sortOrder: attachment.sortOrder,
        originalFilename: attachment.originalFilename,
        createdAt: attachment.createdAt
      })) });
    }
    const userMessageWithAttachments = await transaction.message.findUniqueOrThrow({
      where: { id: userMessage.id },
      include: messageIncludeAttachments
    });
    await deleteUnreferencedAssets(transaction);
    await transaction.chat.update({
      where: { id: targetMessage.chatId },
      data: { updatedAt: new Date(), memoryUpdatedAt: null }
    });

    return {
      chat,
      userMessage: userMessageWithAttachments,
      replacedCount: messageIds.length - 1,
      disabledMemoryCount
    };
  });

export const getUserMessageResendTarget = async (messageId: string) => {
  const targetMessage = await prisma.message.findFirst({
    where: { id: messageId, chat: { deletedAt: null } },
    select: { id: true, chatId: true, role: true }
  });
  if (!targetMessage || targetMessage.role !== "user") {
    throw new HttpError(404, "User message not found");
  }

  const chat = await prisma.chat.findFirst({
    where: { id: targetMessage.chatId, deletedAt: null }
  });
  if (!chat) {
    throw new HttpError(404, "Chat not found");
  }

  const timeline = await prisma.message.findMany({
    where: { chatId: targetMessage.chatId },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  const targetIndex = timeline.findIndex((message) => message.id === targetMessage.id);
  if (targetIndex < 0) {
    throw new HttpError(404, "User message not found");
  }

  return {
    chat,
    excludedMessageIds: timeline.slice(targetIndex + 1).map((message) => message.id)
  };
};
