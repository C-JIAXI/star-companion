import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../db.js";
import { getChatDraft, saveChatDraft } from "./chatDrafts.js";
import { createDraftHandoff, consumeDraftHandoff, getDraftHandoff, restoreDraftHandoff } from "./draftHandoffs.js";
import { PNG } from "pngjs";
import { deleteUnreferencedAssets, uploadDraftImage } from "./messageAttachments.js";

test("handoff preserves unsent content, consumes once, and never clears newer composer edits", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled handoff" } });
  try {
    await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: randomUUID(), content: "  Controlled outgoing\n ", attachmentIds: [] });
    const id = randomUUID();
    const first = await createDraftHandoff(chat.id, { id, expectedVersion: 1, purpose: "send" });
    assert.equal(first.draft.content, "");
    assert.equal(first.handoff.content, "  Controlled outgoing\n ");
    const newer = await saveChatDraft(chat.id, { expectedVersion: first.draft.version, mutationId: randomUUID(), content: "Controlled new edit", attachmentIds: [] });
    const replay = await createDraftHandoff(chat.id, { id, expectedVersion: 1, purpose: "send" });
    assert.deepEqual(replay.draft, newer);
    const sent = await consumeDraftHandoff(chat.id, id);
    const duplicate = await consumeDraftHandoff(chat.id, id);
    assert.equal(duplicate.message.id, sent.message.id);
    assert.equal(duplicate.replayed, true);
    assert.equal(sent.message.content, first.handoff.content);
    assert.equal(await prisma.message.count({ where: { chatId: chat.id } }), 1);
    assert.deepEqual(await getChatDraft(chat.id), newer);
    const receipt = await getDraftHandoff(chat.id, id);
    assert.equal(receipt.content, "");
    assert.equal(receipt.messageId, sent.message.id);
    await assert.rejects(restoreDraftHandoff(chat.id, id, { expectedVersion: newer.version, mutationId: randomUUID() }));
  } finally { await prisma.chat.delete({ where: { id: chat.id } }); }
});

test("handoff image transfer, restore and replay keep references and forbid resending deleted messages", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled image handoff" } });
  try {
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(132);
    const image = await uploadDraftImage({ draftId: `draft_${randomUUID()}`, mimeType: "image/png", dataBase64: PNG.sync.write(png).toString("base64") });
    const original = await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: randomUUID(), content: "  Controlled image send ", attachmentIds: [image.id] });
    const transfer = await createDraftHandoff(chat.id, { id: randomUUID(), expectedVersion: original.version, purpose: "queue" });
    assert.equal(transfer.handoff.attachments[0].assetId, image.assetId);
    const restored = await restoreDraftHandoff(chat.id, transfer.handoff.id, { expectedVersion: transfer.draft.version, mutationId: randomUUID() });
    assert.equal(restored.attachments[0].createdAt, image.createdAt);
    assert.equal(restored.content, original.content);
    const sentHandoff = await createDraftHandoff(chat.id, { id: randomUUID(), expectedVersion: restored.version, purpose: "send" });
    const sent = await consumeDraftHandoff(chat.id, sentHandoff.handoff.id);
    assert.equal(sent.message.attachments[0].assetId, image.assetId);
    assert.equal(sent.message.attachments[0].handoffId, null);
    assert.equal(sent.message.attachments[0].composerChatId, null);
    await prisma.message.delete({ where: { id: sent.message.id } });
    await assert.rejects(consumeDraftHandoff(chat.id, sentHandoff.handoff.id));
    assert.equal(await prisma.message.count({ where: { chatId: chat.id } }), 0);
    assert.ok((await getDraftHandoff(chat.id, sentHandoff.handoff.id)).committedAt);
  } finally {
    await prisma.chat.delete({ where: { id: chat.id } });
    await prisma.$transaction((tx) => deleteUnreferencedAssets(tx));
  }
});

test("an expired pending image blocks sending while retaining a restorable text snapshot", async (context) => {
  const chat = await prisma.chat.create({ data: { title: "Controlled expired handoff" } });
  try {
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(133);
    const image = await uploadDraftImage({ draftId: `draft_${randomUUID()}`, mimeType: "image/png", dataBase64: PNG.sync.write(png).toString("base64") });
    await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: randomUUID(), content: "Controlled preserved text", attachmentIds: [image.id] });
    const transfer = await createDraftHandoff(chat.id, { id: randomUUID(), expectedVersion: 1, purpose: "send" });
    context.mock.method(Date, "now", () => Date.parse(image.createdAt) + 25 * 60 * 60 * 1000);
    await assert.rejects(consumeDraftHandoff(chat.id, transfer.handoff.id));
    assert.equal(await prisma.message.count({ where: { chatId: chat.id } }), 0);
    const restored = await restoreDraftHandoff(chat.id, transfer.handoff.id, { expectedVersion: transfer.draft.version, mutationId: randomUUID() });
    assert.equal(restored.content, "Controlled preserved text");
    assert.equal(restored.attachments[0].status, "expired");
  } finally { context.mock.restoreAll(); await prisma.chat.delete({ where: { id: chat.id } }); await prisma.$transaction((tx) => deleteUnreferencedAssets(tx)); }
});
