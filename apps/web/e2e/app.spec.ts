import { expect, test } from "@playwright/test";

test("direct routes render their workspace headers", async ({ page }) => {
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: /角色工坊|Character Studio/ })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /模型设置|Model Settings/ })).toBeVisible();
});

test("character management can create a character and shows save feedback", async ({
  page,
  request
}, testInfo) => {
  const cleanupE2ECharacter = async (name: string) => {
    const response = await request.get("/api/characters");
    const payload = await response.json();
    const characters = Array.isArray(payload.data) ? payload.data : [];

    await Promise.all(
      characters
        .filter((character) => character.name === name)
        .map((character) => request.delete(`/api/characters/${character.id}`))
    );
  };

  await page.goto("/characters");

  await page.getByRole("button", { name: /新建|New/ }).click();
  await expect(page.getByRole("heading", { name: /创建角色|Create Character/ })).toBeVisible();
  const name = `E2E角色-${testInfo.project.name}-${Date.now()}`;

  try {
    await page.getByLabel(/名称|Name/).fill(name);
    await page.getByRole("textbox", { name: /^(前置词|Prefix)/ }).fill("你会保持清晰、稳定的角色边界。");
    await page.getByRole("textbox", { name: /^(提示词|Prompt)/ }).fill("这是一张用于端到端测试的原创角色卡。");
    await page.getByRole("textbox", { name: /^(后置词|Suffix)/ }).fill("回复时保持简洁。");
    await page.getByRole("button", { name: /保存|Save/ }).last().click();

    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);
    await expect
      .poll(async () => {
        const response = await request.get("/api/characters");
        const payload = await response.json();
        const characters = Array.isArray(payload.data) ? payload.data : [];
        return characters.some((character) => character.name === name);
      })
      .toBe(true);
  } finally {
    await cleanupE2ECharacter(name);
  }
});

test("mobile chat layout exposes panel switching", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: /聊天列表|Chats/ })).toBeVisible();
  await page.getByRole("button", { name: /创建聊天|Create Chat/ }).first().click();
  await expect(page.getByRole("heading", { name: /创建聊天|Create Chat/ })).toBeVisible();

  await page.getByRole("button", { name: /消息流|Message Stream/ }).click();
  await expect(
    page
      .getByPlaceholder(/输入用户消息|Write a user message/)
      .or(page.getByText(/选择或创建聊天|Select or create a chat|这段聊天还没有消息|This chat has no messages/))
      .first()
  ).toBeVisible();
});

test("lore entries show persistent trigger without trigger mode badge", async ({ page, request }) => {
  const name = `E2E Lorebook ${Date.now()}`;
  const content = "Persistent trigger entry created by Playwright.";
  const bookResponse = await request.post("/api/lorebooks", {
    data: {
      name,
      description: "Temporary lorebook for persistent trigger UI coverage"
    }
  });
  expect(bookResponse.ok()).toBeTruthy();
  const book = (await bookResponse.json()).data;

  const entryResponse = await request.post(`/api/lorebooks/${book.id}/entries`, {
    data: {
      keys: ["playwright-persistent"],
      content,
      priority: 0,
      triggerMode: "both",
      alwaysActive: true,
      enabled: true
    }
  });
  expect(entryResponse.ok()).toBeTruthy();

  try {
    await page.goto("/lore");
    await page.getByRole("button", { name: new RegExp(name) }).click();

    await expect(page.getByText(/持续触发\s*1|Always Active\s*1/)).toBeVisible();
    const entryCard = page.locator("article").filter({ hasText: content });
    await expect(entryCard).toContainText(/持续触发|Always Active/);
    await expect(entryCard).not.toContainText(/共同触发|Shared Trigger/);
  } finally {
    await request.delete(`/api/lorebooks/${book.id}`);
  }
});
