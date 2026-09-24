import { expect, test } from "@playwright/test";

test("all pages share sidebar top spacing and collapse behavior", async ({ page }) => {
  await page.setViewportSize({ width: 1142, height: 900 });
  await page.addInitScript(() => localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true })));
  for (const route of ["/", "/characters", "/settings", "/docs"]) {
    await page.goto(route);
    const sidebar = page.getByTestId("desktop-sidebar");
    await expect(sidebar.locator("h1")).toBeVisible();
    const brandRow = sidebar.locator("h1").locator("../..").locator("..");
    expect.soft((await brandRow.boundingBox())!.height, `${route} header height`).toBe(64);
    expect.soft((await brandRow.boundingBox())!.y, `${route} top blank space`).toBe(0);
    await expect.soft(page.getByTestId("chat-sidebar-collapse")).toBeVisible();
    await page.getByTestId("chat-sidebar-collapse").click();
    await expect(sidebar).toBeHidden();
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await expect(sidebar).toBeVisible();
  }
});

test("sidebar and title share one header row and tools have one close action", async ({ page, request }, testInfo) => {
  const character = (await (await request.post("/api/characters", { data: { name: "Chrome fixture", prompt: "Synthetic layout fixture." } })).json()).data;
  const chat = (await (await request.post("/api/chats", { data: { characterId: character.id, title: "Header fixture" } })).json()).data;
  await page.addInitScript((id) => {
    localStorage.setItem("star-companion:selected-chat", id);
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true }));
  }, chat.id);
  try {
    await page.setViewportSize({ width: 1142, height: 1272 });
    await page.goto("/");
    await expect(page.locator("#chat-title")).toContainText("Header fixture");
    const collapse = page.getByTestId("chat-sidebar-collapse");
    const brand = page.getByTestId("desktop-sidebar").locator("h1");
    const collapseBox = (await collapse.boundingBox())!;
    const brandBox = (await brand.boundingBox())!;
    expect(Math.abs(collapseBox.y + collapseBox.height / 2 - brandBox.y - brandBox.height / 2)).toBeLessThan(20);
    expect(await page.locator("#chat-title").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
    await page.getByTestId("chat-tools-trigger").click();
    await page.getByTestId("chat-tool-agent").click();
    await expect(page.getByTestId("chat-tools-panel").getByRole("button", { name: /Close|关闭/ })).toHaveCount(1);
    await page.screenshot({ path: `../../docs/native-design/${testInfo.project.name}/workspace-chrome-1142.png`, scale: "css", animations: "disabled" });
    await page.setViewportSize({ width: 1142, height: 560 });
    const indicator = page.getByTestId("chat-tool-scroll-indicator");
    await expect(indicator).toBeVisible();
    const initialTop = (await indicator.boundingBox())!.y;
    expect((await indicator.boundingBox())!.width).toBe(2);
    expect(await page.locator(".chat-tool-scroll:visible").evaluate((element) => parseFloat(getComputedStyle(element).paddingRight))).toBeGreaterThanOrEqual(12);
    await page.locator(".chat-tool-scroll:visible").evaluate((element) => { element.scrollTop = 200; });
    await expect.poll(async () => (await indicator.boundingBox())!.y).toBeGreaterThan(initialTop);
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/chats/${chat.id}/permanent`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
