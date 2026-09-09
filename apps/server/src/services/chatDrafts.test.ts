import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import { getChatDraft, saveChatDraft } from "./chatDrafts.js";
import { cleanupExpiredDraftAttachments, deleteUnreferencedAssets, discardDraftAttachments, removeDraftAttachment, reorderDraftAttachments, stageMessageAttachmentsForEdit, uploadDraftImage } from "./messageAttachments.js";
import { lockPrivacy, unlockPrivacy } from "./privacyLock.js";
import { HttpError } from "../lib/http.js";
import { DraftOwnershipError } from "./draftOwnership.js";

test("chat drafts durably preserve raw text and ordered image references without changing the upload lifetime", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled draft fixture" } });
  try {
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    const first = await uploadDraftImage({ draftId: "draft_test_persistence_first", mimeType: "image/png", dataBase64: PNG.sync.write(image).toString("base64") });
    image.data[0] = 0;
    const second = await uploadDraftImage({ draftId: "draft_test_persistence_second", mimeType: "image/png", dataBase64: PNG.sync.write(image).toString("base64") });
    const initial = await getChatDraft(chat.id);
    assert.equal(initial.version, 0);
    const saved = await saveChatDraft(chat.id, {
      expectedVersion: initial.version, mutationId: "mutation-persistence-1",
      content: "  Controlled draft\n\n  ", attachmentIds: [second.id, first.id]
    });
    const recovered = await getChatDraft(chat.id);
    assert.deepEqual(recovered, saved);
    assert.equal(recovered.content, "  Controlled draft\n\n  ");
    assert.deepEqual(recovered.attachments.map((item) => item.id), [second.id, first.id]);
    assert.equal(recovered.attachments[1].createdAt, first.createdAt);
    assert.equal(recovered.attachments[0].status, "ready");
    assert.equal(recovered.version, 1);
    assert.ok(recovered.updatedAt);
  } finally {
    await prisma.chat.delete({ where: { id: chat.id } });
  }
});

test("reading an empty draft is zero-write and saved drafts survive a database reconnect", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled read-only fixture" } });
  try {
    const before = await prisma.chatDraft.count();
    await getChatDraft(chat.id);
    assert.equal(await prisma.chatDraft.count(), before);
    const saved = await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mutation-reconnect-1", content: "\n  Controlled text  ", attachmentIds: [] });
    await prisma.$disconnect();
    await prisma.$connect();
    assert.deepEqual(await getChatDraft(chat.id), saved);
  } finally { await prisma.chat.delete({ where: { id: chat.id } }); }
});

test("stale writers cannot overwrite a draft and acknowledgement retries are idempotent", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled conflict fixture" } });
  try {
    const mutation = { expectedVersion: 0, mutationId: "mutation-conflict-1", content: "Controlled first edit", attachmentIds: [] };
    const first = await saveChatDraft(chat.id, mutation);
    assert.deepEqual(await saveChatDraft(chat.id, mutation), first);
    const isConflict = (error: unknown) => error instanceof HttpError && error.status === 409;
    await assert.rejects(saveChatDraft(chat.id, { ...mutation, content: "Changed replay" }), isConflict);
    await assert.rejects(saveChatDraft(chat.id, { ...mutation, mutationId: "mutation-conflict-2" }), isConflict);
    assert.deepEqual(await getChatDraft(chat.id), first);
    const next = await saveChatDraft(chat.id, { ...mutation, mutationId: "mutation-conflict-2", expectedVersion: first.version, content: "Explicitly chosen edit" });
    assert.equal(next.version, 2);
    assert.equal(next.content, "Explicitly chosen edit");
  } finally { await prisma.chat.delete({ where: { id: chat.id } }); }
});

test("simultaneous draft writers commit exactly one version and expose a conflict to the other", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled simultaneous writers" } });
  try {
    const results = await Promise.allSettled(["a", "b"].map((suffix) => saveChatDraft(chat.id, {
      expectedVersion: 0, mutationId: `simultaneous-mutation-${suffix}`, content: `Controlled edit ${suffix}`, attachmentIds: []
    })));
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = results.find((item) => item.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.status, 409);
    assert.equal((await getChatDraft(chat.id)).version, 1);
  } finally { await prisma.chat.delete({ where: { id: chat.id } }); }
});

test("expired and missing images remain removable placeholders without losing text or deleting shared assets", async (context) => {
  const chat = await prisma.chat.create({ data: { title: "Controlled expiry fixture" } });
  const otherChat = await prisma.chat.create({ data: { title: "Controlled sharing fixture" } });
  const image = new PNG({ width: 3, height: 2 }); image.data.fill(180);
  const dataBase64 = PNG.sync.write(image).toString("base64");
  try {
    const expired = await uploadDraftImage({ draftId: "draft_expired_placeholder_1", mimeType: "image/png", dataBase64 });
    const missing = await uploadDraftImage({ draftId: "draft_missing_placeholder_1", mimeType: "image/png", dataBase64 });
    const shared = await uploadDraftImage({ draftId: "draft_shared_placeholder_1", mimeType: "image/png", dataBase64 });
    const first = await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mutation-expiry-1", content: "Preserved controlled text", attachmentIds: [expired.id, missing.id] });
    await saveChatDraft(otherChat.id, { expectedVersion: 0, mutationId: "mutation-shared-1", content: "", attachmentIds: [shared.id] });
    // Fault injection is limited to the isolated test database.
    await prisma.messageAttachment.delete({ where: { id: missing.id } });
    const withMissing = await getChatDraft(chat.id);
    assert.deepEqual(withMissing.attachments.map((item) => item.status), ["ready", "missing"]);
    assert.equal(withMissing.attachments[1].url, "");
    const afterExpiry = Date.parse(first.attachments[0].expiresAt) + 1;
    context.mock.method(Date, "now", () => afterExpiry);
    const withExpired = await getChatDraft(chat.id);
    assert.equal(withExpired.attachments[0].status, "expired");
    assert.equal(withExpired.content, first.content);
    assert.equal(withExpired.updatedAt, first.updatedAt);
    context.mock.restoreAll();
    // Expire only the first reference; another live draft still protects shared bytes.
    await prisma.messageAttachment.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    await prisma.$transaction((tx) => cleanupExpiredDraftAttachments(tx));
    const afterCleanup = await getChatDraft(chat.id);
    assert.equal(afterCleanup.attachments.length, 2);
    assert.equal(afterCleanup.content, first.content);
    assert.equal((await getChatDraft(otherChat.id)).attachments[0].status, "ready");
    const cleared = await saveChatDraft(chat.id, { expectedVersion: first.version, mutationId: "mutation-expiry-2", content: first.content, attachmentIds: [] });
    assert.equal(cleared.attachments.length, 0);
    assert.equal(await prisma.mediaAsset.count({ where: { id: shared.assetId } }), 1);
  } finally {
    context.mock.restoreAll();
    await prisma.chat.deleteMany({ where: { id: { in: [chat.id, otherChat.id] } } });
    await prisma.$transaction((tx) => deleteUnreferencedAssets(tx));
  }
});

test("managed images reject legacy mutation, while lock and trash protect the composer", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled protection fixture" } });
  const other = await prisma.chat.create({ data: { title: "Controlled ownership fixture" } });
  const image = new PNG({ width: 2, height: 3 }); image.data.fill(110);
  try {
    const attachment = await uploadDraftImage({ draftId: "draft_protected_composer_1", mimeType: "image/png", dataBase64: PNG.sync.write(image).toString("base64") });
    const saved = await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mutation-protection-1", content: "Controlled unsent text", attachmentIds: [attachment.id] });
    const blocked = (error: unknown) => (error instanceof HttpError || error instanceof DraftOwnershipError) && error.status === 409;
    await assert.rejects(discardDraftAttachments(saved.draftId), blocked);
    await assert.rejects(removeDraftAttachment(saved.draftId, attachment.id), blocked);
    await assert.rejects(reorderDraftAttachments(saved.draftId, [attachment.id]), blocked);
    await assert.rejects(saveChatDraft(other.id, { expectedVersion: 0, mutationId: "mutation-ownership-1", content: "", attachmentIds: [attachment.id] }), blocked);
    lockPrivacy("controlled-test-passcode");
    await assert.rejects(getChatDraft(chat.id), (error: unknown) => error instanceof HttpError && error.status === 423);
    await assert.rejects(saveChatDraft(chat.id, { expectedVersion: 1, mutationId: "mutation-protection-2", content: "", attachmentIds: [] }), (error: unknown) => error instanceof HttpError && error.status === 423);
    unlockPrivacy("controlled-test-passcode");
    await prisma.chat.update({ where: { id: chat.id }, data: { deletedAt: new Date() } });
    assert.deepEqual(await getChatDraft(chat.id), saved);
    await assert.rejects(saveChatDraft(chat.id, { expectedVersion: 1, mutationId: "mutation-protection-3", content: "", attachmentIds: [] }), blocked);
    await prisma.chat.update({ where: { id: chat.id }, data: { deletedAt: null } });
    assert.deepEqual(await getChatDraft(chat.id), saved);
    await prisma.chat.delete({ where: { id: chat.id } });
    assert.equal(await prisma.messageAttachment.count({ where: { id: attachment.id } }), 0);
    assert.equal(await prisma.chatDraft.count({ where: { chatId: chat.id } }), 0);
  } finally {
    unlockPrivacy("controlled-test-passcode");
    await prisma.chat.deleteMany({ where: { id: { in: [chat.id, other.id] } } });
    await prisma.$transaction((tx) => deleteUnreferencedAssets(tx));
  }
});

test("editing an old message starts a fresh independent attachment lifetime without changing its message or composer", async () => {
  const chat = await prisma.chat.create({ data: { title: "Controlled history edit fixture" } });
  const draftId = "draft_independent_edit_fixture";
  try {
    const image = new PNG({ width: 2, height: 2 }); image.data.fill(77);
    const uploaded = await uploadDraftImage({ draftId: "draft_historical_source_image", mimeType: "image/png", dataBase64: PNG.sync.write(image).toString("base64") });
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: "Controlled old message" } });
    await prisma.messageAttachment.update({ where: { id: uploaded.id }, data: { messageId: message.id, draftId: null, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } });
    const composer = await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mutation-history-edit-1", content: "Separate composer", attachmentIds: [] });
    const edit = await stageMessageAttachmentsForEdit(message.id, draftId);
    assert.equal(edit.length, 1);
    assert.ok(edit[0].createdAt.getTime() > Date.now() - 60_000);
    assert.equal(edit[0].assetId, uploaded.assetId);
    assert.deepEqual(await getChatDraft(chat.id), composer);
    await discardDraftAttachments(draftId);
    assert.equal(await prisma.mediaAsset.count({ where: { id: uploaded.assetId } }), 1);
  } finally {
    await prisma.chat.delete({ where: { id: chat.id } });
    await discardDraftAttachments(draftId);
  }
});
