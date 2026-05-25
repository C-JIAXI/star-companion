import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../db.js";
import { listCharactersPage } from "./characterPaging.js";

const prefix = `Character Paging Test ${Date.now()}`;
const createdIds: string[] = [];

describe("listCharactersPage", () => {
  before(async () => {
    for (let index = 0; index < 5; index += 1) {
      const character = await prisma.character.create({
        data: {
          name: `${prefix} ${index}`,
          prefix: index === 2 ? "needle-prefix" : "",
          prompt: index === 3 ? "needle-prompt" : "",
          suffix: index === 4 ? "needle-suffix" : "",
          htmlCss: index === 1 ? ".needle-css { color: red; }" : ""
        }
      });
      createdIds.push(character.id);
    }
  });

  after(async () => {
    await prisma.character.deleteMany({ where: { id: { in: createdIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("returns the first page and total count by default", async () => {
    const result = await listCharactersPage({ q: prefix, page: 1, pageSize: 2 });

    assert.equal(result.items.length, 2);
    assert.equal(result.total, 5);
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 2);
    assert.equal(result.totalPages, 3);
  });

  it("searches name and prompt fields", async () => {
    const byName = await listCharactersPage({ q: `${prefix} 0`, page: 1, pageSize: 40 });
    const byPrompt = await listCharactersPage({ q: "needle-prompt", page: 1, pageSize: 40 });

    assert.equal(byName.items.length, 1);
    assert.equal(byName.items[0]?.name, `${prefix} 0`);
    assert.equal(byPrompt.items.length, 1);
    assert.equal(byPrompt.items[0]?.prompt, "needle-prompt");
  });
});
