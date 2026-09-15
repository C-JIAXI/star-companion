import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, expect, test } from "@playwright/test";

test("desktop browser 200 percent zoom reflows the workspace without hiding actions", async ({ request }, testInfo) => {
  test.setTimeout(90_000);
  const extension = path.resolve("e2e/fixtures/zoom-extension");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const character = (await (await request.post("/api/characters", { data: { name: "Synthetic zoom guide", prompt: "Synthetic zoom fixture" } })).json()).data;
  const chat = (await (await request.post("/api/chats", { data: { title: "Synthetic zoom conversation", characterId: character.id } })).json()).data;
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = context.pages()[0] ?? await context.newPage();
    await page.addInitScript((id) => {
      localStorage.setItem("star-companion:selected-chat", id);
      localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
    }, chat.id);
    await page.goto("http://127.0.0.1:5174/");
    await expect(page.locator("#chat-title")).toContainText(chat.title);
    await page.locator("#chat-message-input").fill("Synthetic zoom draft remains editable.");
    const initialWidth = await page.evaluate(() => innerWidth);
    const zoom = await worker.evaluate(async () => {
      const chromeApi = (globalThis as unknown as { chrome: { tabs: {
        query: (query: object) => Promise<Array<{ id: number; url?: string }>>;
        setZoom: (id: number, factor: number) => Promise<void>;
        getZoom: (id: number) => Promise<number>;
      } } }).chrome;
      const tab = (await chromeApi.tabs.query({})).find((entry) => entry.url?.startsWith("http://127.0.0.1:5174/"));
      if (!tab) throw new Error("Isolated test tab not found");
      await chromeApi.tabs.setZoom(tab.id, 2);
      return chromeApi.tabs.getZoom(tab.id);
    });
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(initialWidth / 2));
    await expect(page.locator("#chat-message-input")).toHaveValue("Synthetic zoom draft remains editable.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const output = path.resolve("../../docs/chat-workspace-layout/after", testInfo.project.name);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "desktop-200-percent-browser-zoom-composer.png") });
    await expect.poll(() => page.locator("#chat-primary-action").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottomOverflow: Math.max(0, rect.bottom - innerHeight), rightOverflow: Math.max(0, rect.right - innerWidth), topOverflow: Math.max(0, -rect.top) };
    })).toEqual({ bottomOverflow: 0, rightOverflow: 0, topOverflow: 0 });
    await page.getByTestId("chat-more-trigger").click();
    await page.getByTestId("chat-agent-trigger").click();
    await expect(page.getByTestId("chat-tools-panel")).toHaveAttribute("data-chat-tool-layout", "drawer");
    await page.screenshot({ path: path.join(output, "desktop-200-percent-browser-zoom.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-tools-panel")).toHaveCount(0);
  } finally {
    await context.close();
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
