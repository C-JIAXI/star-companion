import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("workspace layout capture uses synthetic data across target viewports", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const phase = process.env.LAYOUT_CAPTURE === "before" ? "before" : "after";
  const output = path.resolve("../../docs/chat-workspace-layout", phase, testInfo.project.name);
  await mkdir(output, { recursive: true });
  const characterResponse = await request.post("/api/characters", { data: {
    name: "Observatory guide", prompt: "Synthetic layout fixture. No model calls.",
    quickReplies: Array.from({ length: 8 }, (_, index) => ({ id: `layout-reply-${index}`, label: `Explore ${index + 1}`, content: `Synthetic choice ${index + 1}` }))
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
    let captureAppearance: Record<string, string> = { themeMode: "dark", motion: "reduced" };
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...settings, language: "en", appearancePreferences: { ...settings.appearancePreferences, ...captureAppearance } } } });
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
        await expect(page.locator("[data-chat-quick-reply]")).toHaveCount(8);
        await expect(page.locator("#chat-quick-replies-toggle")).toHaveAttribute("aria-expanded", "false");
        await page.locator("#chat-quick-replies-toggle").click();
        await expect(page.locator("#chat-quick-replies-toggle")).toHaveAttribute("aria-expanded", "true");
        await page.locator("#chat-quick-replies-toggle").click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByTestId("chat-workspace-header")).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector("#chat-message-list")!.getBoundingClientRect().width - document.querySelector("#chat-composer")!.getBoundingClientRect().width))).toBeLessThan(2);
        await expect.poll(() => page.evaluate(() => {
          const input = document.querySelector("#chat-message-input")!.getBoundingClientRect();
          const toolbar = document.querySelector('[data-testid="chat-composer-toolbar"]')!.getBoundingClientRect();
          const status = document.querySelector('[data-testid="chat-draft-status"]')!.getBoundingClientRect();
          return input.bottom <= toolbar.top + 1 && toolbar.bottom <= status.top + 1;
        })).toBe(true);
        await page.locator("#chat-message-input").fill(Array.from({ length: 40 }, (_, index) => `Synthetic long draft line ${index}`).join("\n"));
        await expect.poll(async () => (await page.locator("#chat-message-input").boundingBox())!.height).toBeLessThanOrEqual(height * 0.2 + 2);
        const sendBox = await page.locator("#chat-primary-action").boundingBox();
        expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(height);
        expect(await page.locator("#chat-message-input").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await page.locator("#chat-message-input").fill("A synthetic draft, preserved while changing the workspace layout.");
        const titleBox = await page.locator("#chat-title").boundingBox();
        expect(titleBox!.width).toBeGreaterThan(60);
        if (width < 640) {
          const searchBox = await page.getByTestId("chat-search-trigger").boundingBox();
          const moreBox = await page.getByTestId("chat-more-trigger").boundingBox();
          expect(searchBox!.height).toBeGreaterThanOrEqual(44);
          expect(moreBox!.height).toBeGreaterThanOrEqual(44);
          expect(searchBox!.y).toBeLessThan(titleBox!.y + titleBox!.height);
          await page.getByTestId("chat-more-trigger").click();
          await expect(page.getByRole("menu")).toBeVisible();
          await page.keyboard.press("End");
          await expect(page.getByRole("menuitem", { name: "Move to trash", exact: true })).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("menu")).toHaveCount(0);
          await expect(page.getByTestId("chat-more-trigger")).toBeFocused();
        }
      }
      if (width === 1440) {
        let anchor: { id: string; offset: number } | null = null;
        if (phase === "after") {
          anchor = await page.locator("#chat-message-viewport").evaluate(async (viewport) => {
            viewport.style.scrollBehavior = "auto";
            const message = viewport.querySelectorAll<HTMLElement>("[data-message-id]")[12];
            viewport.scrollTop += message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20;
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return { id: message.dataset.messageId!, offset: message.getBoundingClientRect().top - viewport.getBoundingClientRect().top };
          });
        }
        if (phase === "after") await page.getByTestId("chat-more-trigger").click();
        await page.getByTestId("chat-agent-trigger").click();
        await expect(page.getByTestId("chat-agent-panel")).toBeVisible();
        if (phase === "after") {
          const tool = page.getByTestId("chat-tools-panel");
          await expect(tool).toHaveAttribute("data-chat-tool-layout", "docked");
          const assertAnchor = async () => {
            await expect.poll(async () => page.locator("#chat-message-viewport").evaluate((viewport, expected) => {
              const message = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]")).find((element) => element.dataset.messageId === expected.id)!;
              return Math.abs(message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - expected.offset);
            }, anchor!)).toBeLessThan(3);
          };
          await assertAnchor();
          await page.locator("#chat-message-input").focus();
          await page.getByTestId("chat-sidebar-collapse").click();
          await expect(page.locator("#chat-message-input")).toBeFocused();
          await assertAnchor();
          await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
          await expect(page.locator("#chat-message-input")).toBeFocused();
          await assertAnchor();
          await page.evaluate(() => { document.documentElement.dataset.fontSize = "large"; });
          await assertAnchor();
          await page.evaluate(() => { document.documentElement.dataset.fontSize = "standard"; });
          await assertAnchor();
          const toolBox = await tool.boundingBox();
          const composerBox = await page.locator("#chat-composer").boundingBox();
          expect(toolBox).not.toBeNull();
          expect(composerBox).not.toBeNull();
          expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(toolBox!.x + 1);
          const focusDraft = tool.locator("textarea");
          await focusDraft.fill("Synthetic unapplied agent focus");
          await page.getByTestId("chat-tool-settings").click();
          await expect(page.getByTestId("chat-agent-panel")).toBeHidden();
          await page.getByTestId("chat-tool-memory").click();
          const memoryTurns = tool.locator('input[type="number"]').first();
          await memoryTurns.fill("17");
          await page.getByTestId("chat-tool-story").click();
          await page.getByTestId("chat-tool-memory").click();
          await expect(memoryTurns).toHaveValue("17");
          await page.getByTestId("chat-tool-agent").click();
          await expect(focusDraft).toHaveValue("Synthetic unapplied agent focus");
          await page.setViewportSize({ width: 390, height: 844 });
          await expect(tool).toHaveAttribute("data-chat-tool-layout", "drawer");
          await expect(focusDraft).toHaveValue("Synthetic unapplied agent focus");
          await page.keyboard.press("Escape");
          await expect(tool).toHaveCount(0);
          await page.setViewportSize({ width, height });
          await page.getByTestId("chat-more-trigger").click();
          await page.getByTestId("chat-agent-trigger").click();
          await expect(tool.locator("textarea")).toHaveValue("Synthetic unapplied agent focus");
          await expect(page.locator("#chat-message-input")).toHaveValue("A synthetic draft, preserved while changing the workspace layout.");
        }
        await page.screenshot({ path: path.join(output, "1440x900-agent.png"), scale: "css" });
      }
    }
    if (phase === "after") {
      await request.put(`/api/characters/${character.id}`, { data: { htmlCss: "#chat-panel, #chat-composer, #chat-message-input, #chat-settings-trigger { display:none!important; width:0!important; height:0!important; transform:scale(0)!important; position:fixed!important; } #chat-composer { border-color:rgb(34,197,94)!important; }" } });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await expect(page.locator("#chat-message-input")).toBeEditable();
      await expect(page.getByTestId("chat-more-trigger")).toBeVisible();
      await expect(page.locator("#chat-composer")).toHaveCSS("border-top-color", "rgb(34, 197, 94)");
      for (const theme of ["light", "dark"]) {
        captureAppearance = { themeMode: theme, fontSize: "extra-large", contrast: "high", motion: "reduced" };
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("html")).toHaveAttribute("data-font-size", "extra-large");
        await page.getByTestId("chat-more-trigger").click();
        await page.getByTestId("chat-agent-trigger").click();
        await expect(page.getByTestId("chat-tools-panel")).toBeVisible();
        const result = await new AxeBuilder({ page }).include('[data-testid="chat-tools-panel"]')
          .withRules(["button-name", "color-contrast", "label"]).analyze();
        expect(result.violations).toEqual([]);
        await page.screenshot({ path: path.join(output, `390x844-${theme}-large-tools.png`), scale: "css" });
        await page.getByRole("button", { name: "Close tools", exact: true }).click();
        const workspaceResult = await new AxeBuilder({ page }).include('[data-testid="chat-workspace-header"]').include('#chat-composer')
          .withRules(["button-name", "color-contrast", "label"]).analyze();
        expect(workspaceResult.violations).toEqual([]);
      }
    }
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
