import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import { exportBackup, importBackup, previewBackup, restoreRecoveryPoint } from "./backups.js";
import { attachDraftToMessage, uploadDraftImage } from "./messageAttachments.js";
import { randomUUID } from "node:crypto";
import { getChatDraft, saveChatDraft } from "./chatDrafts.js";
import { createDraftHandoff } from "./draftHandoffs.js";

const png = () => {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(180);
  return PNG.sync.write(image).toString("base64");
};

test("a recovery point restores message attachments without duplicating image bytes in its JSON snapshot", async () => {
  const suffix = Date.now().toString(36);
  const character = await prisma.character.create({ data: { cardId: `recovery-card-${suffix}`, name: "Recovery media" } });
  const chat = await prisma.chat.create({ data: { title: "Recovery media", characterId: character.id } });
  const uploaded = await uploadDraftImage({ draftId: `draft_${suffix}_recovery000`, dataBase64: png(), mimeType: "image/png" });
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({ data: { chatId: chat.id, role: "user", content: "" } });
    await attachDraftToMessage(tx, `draft_${suffix}_recovery000`, created.id);
    return created;
  });
  const pendingImage = await uploadDraftImage({ draftId: `draft_${suffix}_pending000`, dataBase64: png(), mimeType: "image/png" });
  const pendingText = "  Controlled local-only pending\n ";
  const composerText = "  Controlled local-only composer\n ";
  await saveChatDraft(chat.id, { expectedVersion: 0, mutationId: randomUUID(), content: pendingText, attachmentIds: [pendingImage.id] });
  const handoff = await createDraftHandoff(chat.id, { id: randomUUID(), expectedVersion: 1, purpose: "queue" });
  await saveChatDraft(chat.id, { expectedVersion: handoff.draft.version, mutationId: randomUUID(), content: composerText, attachmentIds: [] });
  const exported = await exportBackup();
  assert.equal((exported.media as { assets: unknown[] }).assets.length, 1);

  const candidate = { schemaVersion: 1 as const, mode: "replace" as const, settings: null, characters: [], chats: [], messages: [], memories: [], memoryRevisions: [], memoryOperations: [], profileSummaryRevisions: [] };
  const preview = await previewBackup(candidate);
  const imported = await importBackup({ ...candidate, previewId: preview.previewId, conflictResolutions: [] });
  assert.ok(imported.recoveryPointId);
  assert.equal(await prisma.message.count({ where: { id: message.id } }), 0);
  assert.equal(await prisma.mediaAsset.count({ where: { id: uploaded.assetId } }), 1, "the recovery reference keeps deduplicated bytes alive");
  const point = await prisma.recoveryPoint.findUniqueOrThrow({ where: { id: imported.recoveryPointId! } });
  assert.equal(JSON.stringify(point.snapshot).includes(png().slice(0, 30)), false, "recovery JSON must not copy base64 image bytes");
  for (const payload of [exported, point.snapshot]) {
    const encoded = JSON.stringify(payload);
    for (const localValue of [pendingText, composerText, pendingImage.id, handoff.handoff.id]) assert.equal(encoded.includes(JSON.stringify(localValue)), false);
  }
  assert.equal(await prisma.chatDraft.count({ where: { chatId: chat.id } }), 0);
  assert.equal(await prisma.draftHandoff.count({ where: { chatId: chat.id } }), 0);

  await restoreRecoveryPoint(imported.recoveryPointId!);
  const restored = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: message.id }, include: { asset: true } });
  assert.equal(restored.asset.contentHash, uploaded.contentHash);
  assert.equal(await prisma.mediaAsset.count({ where: { contentHash: uploaded.contentHash } }), 1);
  assert.equal((await getChatDraft(chat.id)).content, "");
  assert.equal((await getChatDraft(chat.id)).attachments.length, 0);

  await prisma.recoveryPoint.deleteMany();
  await prisma.chat.deleteMany({ where: { id: chat.id } }).catch(() => {});
  await prisma.character.deleteMany({ where: { id: character.id } }).catch(() => {});
  await prisma.mediaAsset.deleteMany({ where: { attachments: { none: {} }, recoveryPoints: { none: {} } } });
});
