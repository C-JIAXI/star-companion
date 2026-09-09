import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";

/** Same HTTP assertions against both isolated backends. No model calls or user data. */
export const verifyChatDraftContract = async (baseUrl) => {
  const send = async (pathname, method = "GET", body, status = 200) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, status, `Draft contract ${method} returned unexpected status`);
    if (status === 204) return;
    const envelope = await response.json();
    return status < 400 ? envelope.data : envelope;
  };
  const character = await send("/api/characters", "POST", { name: "Controlled draft character", prompt: "Controlled fixture", prefix: "", suffix: "" }, 201);
  const chat = await send("/api/chats", "POST", { title: "Controlled draft contract", characterId: character.id }, 201);
  const route = `/api/chats/${chat.id}/draft`;
  let locked = false;
  try {
    const empty = await send(route);
    assert.deepEqual({ content: empty.content, version: empty.version, attachments: empty.attachments, updatedAt: empty.updatedAt }, { content: "", version: 0, attachments: [], updatedAt: null });
    const image = new PNG({ width: 2, height: 2 }); image.data.fill(255);
    const first = await send("/api/media/chat-images/drafts", "POST", { draftId: `draft_${randomUUID()}`, dataBase64: PNG.sync.write(image).toString("base64"), mimeType: "image/png", originalFilename: "controlled.png" }, 201);
    image.data[0] = 30;
    const second = await send("/api/media/chat-images/drafts", "POST", { draftId: `draft_${randomUUID()}`, dataBase64: PNG.sync.write(image).toString("base64"), mimeType: "image/png" }, 201);
    const input = { expectedVersion: 0, mutationId: randomUUID(), content: "  Controlled draft\n\n  ", attachmentIds: [second.id, first.id] };
    const saved = await send(route, "PUT", input);
    assert.equal(saved.content, input.content);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.attachments.map((item) => item.id), input.attachmentIds);
    assert.equal(saved.attachments[1].createdAt, first.createdAt);
    assert.ok(saved.attachments.every((item) => item.status === "ready" && item.expiresAt && !Object.hasOwn(item, "dataBase64")));
    assert.deepEqual(await send(route), saved);
    assert.deepEqual(await send(route, "PUT", input), saved);
    const conflict = await send(route, "PUT", { ...input, mutationId: randomUUID() }, 409);
    assert.equal(conflict.details.code, "draft_conflict");
    assert.equal(JSON.stringify(conflict).includes(input.content), false);
    await send(`/api/media/chat-images/drafts/${saved.draftId}`, "DELETE", undefined, 409);
    const reordered = await send(route, "PUT", { ...input, expectedVersion: 1, mutationId: randomUUID(), attachmentIds: [first.id, second.id] });
    assert.deepEqual((await send(route)).attachments.map((item) => item.id), [first.id, second.id]);
    let single = await send(route, "PUT", { ...input, expectedVersion: reordered.version, mutationId: randomUUID(), attachmentIds: [first.id] });
    assert.equal(single.attachments.length, 1);
    const transferInput = { id: randomUUID(), expectedVersion: single.version, purpose: "queue" };
    const transfer = await send(`${route}/handoffs`, "POST", transferInput);
    assert.equal(transfer.draft.content, "");
    assert.equal(transfer.handoff.content, single.content);
    assert.equal(transfer.handoff.attachments[0].id, first.id);
    assert.deepEqual(await send(`${route}/handoffs`, "POST", transferInput), transfer);
    assert.equal((await send(`${route}/handoffs`)).length, 1);
    await send(`/api/media/chat-images/drafts/${transfer.handoff.draftId}`, "DELETE", undefined, 409);
    await send(`${route}/handoffs/${transfer.handoff.id}/restore`, "POST", { expectedVersion: single.version, mutationId: randomUUID() }, 409);
    const restoreInput = { expectedVersion: transfer.draft.version, mutationId: randomUUID() };
    single = await send(`${route}/handoffs/${transfer.handoff.id}/restore`, "POST", restoreInput);
    assert.equal(single.content, input.content);
    assert.equal(single.attachments[0].id, first.id);
    assert.deepEqual(await send(`${route}/handoffs/${transfer.handoff.id}/restore`, "POST", restoreInput), single);
    assert.equal((await send(`${route}/handoffs`)).length, 0);
    await send("/api/privacy/lock", "POST", { passcode: "controlled-draft-lock" }); locked = true;
    await send(route, "GET", undefined, 423);
    await send(route, "PUT", { ...input, expectedVersion: single.version, mutationId: randomUUID() }, 423);
    await send("/api/privacy/unlock", "POST", { passcode: "controlled-draft-lock" }); locked = false;
    assert.deepEqual(await send(route), single);
    await send(`/api/chats/${chat.id}`, "DELETE", undefined, 204);
    assert.deepEqual(await send(route), single);
    await send(route, "PUT", { ...input, expectedVersion: single.version, mutationId: randomUUID() }, 409);
    await send(`/api/chats/${chat.id}/restore`, "POST");
    assert.deepEqual(await send(route), single);
  } finally {
    if (locked) await send("/api/privacy/unlock", "POST", { passcode: "controlled-draft-lock" });
    await send(`/api/chats/${chat.id}`, "DELETE", undefined, 204);
    await send(`/api/chats/${chat.id}/permanent`, "DELETE", undefined, 204);
    await send(`/api/characters/${character.id}`, "DELETE", undefined, 204);
  }
  await send(route, "GET", undefined, 404);
};
