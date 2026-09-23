import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("embedded lore reorders by handle and keyboard, cancels, and persists without changing entries", async ({ page, request }, testInfo) => {
  const entries = ["Alpha", "Beta", "Gamma"].map((key, index) => ({ id: randomUUID(), keys: [key], content: `Synthetic ${key}`, priority: index, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: index !== 1 }));
  const name = `Lore order ${testInfo.project.name}`;
  const response = await request.post("/api/characters", { data: { name, prompt: "Synthetic test", loreEntries: entries } });
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
    await page.getByTestId("character-editor-section-lore").click();
    const rows = page.locator("[data-lore-order-id]");
    const order = () => rows.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-lore-id")));
    await expect(rows).toHaveCount(3);
    await page.evaluate(() => {
      document.documentElement.dataset.motion = "full";
      const original = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.hasAttribute("data-lore-order-id")) {
          this.setAttribute("data-sort-animation-count", String(Number(this.getAttribute("data-sort-animation-count") ?? 0) + 1));
        }
        return original.apply(this, args);
      };
    });
    const first = rows.first().getByTestId("lore-reorder-handle");
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(order).toEqual([entries[1].id, entries[0].id, entries[2].id]);
    expect(await rows.evaluateAll((elements) => elements.reduce((sum, el) => sum + Number(el.getAttribute("data-sort-animation-count") ?? 0), 0))).toBe(2);
    await page.evaluate(() => { document.documentElement.dataset.motion = "reduced"; });
    await expect.poll(() => rows.evaluateAll((elements) => elements.flatMap((el) => el.getAnimations()).length)).toBe(0);
    await page.keyboard.press("ArrowUp");
    await expect.poll(order).toEqual(entries.map((entry) => entry.id));
    expect(await rows.evaluateAll((elements) => elements.reduce((sum, el) => sum + Number(el.getAttribute("data-sort-animation-count") ?? 0), 0))).toBe(2);
    const from = (await first.boundingBox())!;
    const target = (await rows.nth(1).getByTestId("lore-reorder-handle").boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 20, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(order).toEqual(entries.map((entry) => entry.id));
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(order).toEqual([entries[1].id, entries[0].id, entries[2].id]);
    expect((await (await request.get(`/api/characters/${character.id}`)).json()).data.loreEntries.map((entry: { id: string }) => entry.id)).toEqual(entries.map((entry) => entry.id));
    const touchSource = rows.nth(2).getByTestId("lore-reorder-handle");
    await touchSource.scrollIntoViewIfNeeded();
    const start = (await touchSource.boundingBox())!;
    const finish = (await rows.nth(1).getByTestId("lore-reorder-handle").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x + 20, y: start.y + 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: finish.x + 20, y: finish.y + 20 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await expect.poll(order).toEqual([entries[1].id, entries[2].id, entries[0].id]);
    await page.getByTestId("character-save").click();
    await expect.poll(async () => (await (await request.get(`/api/characters/${character.id}`)).json()).data.loreEntries).toEqual([entries[1], entries[2], entries[0]]);
    await page.reload();
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(name);
    await page.locator("div.group").filter({ has: page.getByText(name, { exact: true }) }).first().getByRole("button", { name: /编辑|Edit/ }).click();
    await page.getByTestId("character-editor-section-lore").click();
    await expect.poll(order).toEqual([entries[1].id, entries[2].id, entries[0].id]);
    await page.getByRole("button", { name: /添加词条|Add Entry/ }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.last()).toHaveAttribute("data-lore-expanded", "true");
    await page.getByRole("button", { name: /添加词条|Add Entry/ }).click();
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(3)).toHaveAttribute("data-lore-expanded", "false");
    await expect(rows.last()).toHaveAttribute("data-lore-expanded", "true");
  } finally {
    await request.delete(`/api/characters/${character.id}`);
  }
});
