import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import {
  attachDraftToMessage,
  discardDraftAttachments,
  normalizeUploadedImage,
  removeDraftAttachment,
  uploadDraftImage
} from "./messageAttachments.js";
import { createImageThumbnail } from "./imageNormalization.js";

const png = (width = 2, height = 2) => {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image).toString("base64");
};

const jpegWithOrientation = (orientation: number) => {
  const encoded = Buffer.from(jpeg.encode({ data: Buffer.alloc(2 * 3 * 4, 255), width: 2, height: 3 }, 90).data);
  const payload = Buffer.alloc(32);
  payload.write("Exif\0\0", 0, "ascii");
  payload.write("II", 6, "ascii");
  payload.writeUInt16LE(42, 8);
  payload.writeUInt32LE(8, 10);
  payload.writeUInt16LE(1, 14);
  payload.writeUInt16LE(0x0112, 16);
  payload.writeUInt16LE(3, 18);
  payload.writeUInt32LE(1, 20);
  payload.writeUInt16LE(orientation, 24);
  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([encoded.subarray(0, 2), app1, encoded.subarray(2)]);
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

test("normalizes JPEG EXIF orientation and strips metadata", () => {
  const valid = normalizeUploadedImage({ dataBase64: jpegWithOrientation(6).toString("base64"), mimeType: "image/jpeg" });
  assert.deepEqual([valid.width, valid.height], [3, 2]);
  assert.equal(valid.data.includes(Buffer.from("Exif\0\0", "ascii")), false);
});

test("creates bounded timeline thumbnails without changing the stored original", () => {
  const original = normalizeUploadedImage({ dataBase64: png(640, 320), mimeType: "image/png" });
  const thumbnail = createImageThumbnail(original, 480);
  const decoded = PNG.sync.read(thumbnail.data);
  assert.deepEqual([decoded.width, decoded.height], [480, 240]);
  assert.deepEqual([original.width, original.height], [640, 320]);
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
