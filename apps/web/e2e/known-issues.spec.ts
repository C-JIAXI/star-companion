import { expect, test } from "@playwright/test";

test("quick commands expand to show choices and collapse again", async ({ page, request }) => {
  const characterResponse = await request.post("/api/characters", { data: {
    name: "Quick command layout check", prompt: "A synthetic character.",
    quickReplies: Array.from({ length: 12 }, (_, index) => ({ id: `quick-layout-${index}`, label: `Choice ${index + 1}`, content: `Choice ${index + 1}` }))
  } });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", { data: { title: "Quick command layout check", characterId: character.id } });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;
  try {
    await page.addInitScript((id) => {
      localStorage.setItem("star-companion:selected-chat", id);
      localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
    }, chat.id);
    await page.goto("/");
    const toggle = page.locator("#chat-quick-replies-toggle");
    await expect(toggle).toBeVisible();
    const list = page.getByTestId("chat-quick-replies-list");
    const collapsedHeight = (await list.boundingBox())!.height;
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expandedBox = (await list.boundingBox())!;
    const lastChoice = page.locator("[data-chat-quick-reply]").last();
    const lastBox = (await lastChoice.boundingBox())!;
    expect(expandedBox.height).toBeGreaterThan(collapsedHeight);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(expandedBox.y + expandedBox.height + 1);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await list.boundingBox())!.height).toBeLessThanOrEqual(collapsedHeight + 1);
    await page.setViewportSize({ width: 320, height: 568 });
    await toggle.click();
    await lastChoice.scrollIntoViewIfNeeded();
    await lastChoice.click();
    await expect(page.locator("#chat-message-input")).toHaveValue("Choice 12");
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("storage health panels keep their own height on desktop and mobile", async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/settings?section=storage");
    await page.getByTestId("settings-section-storage").click();
    const center = page.getByTestId("storage-health-center");
    await expect(center.getByTestId("storage-category-database")).toBeVisible();
    const panels = center.locator(":scope > section");
    await expect(panels).toHaveCount(5);
    const first = (await panels.first().boundingBox())!;
    const second = (await panels.nth(1).boundingBox())!;
    expect(first.height).toBeLessThan(400);
    expect(second.y - (first.y + first.height)).toBeLessThan(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
