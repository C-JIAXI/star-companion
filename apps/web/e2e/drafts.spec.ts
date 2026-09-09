import { createRequire } from "node:module";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const { PNG } = require("../../server/node_modules/pngjs");
const controlledImage = (color: number) => ({
  name: `draft-fixture-${color}.png`,
  mimeType: "image/png",
  buffer: PNG.sync.write({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 4 }, () => [color, 30, 120, 255]).flat()) }) as Buffer
});

async function selectChat(page: Page, title: string) {
  if ((page.viewportSize()?.width ?? 1024) < 1024) {
    await page.getByRole("button", { name: "Toggle navigation" }).click();
  }
  await page.getByRole("button", { name: /历史|History/ }).click();
  await page.getByPlaceholder(/搜索历史对话|Search chat history/).fill(title);
  await page.locator("[data-chat-history-title]").filter({ hasText: title }).first().click();
  await expect(page.locator("#chat-title")).toContainText(title);
}

async function createFixture(request: APIRequestContext, suffix: string) {
  const characterResponse = await request.post("/api/characters", {
    data: { name: `Draft fixture ${suffix}`, prefix: "", prompt: "Controlled draft fixture.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data as { id: string };
  const chats: Array<{ id: string; title: string }> = [];
  for (const label of ["A", "B"]) {
    const response = await request.post("/api/chats", { data: { title: `Draft ${label} ${suffix}`, characterId: character.id } });
    expect(response.ok()).toBeTruthy();
    chats.push((await response.json()).data);
  }
  return {
    chats,
    async dispose() {
      for (const chat of chats) {
        await request.delete(`/api/chats/${chat.id}`);
        await request.delete(`/api/chats/${chat.id}/permanent`);
      }
      await request.delete(`/api/characters/${character.id}`);
    }
  };
}

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
  });
  await context.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const now = new Date().toISOString();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
      id: "draft-settings-fixture", activeProvider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", model: "vision-model",
      temperature: 0.8, maxTokens: 800, topP: 1, language: "en",
      providers: [{ id: "vision-provider", label: "Vision provider", provider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", models: [{ id: "vision-model-id", label: "Vision model", model: "vision-model", capabilities: ["text_generation", "vision_input"] }] }],
      activeProviderId: "vision-provider", activeModelId: "vision-model-id", moduleModelPreferences: {}, userPersonaPresets: [], userProfileSummary: "", autoSummarizeUser: false,
      showMessageAvatars: true, showMessageTimestamps: false, ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false,
      userProfileUpdatedAt: null, createdAt: now, updatedAt: now, hasApiKey: true
    } }) });
  });
});

test("failed autosave retains edits and retry persists the exact draft", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `save-failure-${testInfo.project.name}-${Date.now()}`);
  const chat = fixture.chats[0];
  let failSave = true;
  await page.route(`**/api/chats/${chat.id}/draft`, async (route) => {
    if (failSave && route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Controlled storage failure" }) });
    else await route.continue();
  });
  try {
    await page.goto("/"); await selectChat(page, chat.title);
    await page.locator("#chat-message-input").fill("  Controlled retry\n ");
    await expect(page.getByTestId("chat-draft-status")).toContainText("Save failed");
    await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled retry\n ");
    failSave = false;
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await page.reload(); await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled retry\n ");
  } finally { await fixture.dispose(); }
});

test("stale tab preserves edits and requires explicit conflict resolution", async ({ page, context, request }, testInfo) => {
  const fixture = await createFixture(request, `tabs-${testInfo.project.name}-${Date.now()}`);
  const second = await context.newPage();
  try {
    await page.goto("/"); await selectChat(page, fixture.chats[0].title);
    await second.goto("/"); await selectChat(second, fixture.chats[0].title);
    await page.locator("#chat-message-input").fill("Controlled first tab");
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await second.locator("#chat-message-input").fill("Controlled second tab");
    await expect(second.getByTestId("chat-draft-status")).toContainText("Draft conflict");
    await expect(second.locator("#chat-message-input")).toHaveValue("Controlled second tab");
    const remote = await request.get(`/api/chats/${fixture.chats[0].id}/draft`);
    expect((await remote.json()).data.content).toBe("Controlled first tab");
    await second.getByRole("button", { name: "Keep my version", exact: true }).click();
    await second.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(second.getByTestId("chat-draft-status")).toContainText("Saved");
    await second.reload(); await expect(second.locator("#chat-message-input")).toHaveValue("Controlled second tab");
  } finally { await second.close(); await fixture.dispose(); }
});

test("legacy text migrates only after backend acknowledgement", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `legacy-${testInfo.project.name}-${Date.now()}`);
  const chat = fixture.chats[0];
  const legacyKey = `star-companion:chat-draft:${chat.id}`;
  await page.addInitScript(({ key }) => { if (!sessionStorage.getItem("controlled-legacy-seeded")) { localStorage.setItem(key, "  Controlled legacy\n "); sessionStorage.setItem("controlled-legacy-seeded", "yes"); } }, { key: legacyKey });
  let failSave = true;
  await page.route(`**/api/chats/${chat.id}/draft`, async (route) => {
    if (route.request().method() === "PUT" && failSave) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Controlled migration failure" }) });
    else await route.continue();
  });
  try {
    await page.goto("/"); await selectChat(page, chat.title);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Save failed");
    expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBe("  Controlled legacy\n ");
    failSave = false;
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBeNull();
    await page.reload(); await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled legacy\n ");
  } finally { await fixture.dispose(); }
});

test("complete chat drafts preserve exact text and image order across switching and reload", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `${testInfo.project.name}-${Date.now()}`);
  const [first, second] = fixture.chats;
  const text = "  Controlled unsent draft\n\nKeep spaces here.  ";
  let generationRequests = 0;
  page.on("websocket", (socket) => socket.on("framesent", (frame) => {
    if (JSON.parse(String(frame.payload)).type === "generate") generationRequests += 1;
  }));
  try {
    await page.goto("/");
    await selectChat(page, first.title);
    const composer = page.locator("#chat-message-input");
    await composer.fill(text);
    await page.getByLabel("Choose chat images").setInputFiles([controlledImage(50), controlledImage(210)]);
    const gallery = page.getByTestId("chat-image-draft");
    await expect(gallery.getByRole("img")).toHaveCount(2);
    const originalSources = await gallery.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")));
    expect(new Set(originalSources).size).toBe(2);
    await gallery.getByRole("button", { name: "Move image later" }).first().click();
    await expect.poll(() => gallery.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual([...originalSources].reverse());

    await selectChat(page, second.title);
    await expect(composer).toHaveValue("");
    await expect(gallery.getByRole("img")).toHaveCount(0);
    await composer.fill("Controlled second chat draft");
    await selectChat(page, first.title);
    await expect(composer).toHaveValue(text);
    await expect(gallery.getByRole("img")).toHaveCount(2);
    await expect.poll(() => gallery.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual([...originalSources].reverse());

    await page.reload();
    await expect(composer).toHaveValue(text);
    await expect.poll(() => gallery.getByRole("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual([...originalSources].reverse());
    await gallery.getByRole("button", { name: "Remove image" }).first().click();
    await expect(gallery.getByRole("img")).toHaveCount(1);
    await page.reload();
    await expect(composer).toHaveValue(text);
    await expect(gallery.getByRole("img")).toHaveCount(1);
    await expect(gallery.getByRole("img")).toHaveAttribute("src", originalSources[0]!);
    await selectChat(page, second.title);
    await expect(composer).toHaveValue("Controlled second chat draft");
    expect(generationRequests).toBe(0);
    for (const chat of fixture.chats) {
      const response = await request.get(`/api/chats/${chat.id}`);
      expect((await response.json()).data.messages).toHaveLength(0);
    }
  } finally {
    await fixture.dispose();
  }
});

test("a delayed save remains scoped to its chat during rapid switching", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `rapid-${testInfo.project.name}-${Date.now()}`);
  const [first, second] = fixture.chats;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route(`**/api/chats/${first.id}/draft`, async (route) => {
    if (route.request().method() === "PUT") { held = true; await gate; }
    await route.continue();
  });
  try {
    await page.goto("/"); await selectChat(page, first.title);
    await page.locator("#chat-message-input").fill("  Controlled A\n ");
    await expect.poll(() => held).toBe(true);
    await selectChat(page, second.title);
    await page.locator("#chat-message-input").fill("Controlled B");
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    release();
    await expect.poll(async () => (await (await request.get(`/api/chats/${first.id}/draft`)).json()).data.content).toBe("  Controlled A\n ");
    await expect(page.locator("#chat-message-input")).toHaveValue("Controlled B");
    await selectChat(page, first.title);
    await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled A\n ");
    await page.reload(); await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled A\n ");
  } finally { release(); await fixture.dispose(); }
});

test("late send acknowledgement cannot clear newly typed text or images", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `late-ack-${testInfo.project.name}-${Date.now()}`);
  let acknowledge: (() => void) | undefined;
  let generations = 0;
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage(async (data) => {
      const input = JSON.parse(String(data));
      if (input.type !== "generate") return;
      generations += 1;
      const response = await request.post("/api/messages", { data: { chatId: input.chatId, role: "user", content: "", handoffId: input.handoffId } });
      expect(response.ok()).toBeTruthy();
      const message = (await response.json()).data;
      acknowledge = () => {
        socket.send(JSON.stringify({ type: "user_message", requestId: input.requestId, message }));
        socket.send(JSON.stringify({ type: "generation_done", requestId: input.requestId }));
      };
    });
  });
  try {
    await page.goto("/"); await selectChat(page, fixture.chats[0].title);
    const composer = page.locator("#chat-message-input");
    await composer.fill("Controlled sent text");
    await page.getByLabel("Choose chat images").setInputFiles(controlledImage(35));
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();
    await expect.poll(() => !!acknowledge).toBe(true);
    await composer.fill("  Controlled newer text\n ");
    await page.getByLabel("Choose chat images").setInputFiles(controlledImage(45));
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    acknowledge!();
    await expect(page.locator('[data-chat-message="user"]')).toHaveCount(1);
    await expect(composer).toHaveValue("  Controlled newer text\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await page.locator('[data-chat-message="user"] [data-chat-action="edit"]').click();
    const editor = page.getByRole("dialog", { name: "Edit Message", exact: true });
    await expect(editor.getByTestId("edit-message-images").getByRole("img")).toHaveCount(1);
    await editor.getByRole("button", { name: "Remove image", exact: true }).click();
    await editor.locator("textarea").fill("Controlled historical edit");
    await editor.getByRole("button", { name: "Save Edit", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(composer).toHaveValue("  Controlled newer text\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await page.reload();
    await expect(composer).toHaveValue("  Controlled newer text\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    expect(generations).toBe(1);
  } finally { await fixture.dispose(); }
});

test("lost queue-save acknowledgement retains text and images for explicit recovery", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `queue-failure-${testInfo.project.name}-${Date.now()}`);
  const chat = fixture.chats[0];
  let generations = 0;
  await page.routeWebSocket("**/ws", (socket) => socket.onMessage(async (raw) => {
    const input = JSON.parse(String(raw));
    if (input.type !== "generate") return;
    generations += 1;
    const response = await request.post("/api/messages", { data: { chatId: chat.id, role: "user", content: "", handoffId: input.handoffId } });
    socket.send(JSON.stringify({ type: "user_message", requestId: input.requestId, message: (await response.json()).data }));
    socket.send(JSON.stringify({ type: "generation_started", requestId: input.requestId }));
  }));
  let failOnce = true;
  const queueIds: string[] = [];
  await page.route(`**/api/chats/${chat.id}/draft/handoffs`, async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().purpose === "queue") {
      queueIds.push(route.request().postDataJSON().id);
      if (failOnce) {
        failOnce = false;
        const saved = await route.fetch(); expect(saved.ok()).toBeTruthy();
        await route.fulfill({ status: 503, json: { ok: false, error: "Controlled lost acknowledgement" } }); return;
      }
    }
    await route.continue();
  });
  try {
    await page.goto("/"); await selectChat(page, chat.title);
    const composer = page.locator("#chat-message-input");
    await composer.fill("Controlled active turn");
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();
    await expect.poll(() => generations).toBe(1);
    await composer.fill("  Controlled queued draft\n ");
    await page.getByLabel("Choose chat images").setInputFiles(controlledImage(65));
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await page.locator('#chat-primary-action[data-chat-action="queue"]').click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Save failed");
    await expect(composer).toHaveValue("  Controlled queued draft\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByTestId("recoverable-draft")).toHaveCount(1);
    expect(queueIds).toHaveLength(2); expect(queueIds[0]).toBe(queueIds[1]);
    await page.reload();
    await expect(page.getByTestId("recoverable-draft")).toHaveCount(1);
    let failRestore = true;
    const restoreIds: string[] = [];
    await page.route("**/draft/handoffs/*/restore", async (route) => {
      restoreIds.push(route.request().postDataJSON().mutationId);
      if (failRestore) {
        failRestore = false;
        expect((await route.fetch()).ok()).toBeTruthy();
        await route.fulfill({ status: 503, json: { ok: false, error: "Controlled lost restore acknowledgement" } });
      } else await route.continue();
    });
    await page.getByTestId("recoverable-draft").getByRole("button", { name: /Restore/ }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Save failed");
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(composer).toHaveValue("  Controlled queued draft\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    expect(restoreIds).toHaveLength(2); expect(restoreIds[0]).toBe(restoreIds[1]);
    expect(generations).toBe(1);
  } finally { await fixture.dispose(); }
});

test("missing image reads and expiry preserve text with removable placeholders", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `unavailable-${testInfo.project.name}-${Date.now()}`);
  await page.clock.install();
  let missingUrl = "";
  await page.route("**/api/media/chat-images/*", async (route) => {
    if (route.request().method() === "GET" && missingUrl && route.request().url().endsWith(missingUrl)) {
      await route.fulfill({ status: 404, json: { ok: false, error: "Controlled unavailable image" } });
    } else await route.continue();
  });
  try {
    await page.goto("/"); await selectChat(page, fixture.chats[0].title);
    const composer = page.locator("#chat-message-input");
    await composer.fill("  Controlled text survives\n ");
    await page.getByLabel("Choose chat images").setInputFiles([controlledImage(75), controlledImage(85)]);
    const gallery = page.getByTestId("chat-image-draft");
    await expect(gallery.getByRole("img")).toHaveCount(2);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    missingUrl = new URL((await gallery.getByRole("img").first().getAttribute("src"))!, "http://127.0.0.1:4010").pathname;
    await page.reload();
    await expect(gallery.locator('[data-image-status="missing"]')).toHaveCount(1);
    await expect(composer).toHaveValue("  Controlled text survives\n ");
    await expect(page.locator('#chat-primary-action[data-chat-action="send"]')).toBeDisabled();
    await gallery.locator('[data-image-status="missing"]').getByRole("button", { name: "Remove image" }).click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await page.clock.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    await page.clock.fastForward(16_000);
    await expect(gallery.locator('[data-image-status="expired"]')).toHaveCount(1);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Your text is preserved");
    await expect(composer).toHaveValue("  Controlled text survives\n ");
    await gallery.getByRole("button", { name: "Remove image" }).click();
    await expect(gallery.getByRole("img")).toHaveCount(0);
    await page.getByLabel("Choose chat images").setInputFiles(controlledImage(95));
    await expect(gallery.getByRole("img")).toHaveCount(1);
    await expect(composer).toHaveValue("  Controlled text survives\n ");
  } finally { await fixture.dispose(); }
});

test("legacy conflict waits for unlock and lock discards only uncommitted memory", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `locked-legacy-${testInfo.project.name}-${Date.now()}`);
  const chat = fixture.chats[0], legacyKey = `star-companion:chat-draft:${chat.id}`;
  await request.put(`/api/chats/${chat.id}/draft`, { data: { expectedVersion: 0, mutationId: "controlled-legacy-existing", content: "Controlled backend draft", attachmentIds: [] } });
  await page.addInitScript(({ id, key }) => {
    localStorage.setItem("star-companion:selected-chat", id);
    if (!sessionStorage.getItem("controlled-legacy-once")) { localStorage.setItem(key, "  Controlled legacy alternative\n "); sessionStorage.setItem("controlled-legacy-once", "true"); }
  }, { id: chat.id, key: legacyKey });
  let locked = true, draftRequests = 0, lockNextSave = false;
  await page.route("**/api/privacy/status", (route) => route.fulfill({ json: { ok: true, data: { locked } } }));
  await page.route("**/api/privacy/unlock", async (route) => { locked = false; await route.fulfill({ json: { ok: true, data: { locked: false } } }); });
  await page.route(`**/api/chats/${chat.id}/draft`, async (route) => {
    draftRequests += 1;
    if (lockNextSave && route.request().method() === "PUT") { locked = true; lockNextSave = false; }
    if (locked) await route.fulfill({ status: 423, json: { ok: false, error: "App is locked." } });
    else await route.continue();
  });
  const unlock = async () => {
    await page.getByTestId("privacy-unlock-input").fill("controlled-code");
    await page.getByTestId("privacy-unlock-submit").click();
  };
  try {
    await page.goto("/");
    await expect(page.getByTestId("privacy-lock-screen")).toBeVisible();
    expect(draftRequests).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBe("  Controlled legacy alternative\n ");
    await unlock();
    await expect(page.getByTestId("chat-draft-status")).toContainText("legacy browser draft");
    await expect(page.locator("#chat-message-input")).toHaveValue("Controlled backend draft");
    expect((await (await request.get(`/api/chats/${chat.id}/draft`)).json()).data.content).toBe("Controlled backend draft");
    await page.getByRole("button", { name: "Use legacy text", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBeNull();
    await page.getByLabel("Choose chat images").setInputFiles(controlledImage(115));
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
    await expect.poll(async () => (await (await request.get(`/api/chats/${chat.id}/draft`)).json()).data.attachments.length).toBe(1);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    lockNextSave = true;
    await page.locator("#chat-message-input").fill("Controlled unsaved memory");
    await expect(page.getByTestId("privacy-lock-screen")).toBeVisible();
    await expect(page.locator("#chat-message-input")).toHaveCount(0);
    await expect(page.getByTestId("chat-image-draft")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Controlled unsaved memory");
    await expect(page.locator("body")).not.toContainText("draft-fixture-115");
    await unlock();
    await expect(page.locator("#chat-message-input")).toHaveValue("  Controlled legacy alternative\n ");
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(1);
  } finally { await fixture.dispose(); }
});

test("explicit budget retry retains the original handoff identity after status recovery", async ({ page, request }, testInfo) => {
  const fixture = await createFixture(request, `budget-${testInfo.project.name}-${Date.now()}`);
  const generated: Array<{ requestId: string; handoffId: string; overrideHardBudget?: boolean }> = [];
  let completed = 0;
  const safeError = { code: "budget_blocked", retryable: false, receivedOutputTokens: false, provider: "", modelId: "", attempt: 1, summary: "Controlled budget block", diagnosticId: "controlled-budget" };
  await page.routeWebSocket("**/ws", (socket) => socket.onMessage(async (raw) => {
    const input = JSON.parse(String(raw));
    if (input.type === "status") {
      socket.send(JSON.stringify({ type: "generation_status", request: { requestId: input.requestId, chatId: fixture.chats[0].id, status: "blocked", outputStarted: false, error: safeError } })); return;
    }
    if (input.type !== "generate") return;
    generated.push(input);
    const response = await request.post("/api/messages", { data: { chatId: input.chatId, role: "user", content: "", handoffId: input.handoffId } });
    socket.send(JSON.stringify({ type: "user_message", requestId: input.requestId, message: (await response.json()).data }));
    socket.send(JSON.stringify(generated.length === 1
      ? { type: "error", requestId: input.requestId, error: safeError.summary, modelError: safeError }
      : { type: "generation_done", requestId: input.requestId }));
    completed += 1;
  }));
  try {
    await page.goto("/"); await selectChat(page, fixture.chats[0].title);
    await page.locator("#chat-message-input").fill("Controlled budget request");
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();
    await page.getByRole("button", { name: "Authorize this request only", exact: true }).click();
    await expect.poll(() => generated.length).toBe(2);
    expect(generated[1].handoffId).toBe(generated[0].handoffId);
    expect(generated[1].requestId).not.toBe(generated[0].requestId);
    expect(generated[1].overrideHardBudget).toBe(true);
    await expect.poll(() => completed).toBe(2);
    await expect(page.locator('[data-chat-message="user"]')).toHaveCount(1);
  } finally { await fixture.dispose(); }
});
