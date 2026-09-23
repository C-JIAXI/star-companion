import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const { PNG } = require("../../server/node_modules/pngjs");

test("composer remains usable with images and a simulated reduced visual viewport", async ({ page, request }, testInfo) => {
  const character = (await (await request.post("/api/characters", { data: {
    name: "Synthetic compact workspace", prompt: "Layout test only.",
    quickReplies: Array.from({ length: 8 }, (_, i) => ({ id: `stress-${i}`, label: `Choice ${i}`, content: `Choice ${i}` }))
  } })).json()).data;
  const chat = (await (await request.post("/api/chats", { data: { title: "Compact workspace fixture", characterId: character.id } })).json()).data;
  const settings = (await (await request.get("/api/settings")).json()).data;
  await page.route("**/api/usage/preview", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ json: { ...payload, data: { ...payload.data, hardBlocked: true } } });
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { ok: true, data: { ...settings, language: "en", hasApiKey: true,
      activeProviderId: "stress-provider", activeModelId: "stress-model",
      providers: [{ id: "stress-provider", label: "Fixture", provider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", models: [{ id: "stress-model", label: "Fixture vision", model: "fixture", capabilities: ["text_generation", "vision_input"] }] }],
      appearancePreferences: { ...settings.appearancePreferences, themeMode: "dark", fontSize: "extra-large", motion: "reduced" }
    } } });
  });
  await page.addInitScript((id) => {
    localStorage.setItem("star-companion:selected-chat", id);
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
  }, chat.id);
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    const input = page.locator("#chat-message-input");
    await expect(input).toBeEditable();
    const draft = Array.from({ length: 40 }, (_, i) => `Synthetic line ${i}`).join("\n");
    await input.fill(draft);
    await page.getByLabel("Choose chat images").setInputFiles([30, 180].map((color) => ({
      name: `fixture-${color}.png`, mimeType: "image/png",
      buffer: PNG.sync.write({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 4 }, () => [color, 60, 90, 255]).flat()) })
    })));
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(2);
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    // This is a visualViewport API simulation, not a real device keyboard test.
    for (const height of [568, 360]) {
      await page.evaluate((value) => {
        Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => value });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, height);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect.poll(() => page.evaluate((limit) => {
        const input = document.querySelector("#chat-message-input")!.getBoundingClientRect();
        const send = document.querySelector("#chat-primary-action")!.getBoundingClientRect();
        return { inputTop: Math.min(0, input.top), inputBottom: Math.max(0, input.bottom - limit), sendTop: Math.min(0, send.top), sendBottom: Math.max(0, send.bottom - limit), horizontal: Math.max(0, document.documentElement.scrollWidth - innerWidth) };
      }, height)).toEqual({ inputTop: 0, inputBottom: 0, sendTop: 0, sendBottom: 0, horizontal: 0 });
      await expect(input).toHaveValue(draft);
      await expect.poll(() => page.locator("#chat-composer").evaluate((element, limit) => element.getBoundingClientRect().bottom <= limit, height)).toBe(true);
      await page.getByTestId("chat-image-draft").getByRole("button", { name: "Move image later" }).first().click();
      await expect(input).toHaveValue(draft);
      const cost = page.getByTestId("chat-cost-preview");
      await expect(cost.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      await cost.getByRole("button").click();
      await expect(cost.getByRole("button")).toHaveAttribute("aria-expanded", "true");
      await cost.getByRole("button").click();
      await expect(page.getByTestId("chat-budget-warning")).toBeVisible();
      await page.getByTestId("chat-budget-warning").scrollIntoViewIfNeeded();
      await expect(input).toHaveValue(draft);
    }
    const output = path.resolve("../../docs/chat-workspace-layout/after", testInfo.project.name);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "320px-images-large-font-simulated-keyboard.png"), clip: { x: 0, y: 0, width: 320, height: 360 }, scale: "css" });
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
