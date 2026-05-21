import { expect, test } from "@playwright/test";

test("direct routes render their workspace headers", async ({ page }) => {
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: /角色工坊|Character Studio/ })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /模型设置|Model Settings/ })).toBeVisible();
});

test("character management can create a character and shows save feedback", async ({ page }) => {
  await page.goto("/characters");

  await page.getByRole("button", { name: /新建|New/ }).click();
  const name = `E2E角色-${Date.now()}`;

  await page.getByLabel(/名称|Name/).fill(name);
  await page.getByRole("textbox", { name: /^(前置词|Prefix)/ }).fill("你会保持清晰、稳定的角色边界。");
  await page.getByRole("textbox", { name: /^(提示词|Prompt)/ }).fill("这是一张用于端到端测试的原创角色卡。");
  await page.getByRole("textbox", { name: /^(后置词|Suffix)/ }).fill("回复时保持简洁。");
  await page.getByRole("button", { name: /保存|Save/ }).last().click();

  await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);
  await expect(page.getByRole("button", { name })).toBeVisible();
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
