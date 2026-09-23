import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("compact composer tools preserve drafts, keyboard access, glass fallback and reduced motion", async ({ page, request }, testInfo) => {
  const response = await request.post("/api/characters", { data: { name: "Composer design fixture", prompt: "Synthetic test. No model requests." } });
  expect(response.ok()).toBeTruthy();
  const character = (await response.json()).data;
  const chatResponse = await request.post("/api/chats", { data: { characterId: character.id, title: "Compact composer fixture" } });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;
  try {
    const settings = (await (await request.get("/api/settings")).json()).data;
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...settings, language: "en", appearancePreferences: { ...settings.appearancePreferences, themeMode: "light", motion: "full" } } } });
    });
    await page.addInitScript((id) => {
      localStorage.setItem("star-companion:selected-chat", id);
      localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true }));
    }, chat.id);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto("/");
    const input = page.locator("#chat-message-input");
    await input.fill("Synthetic draft stays while browsing tools.");
    await expect(page.getByTestId("chat-draft-status")).toContainText("Saved");
    await expect(page.getByTestId("chat-composer-toolbar").locator("button")).toHaveCount(3);
    await expect(page.locator('[data-chat-action="image-generate"]')).toHaveCount(0);
    const trigger = page.getByTestId("composer-tools-trigger");
    await trigger.click();
    const menu = page.getByRole("menu", { name: "More composer tools" });
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await expect(menu).toHaveCSS("animation-name", "native-surface-enter");
    await expect(menu).not.toHaveCSS("backdrop-filter", "none");
    await page.keyboard.press("End");
    await expect(menu.locator('[data-chat-action="image-generate"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.locator('[data-chat-action="voice-record"]')).toBeFocused();
    const output = path.resolve("../../docs/native-design", testInfo.project.name);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "composer-tools-light-390.png"), scale: "css", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.blur();
    await page.screenshot({ path: path.join(output, "composer-light-390.png"), scale: "css", animations: "disabled" });
    await expect(input).toHaveValue("Synthetic draft stays while browsing tools.");
    await trigger.click();
    await page.locator("#chat-message-viewport").click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 360 });
    await trigger.click();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(360);
    await page.evaluate(() => {
      document.documentElement.dataset.contrast = "high";
      document.documentElement.dataset.motion = "reduced";
    });
    await expect(menu).toHaveCSS("backdrop-filter", "none");
    expect(await menu.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.00001);
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("Synthetic draft stays while browsing tools.");
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("native visual system keeps navigation readable in both themes and layouts", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
  });
  const settings = (await (await request.get("/api/settings")).json()).data;
  let theme = "light";
  let language = "en";
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { ok: true, data: { ...settings, language, appearancePreferences: { ...settings.appearancePreferences, themeMode: theme, motion: "reduced" } } } });
  });
  const output = path.resolve("../../docs/native-design", testInfo.project.name);
  await mkdir(output, { recursive: true });
  const characterIds: string[] = [];
  try {
    for (const name of ["Observatory guide", "Coastal atelier", "Garden storyteller"]) {
      const response = await request.post("/api/characters", { data: { name, prompt: "Synthetic visual fixture; no model calls.", description: "An original companion for a quiet story. Synthetic design fixture.", tags: ["Design study"] } });
      expect(response.ok()).toBeTruthy();
      characterIds.push((await response.json()).data.id);
    }
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (theme of ["light", "dark"]) {
        await page.goto("/settings");
        await page.getByTestId("settings-section-appearance").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("settings-section-appearance")).toHaveAttribute("aria-pressed", "true");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const navigation = await new AxeBuilder({ page }).include(".settings-navigation").withRules(["color-contrast"]).analyze();
        expect(navigation.violations).toEqual([]);
        if (width === 1440) {
          const nav = (await page.locator(".settings-navigation").boundingBox())!;
          const content = (await page.locator(".settings-content").boundingBox())!;
          expect(nav.x + nav.width).toBeLessThan(content.x);
        }
        await page.screenshot({ path: path.join(output, `settings-${theme}-${width}.png`), scale: "css" });
        for (const route of ["characters", "docs"]) {
          await page.goto(`/${route}`);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("main")).toBeVisible();
          if (route === "characters") {
            await expect(page.getByTestId("characters-filter-toggle")).toBeVisible();
            await expect(page.locator(`[data-character-id="${characterIds[0]}"]`)).toBeVisible();
          } else {
            await expect(page.getByTestId("docs-page-root")).toBeVisible();
          }
          await page.evaluate(() => document.fonts.ready);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (width !== 320) await page.screenshot({ path: path.join(output, `${route}-${theme}-${width}.png`), scale: "css" });
        }
      }
    }
    language = "zh-CN";
    theme = "light";
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings");
      await page.getByTestId("settings-section-appearance").click();
      await expect(page.getByTestId("settings-section-appearance")).toHaveText("外观与无障碍");
      await page.screenshot({ path: path.join(output, `settings-zh-light-${width}.png`), scale: "css" });
    }
  } finally {
    for (const id of characterIds) await request.delete(`/api/characters/${id}`);
  }
});
