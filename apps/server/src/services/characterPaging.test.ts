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
          description: index === 0 ? "needle-description" : "",
          tags: index === 3 ? ["needle-tag"] : [],
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
    assert.deepEqual(result.availableTags, ["needle-tag"]);
  });

  it("searches name and description fields without matching prompt content", async () => {
    const byName = await listCharactersPage({ q: `${prefix} 0`, page: 1, pageSize: 40 });
    const byDescription = await listCharactersPage({ q: "needle-description", page: 1, pageSize: 40 });
    const byPrompt = await listCharactersPage({ q: "needle-prompt", page: 1, pageSize: 40 });

    assert.equal(byName.items.length, 1);
    assert.equal(byName.items[0]?.name, `${prefix} 0`);
    assert.equal(byDescription.items.length, 1);
    assert.equal(byDescription.items[0]?.description, "needle-description");
    assert.equal(byPrompt.items.length, 0);
  });

  it("filters by character tags", async () => {
    const result = await listCharactersPage({ q: prefix, tag: "needle-tag", page: 1, pageSize: 40 });

    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0]?.tags, ["needle-tag"]);
  });
});
