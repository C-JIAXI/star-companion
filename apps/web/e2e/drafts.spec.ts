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
