import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import {
  attachDraftToMessage,
  discardDraftAttachments,
  normalizeUploadedImage,
  removeDraftAttachment,
  uploadDraftImage
} from "./messageAttachments.js";

const png = (width = 2, height = 2) => {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image).toString("base64");
};

test("validates signatures, declared MIME, pixel limits, unsupported and damaged data", () => {
  const valid = normalizeUploadedImage({ dataBase64: png(), mimeType: "image/png" });
  assert.equal(valid.mimeType, "image/png");
  assert.deepEqual([valid.width, valid.height], [2, 2]);
  assert.throws(() => normalizeUploadedImage({ dataBase64: png(), mimeType: "image/jpeg" }), /declared image type/i);
  assert.throws(() => normalizeUploadedImage({ dataBase64: Buffer.from("<svg/>").toString("base64"), mimeType: "image/png" }), /valid PNG or JPEG/i);
  const oversizedHeader = Buffer.from(png(), "base64");
  oversizedHeader.writeUInt32BE(6000, 16);
  oversizedHeader.writeUInt32BE(5000, 20);
  assert.throws(() => normalizeUploadedImage({ dataBase64: oversizedHeader.toString("base64"), mimeType: "image/png" }), /25 megapixels/i);
  assert.throws(() => normalizeUploadedImage({ dataBase64: png(101, 1), mimeType: "image/png" }), /aspect ratio/i);
});

test("deduplicates content, atomically attaches drafts, and deletes only unreferenced assets", async () => {
  const suffix = Date.now().toString(36);
  const character = await prisma.character.create({ data: { cardId: `card-${suffix}`, name: "Attachment test" } });
  const chat = await prisma.chat.create({ data: { title: "Attachment test", characterId: character.id } });
  const first = await uploadDraftImage({ draftId: `draft_${suffix}_first000`, dataBase64: png(), mimeType: "image/png", originalFilename: "../private.png" });
  const second = await uploadDraftImage({ draftId: `draft_${suffix}_second00`, dataBase64: png(), mimeType: "image/png" });
  assert.equal(first.assetId, second.assetId);
  assert.equal(await prisma.mediaAsset.count({ where: { id: first.assetId } }), 1);
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({ data: { chatId: chat.id, role: "user", content: "" } });
    await attachDraftToMessage(tx, `draft_${suffix}_first000`, created.id);
    return created;
  });
  await discardDraftAttachments(`draft_${suffix}_second00`);
  assert.equal(await prisma.mediaAsset.count({ where: { id: first.assetId } }), 1);
  const stored = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: message.id } });
  assert.equal(stored.draftId, null);
  assert.equal(stored.originalFilename, ".._private.png");
  await prisma.message.delete({ where: { id: message.id } });
  await uploadDraftImage({ draftId: `draft_${suffix}_cleanup00`, dataBase64: png(3, 3), mimeType: "image/png" }).then(async (item) => {
    await removeDraftAttachment(`draft_${suffix}_cleanup00`, item.id);
    assert.equal(await prisma.mediaAsset.count({ where: { id: item.assetId } }), 0);
  });
  await prisma.chat.delete({ where: { id: chat.id } });
  await prisma.character.delete({ where: { id: character.id } });
});
