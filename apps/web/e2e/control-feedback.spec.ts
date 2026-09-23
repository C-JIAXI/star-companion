import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("buttons and fields use quiet pointer feedback with a keyboard focus indicator", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true })));
  await page.goto("/characters");

  const button = page.locator("button.native-button:visible:not([disabled])").first();
  await button.scrollIntoViewIfNeeded();
  const rect = (await button.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await expect(button).toHaveCSS("transform", "none");
  await expect(button).toHaveCSS("filter", "brightness(0.95)");
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await expect(button).toHaveCSS("outline-style", "none");

  const search = page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/);
  await search.click();
  await expect(search).toHaveCSS("outline-style", "none");
  expect(await search.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("0px 0px 0px 3px");

  await page.keyboard.press("Tab");
  await button.focus();
  await expect(button).toHaveCSS("outline-style", "solid");
});

test("the chat composer shows one restrained focus surface", async ({ page, request }) => {
  const title = `Focus chat ${randomUUID().slice(0, 8)}`;
  const characterResponse = await request.post("/api/characters", { data: { name: title, prompt: "Synthetic focus test" } });
  expect(characterResponse.ok()).toBeTruthy();
  const characterId = (await characterResponse.json()).data.id;
  let chatId: string | null = null;
  await page.addInitScript(() => localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true })));
  try {
    const chatResponse = await request.post("/api/chats", { data: { title, characterId } });
    expect(chatResponse.ok()).toBeTruthy();
    chatId = (await chatResponse.json()).data.id;
    await page.goto("/");
    if ((page.viewportSize()?.width ?? 1024) < 1024) await page.getByRole("button", { name: /Toggle navigation/ }).click();
    await page.getByRole("button", { name: /历史|History/ }).click();
    await page.locator("[data-chat-history-title]").filter({ hasText: title }).first().click();
    const input = page.locator("#chat-message-input");
    await input.click();
    await expect(page.locator("#chat-composer")).toHaveCSS("outline-style", "none");
    await expect(input).toHaveCSS("box-shadow", "none");
    expect(await page.locator("#chat-composer").evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  } finally {
    if (chatId) {
      await request.delete(`/api/chats/${chatId}`);
      await request.delete(`/api/chats/${chatId}/permanent`);
    }
    await request.delete(`/api/characters/${characterId}`);
  }
});
