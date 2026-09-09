import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";

const socketTurn = (baseUrl, input) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`), events = [];
  const timer = setTimeout(() => { socket.close(); reject(new Error("Controlled draft generation timed out")); }, 10_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify(input)));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)); events.push(message);
    if (["generation_done", "generation_stopped", "generation_status", "error"].includes(message.type)) { clearTimeout(timer); socket.close(); resolve(events); }
  });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Controlled draft socket failed")); });
});

/** Call only with an isolated backend configured to the smoke's local mock model. */
export const verifyDraftBudgetResume = async (baseUrl, modelCalls, failNextStream) => {
  const send = async (path, method = "GET", body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    assert.ok(response.ok, `Controlled draft budget fixture ${method} failed (${response.status})`);
    return response.status === 204 ? null : (await response.json()).data;
  };
  const settings = await send("/api/settings");
  const character = await send("/api/characters", "POST", { name: "Controlled budget draft", prompt: "Controlled fixture", prefix: "", suffix: "" });
  const chat = await send("/api/chats", "POST", { title: "Controlled budget draft", characterId: character.id });
  const path = `/api/chats/${chat.id}/draft`;
  try {
    await send("/api/settings", "PUT", { ...settings, usageBudgets: { allowUnknownPricing: false, dailyHardMicros: 0, monthlyHardMicros: 0 }, autoSummarizeUser: false });
    const draft = await send(path, "PUT", { content: "  Controlled blocked send\n ", attachmentIds: [], expectedVersion: 0, mutationId: randomUUID() });
    const handoff = await send(`${path}/handoffs`, "POST", { id: randomUUID(), expectedVersion: draft.version, purpose: "send" });
    const input = { type: "generate", chatId: chat.id, handoffId: handoff.handoff.id, requestId: handoff.handoff.id, content: "" };
    const calls = modelCalls();
    const blocked = await socketTurn(baseUrl, input);
    assert.equal(blocked.at(-1).modelError?.code, "budget_blocked");
    assert.equal(modelCalls(), calls);
    const messageId = blocked.find((event) => event.type === "user_message")?.message.id;
    assert.ok(messageId);
    const newer = await send(path, "PUT", { content: "Controlled newer composer", attachmentIds: [], expectedVersion: handoff.draft.version, mutationId: randomUUID() });
    const override = { ...input, requestId: randomUUID(), overrideHardBudget: true };
    const resumed = await socketTurn(baseUrl, override);
    assert.ok(resumed.some((event) => event.type === "assistant_token" || event.type === "token"), "Explicit budget override must generate, not just replay the user message receipt");
    assert.equal(resumed.find((event) => event.type === "user_message")?.message.id, messageId);
    assert.equal(modelCalls(), calls + 1);
    await socketTurn(baseUrl, override);
    await socketTurn(baseUrl, input);
    assert.equal(modelCalls(), calls + 1);
    assert.equal((await send(`/api/chats/${chat.id}`)).messages.filter((item) => item.role === "user").length, 1);
    assert.deepEqual(await send(path), newer);
    await send("/api/settings", "PUT", { ...settings, autoSummarizeUser: false });
    const partialHandoff = await send(`${path}/handoffs`, "POST", { id: randomUUID(), expectedVersion: newer.version, purpose: "send" });
    const partialInput = { ...input, requestId: partialHandoff.handoff.id, handoffId: partialHandoff.handoff.id };
    failNextStream();
    const partialEvents = await socketTurn(baseUrl, partialInput);
    assert.equal(partialEvents.at(-1).type, "error");
    assert.equal(partialEvents.at(-1).modelError?.receivedOutputTokens, true);
    const partialMessage = partialEvents.find((event) => event.type === "assistant_message")?.message;
    assert.ok(partialMessage?.content && partialMessage.generationMetadata?.incomplete);
    assert.equal((await send(path)).content, "");
    assert.equal((await send(`${path}/handoffs`)).length, 0);
    const afterPartial = modelCalls();
    await socketTurn(baseUrl, partialInput);
    assert.equal(modelCalls(), afterPartial);
    const messages = (await send(`/api/chats/${chat.id}`)).messages;
    assert.equal(messages.filter((item) => item.role === "user").length, 2);
    assert.ok(messages.some((item) => item.id === partialMessage.id && item.generationMetadata?.incomplete));
  } finally {
    await send("/api/settings", "PUT", settings);
    await send(`/api/chats/${chat.id}`, "DELETE"); await send(`/api/chats/${chat.id}/permanent`, "DELETE");
    await send(`/api/characters/${character.id}`, "DELETE");
  }
};

/** Same HTTP assertions against both isolated backends. No model calls or user data. */
export const verifyChatDraftContract = async (baseUrl, restart) => {
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
    if (restart) { await restart(); assert.deepEqual(await send(route), saved); }
    const health = await send("/api/storage-health/summary");
    const draftCategory = health.categories.find((item) => item.id === "chat_drafts");
    assert.ok(draftCategory?.count >= 1 && draftCategory.bytes >= Buffer.byteLength(input.content));
    assert.equal(draftCategory.measurement, "estimated");
    assert.equal(JSON.stringify(health).includes(input.content), false);
    const cleanup = await send("/api/storage-health/cleanup-plans", "POST", { actions: ["orphan_media", "expired_drafts"] }, 201);
    await send(`/api/storage-health/cleanup-plans/${cleanup.id}/execute`, "POST", { confirm: "EXECUTE_STORAGE_CLEANUP" });
    assert.deepEqual(await send(route), saved);
    assert.equal((await fetch(`${baseUrl}${saved.attachments[0].url}`)).status, 200);
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
    await send(`${route}/handoffs`, "GET", undefined, 423);
    await send(`${route}/handoffs`, "POST", { id: randomUUID(), expectedVersion: single.version, purpose: "send" }, 423);
    await send(`${route}/handoffs/${transfer.handoff.id}`, "GET", undefined, 423);
    await send(`${route}/handoffs/${transfer.handoff.id}`, "DELETE", undefined, 423);
    await send(`${route}/handoffs/${transfer.handoff.id}/restore`, "POST", restoreInput, 423);
    await send("/api/messages", "POST", { chatId: chat.id, role: "user", content: "", handoffId: transfer.handoff.id }, 423);
    await send("/api/privacy/unlock", "POST", { passcode: "controlled-draft-lock" }); locked = false;
    assert.deepEqual(await send(route), single);
    await send(`/api/chats/${chat.id}`, "DELETE", undefined, 204);
    assert.deepEqual(await send(route), single);
    await send(route, "PUT", { ...input, expectedVersion: single.version, mutationId: randomUUID() }, 409);
    await send(`${route}/handoffs`, "POST", { id: randomUUID(), expectedVersion: single.version, purpose: "send" }, 409);
    await send(`/api/chats/${chat.id}/restore`, "POST");
    assert.deepEqual(await send(route), single);
    // Ignore the initial receipt, then replay over HTTP and a fresh socket.
    // This does not call a model, even with no ModelRequest ledger entry.
    const pendingSend = await send(`${route}/handoffs`, "POST", { id: randomUUID(), expectedVersion: single.version, purpose: "send" });
    const messageInput = { chatId: chat.id, role: "user", content: "", handoffId: pendingSend.handoff.id };
    const committed = await send("/api/messages", "POST", messageInput, 201);
    const newer = await send(route, "PUT", { expectedVersion: pendingSend.draft.version, mutationId: randomUUID(), content: "  Controlled newer draft\n ", attachmentIds: [] });
    const replay = await send("/api/messages", "POST", messageInput, 201);
    assert.equal(replay.id, committed.id);
    const events = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
      const received = [];
      const timer = setTimeout(() => { socket.close(); reject(new Error("Draft receipt replay timed out")); }, 5000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "generate", requestId: pendingSend.handoff.id, ...messageInput })));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") return;
        received.push(message);
        if (message.type === "generation_done" || message.type === "generation_status" || message.type === "error") {
          clearTimeout(timer); socket.close(); resolve(received);
        }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Draft receipt socket failed")); });
    });
    assert.deepEqual(events.map((event) => event.type), ["user_message", "generation_done"]);
    assert.equal(events[0].message.id, committed.id);
    assert.equal((await send(`/api/chats/${chat.id}`)).messages.length, 1);
    assert.deepEqual(await send(route), newer);
    assert.equal((await send(`${route}/handoffs`)).length, 0);
    assert.equal(committed.attachments[0].assetId, first.assetId);
  } finally {
    if (locked) await send("/api/privacy/unlock", "POST", { passcode: "controlled-draft-lock" });
    await send(`/api/chats/${chat.id}`, "DELETE", undefined, 204);
    await send(`/api/chats/${chat.id}/permanent`, "DELETE", undefined, 204);
    await send(`/api/characters/${character.id}`, "DELETE", undefined, 204);
  }
  await send(route, "GET", undefined, 404);
};
