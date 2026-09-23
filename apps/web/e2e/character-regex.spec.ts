import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("advanced regex preview and historical render update", async ({ page, request }, testInfo) => {
  const name = `Regex E2E ${testInfo.project.name} ${randomUUID().slice(0, 6)}`;
  const title = `Regex chat ${name}`;
  const created = await request.post("/api/characters", { data: {
    name,
    prompt: "Synthetic test character",
    regexScripts: [{ id: randomUUID(), title: "Display", pattern: "hello", replacement: "shown", enabled: true, scope: "user", renderOnly: true }]
  } });
  expect(created.ok()).toBeTruthy();
  const character = (await created.json()).data;
  let chatId: string | null = null;
  await page.addInitScript(() => {
    localStorage.setItem("star-companion-character-editor-mode", "advanced");
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true }));
  });
  try {
    const chatResponse = await request.post("/api/chats", { data: { title, characterId: character.id } });
    expect(chatResponse.ok()).toBeTruthy();
    chatId = (await chatResponse.json()).data.id;
    const messageResponse = await request.post("/api/messages", { data: { chatId, role: "user", content: "hello" } });
    expect(messageResponse.ok()).toBeTruthy();
    expect((await messageResponse.json()).data.content).toBe("hello");

    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(name);
    await page.locator("div.group").filter({ has: page.getByText(name, { exact: true }) }).first().getByRole("button", { name: /编辑|Edit/ }).click();
    await page.getByTestId("character-editor-section-regex").click();
    const row = page.getByTestId("character-regex-script").first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /编辑正则脚本|Edit regex script/ }).click();
    await page.getByRole("textbox", { name: /测试输入|Test input/ }).fill("hello");
    await page.getByRole("combobox", { name: /测试范围|Test role/ }).selectOption("user");
    await page.getByRole("combobox", { name: /测试阶段|Test stage/ }).selectOption("render");
    await page.getByRole("button", { name: /预览结果|Preview/ }).click();
    await expect(page.getByTestId("character-regex-result")).toHaveText("shown");
    await row.locator("textarea").fill("updated");
    await page.getByTestId("character-save").click();
    await expect.poll(async () => (await (await request.get(`/api/characters/${character.id}`)).json()).data.regexScripts[0].replacement).toBe("updated");

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 1024) < 1024) await page.getByRole("button", { name: /Toggle navigation/ }).click();
    await page.getByRole("button", { name: /历史|History/ }).click();
    await page.getByPlaceholder(/搜索历史对话|Search chat history/).fill(title);
    await page.locator("[data-chat-history-title]").filter({ hasText: title }).first().click();
    await expect(page.locator('[data-chat-message="user"]')).toContainText("updated");
    const stored = (await (await request.get(`/api/messages?chatId=${chatId}`)).json()).data[0];
    expect(stored.content).toBe("hello");
    expect(stored.displayContent).toBe("updated");
  } finally {
    if (chatId) {
      await request.delete(`/api/chats/${chatId}`);
      await request.delete(`/api/chats/${chatId}/permanent`);
    }
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("regex scripts reorder with the Lore handle and collapse the previous new script", async ({ page, request }, testInfo) => {
  const name = `Regex order ${testInfo.project.name} ${randomUUID().slice(0, 6)}`;
  const scripts = ["Alpha", "Beta", "Gamma"].map((title) => ({ id: randomUUID(), title, pattern: title, replacement: title.toLowerCase(), enabled: true, scope: "both", renderOnly: false }));
  const response = await request.post("/api/characters", { data: { name, prompt: "Synthetic test", regexScripts: scripts } });
  expect(response.ok()).toBeTruthy();
  const character = (await response.json()).data;
  await page.addInitScript(() => {
    localStorage.setItem("star-companion-character-editor-mode", "advanced");
    localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true }));
  });
  try {
    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(name);
    await page.locator("div.group").filter({ has: page.getByText(name, { exact: true }) }).first().getByRole("button", { name: /编辑|Edit/ }).click();
    await page.getByTestId("character-editor-section-regex").click();
    const rows = page.locator("[data-regex-order-id]");
    const order = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-regex-order-id")));
    await expect(rows).toHaveCount(3);
    const first = rows.first().getByTestId("regex-reorder-handle");
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(order).toEqual([scripts[1].id, scripts[0].id, scripts[2].id]);
    await page.keyboard.press("ArrowUp");
    await expect.poll(order).toEqual(scripts.map((script) => script.id));

    const from = (await first.boundingBox())!;
    const to = (await rows.nth(1).getByTestId("regex-reorder-handle").boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y + 20, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(order).toEqual(scripts.map((script) => script.id));
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y + 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(order).toEqual([scripts[1].id, scripts[0].id, scripts[2].id]);
    const touchSource = rows.nth(2).getByTestId("regex-reorder-handle");
    await touchSource.scrollIntoViewIfNeeded();
    const start = (await touchSource.boundingBox())!;
    const finish = (await rows.nth(1).getByTestId("regex-reorder-handle").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x + 20, y: start.y + 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: finish.x + 20, y: finish.y + 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect.poll(order).toEqual([scripts[1].id, scripts[2].id, scripts[0].id]);
    await page.getByTestId("character-save").click();
    await expect.poll(async () => (await (await request.get(`/api/characters/${character.id}`)).json()).data.regexScripts.map((script: { id: string }) => script.id)).toEqual([scripts[1].id, scripts[2].id, scripts[0].id]);

    await page.getByRole("button", { name: /新增脚本|Add script/ }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.last()).toHaveAttribute("data-regex-expanded", "true");
    await page.getByRole("button", { name: /新增脚本|Add script/ }).click();
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(3)).toHaveAttribute("data-regex-expanded", "false");
    await expect(rows.last()).toHaveAttribute("data-regex-expanded", "true");
  } finally {
    await request.delete(`/api/characters/${character.id}`);
  }
});
