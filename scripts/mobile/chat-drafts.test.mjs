import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { MobileStore } from "../../apps/mobile-backend/src/store.mjs";

test("mobile drafts survive reopening SQLite with ordered images and preserve their original expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "star-companion-draft-test-"));
  const filename = path.join(directory, "mobile.sqlite");
  let store = new MobileStore(filename);
  try {
    await store.load();
    const chat = await store.createChat({ title: "Controlled mobile restart" });
    const png = new PNG({ width: 2, height: 2 }); png.data.fill(170);
    const bytes = PNG.sync.write(png);
    const asset = { mimeType: "image/png", dataBase64: bytes.toString("base64"), byteSize: bytes.length,
      contentHash: createHash("sha256").update(bytes).digest("hex"), width: 2, height: 2 };
    const first = await store.createDraftAttachment({ draftId: "draft_mobile_restart_first", asset });
    const second = await store.createDraftAttachment({ draftId: "draft_mobile_restart_second", asset });
    const saved = await store.saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mobile-restart-mutation-1", content: "  Controlled restart\n\n ", attachmentIds: [second.attachment.id, first.attachment.id] });
    const beforeRead = await readFile(filename);
    assert.deepEqual(store.getChatDraft(chat.id), saved);
    assert.deepEqual(await readFile(filename), beforeRead);
    store.db.close();
    store = new MobileStore(filename);
    await store.load();
    assert.deepEqual(store.getChatDraft(chat.id), saved);
    assert.equal(saved.attachments[1].createdAt, first.attachment.createdAt);
    assert.equal(store.readRecords("mediaAsset").length, 1);
    const backup = await store.exportBackup();
    assert.equal(backup.chatDrafts, undefined);
    assert.equal(JSON.stringify(backup).includes(saved.content), false);
    assert.equal(backup.media, undefined);
  } finally { store.db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("mobile failed persistence rolls back memory and can retry without losing the last durable draft", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "star-companion-draft-test-"));
  const filename = path.join(directory, "mobile.sqlite");
  const store = new MobileStore(filename);
  try {
    await store.load();
    const chat = await store.createChat({ title: "Controlled mobile failed write" });
    const saved = await store.saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mobile-disk-mutation-1", content: "Controlled durable text", attachmentIds: [] });
    const before = await readFile(filename);
    const blockedDestination = path.join(directory, "destination-is-directory");
    await mkdir(blockedDestination);
    store.filePath = blockedDestination;
    const edit = { expectedVersion: saved.version, mutationId: "mobile-disk-mutation-2", content: "Controlled retry text", attachmentIds: [] };
    await assert.rejects(store.saveChatDraft(chat.id, edit));
    assert.deepEqual(store.getChatDraft(chat.id), saved);
    assert.deepEqual(await readFile(filename), before);
    store.filePath = filename;
    const retried = await store.saveChatDraft(chat.id, edit);
    assert.equal(retried.version, saved.version + 1);
    assert.equal(retried.content, edit.content);
    assert.deepEqual(await store.saveChatDraft(chat.id, edit), retried);
  } finally { store.db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("mobile lock acquired during draft persistence aborts the write and stale tabs cannot overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "star-companion-draft-test-"));
  const filename = path.join(directory, "mobile.sqlite");
  const store = new MobileStore(filename);
  try {
    await store.load();
    const chat = await store.createChat({ title: "Controlled mobile lock race" });
    const first = await store.saveChatDraft(chat.id, { expectedVersion: 0, mutationId: "mobile-lock-mutation-1", content: "Controlled initial edit", attachmentIds: [] });
    const stale = { expectedVersion: 0, mutationId: "mobile-lock-mutation-2", content: "Controlled stale edit", attachmentIds: [] };
    await assert.rejects(store.saveChatDraft(chat.id, stale), (error) => error.status === 409);
    const before = await readFile(filename);
    let checks = 0;
    store.draftPrivacyState = () => ({ locked: ++checks >= 5, epoch: 0 });
    await assert.rejects(store.saveChatDraft(chat.id, { ...stale, expectedVersion: 1 }), (error) => error.status === 423);
    store.draftPrivacyState = () => ({ locked: false, epoch: 1 });
    assert.deepEqual(store.getChatDraft(chat.id), first);
    assert.deepEqual(await readFile(filename), before);
  } finally { store.db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("mobile handoff survives restart, consumes once and never clears a newer composer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "star-companion-draft-test-"));
  const filename = path.join(directory, "mobile.sqlite"); let store = new MobileStore(filename);
  try {
    await store.load(); const chat = await store.createChat({ title: "Controlled handoff restart" });
    await store.saveChatDraft(chat.id, { expectedVersion: 0, mutationId: randomUUID(), content: "  Controlled pending send\n ", attachmentIds: [] });
    const input = { id: randomUUID(), expectedVersion: 1, purpose: "send" };
    const transfer = await store.createDraftHandoff(chat.id, input);
    store.db.close(); store = new MobileStore(filename); await store.load();
    assert.deepEqual(store.getDraftHandoff(chat.id, input.id), transfer.handoff);
    const newer = await store.saveChatDraft(chat.id, { expectedVersion: transfer.draft.version, mutationId: randomUUID(), content: "Controlled later edit", attachmentIds: [] });
    assert.deepEqual((await store.createDraftHandoff(chat.id, input)).draft, newer);
    const sent = await store.consumeDraftHandoff(chat.id, input.id);
    const duplicate = await store.consumeDraftHandoff(chat.id, input.id);
    assert.equal(duplicate.message.id, sent.message.id);
    assert.equal(duplicate.replayed, true);
    assert.deepEqual(store.getChatDraft(chat.id), newer);
    assert.equal(store.getDraftHandoff(chat.id, input.id).content, "");
    assert.equal(store.listMessages(chat.id).length, 1);
  } finally { store.db?.close(); await rm(directory, { recursive: true, force: true }); }
});
