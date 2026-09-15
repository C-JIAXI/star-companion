import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("workspace layout capture uses synthetic data across target viewports", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const phase = process.env.LAYOUT_CAPTURE === "before" ? "before" : "after";
  const output = path.resolve("../../docs/chat-workspace-layout", phase, testInfo.project.name);
  await mkdir(output, { recursive: true });
  const characterResponse = await request.post("/api/characters", { data: {
    name: "Observatory guide", prompt: "Synthetic layout fixture. No model calls.",
    quickReplies: Array.from({ length: 8 }, (_, index) => ({ label: `Explore ${index + 1}`, content: `Synthetic choice ${index + 1}` }))
  } });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", { data: { title: "Evening at the observatory · Layout study", characterId: character.id } });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;
  try {
    for (let index = 0; index < 28; index++) {
      const response = await request.post("/api/messages", { data: {
        chatId: chat.id, role: index % 2 ? "assistant" : "user",
        content: `Scene ${index + 1}. ${index % 2 ? "The observatory lights glow softly. We can follow the map toward the garden, or pause here to watch the evening sky." : "Let us explore the garden together. What can we see beyond the window?"}`
      } });
      expect(response.ok()).toBeTruthy();
    }
    await page.addInitScript((id) => {
      localStorage.setItem("star-companion:selected-chat", id);
      localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
    }, chat.id);
    const settings = (await (await request.get("/api/settings")).json()).data;
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...settings, language: "en", appearancePreferences: { ...settings.appearancePreferences, themeMode: "dark", motion: "reduced" } } } });
    });
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768], [390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.locator("#chat-title")).toContainText(chat.title);
      await expect(page.locator("#chat-message-input")).toBeEditable();
      await page.locator("#chat-message-input").fill("A synthetic draft, preserved while changing the workspace layout.");
      await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(output, `${width}x${height}.png`), scale: "css" });
      if (phase === "after") {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      if (width === 1440) {
        await page.getByTestId("chat-agent-trigger").click();
        await expect(page.getByTestId("chat-agent-panel")).toBeVisible();
        await page.screenshot({ path: path.join(output, "1440x900-agent.png"), scale: "css" });
      }
    }
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
