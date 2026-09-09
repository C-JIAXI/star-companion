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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
  });
  await page.route("**/api/settings", async (route) => {
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
