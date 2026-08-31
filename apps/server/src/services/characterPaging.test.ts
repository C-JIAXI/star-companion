import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../db.js";
import { listCharactersPage } from "./characterPaging.js";

const prefix = `Character Paging Test ${Date.now()}`;
const createdIds: string[] = [];
const createdChatIds: string[] = [];

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
          htmlCss: index === 1 ? ".needle-css { color: red; }" : "",
          isFavorite: index === 4
        }
      });
      createdIds.push(character.id);
    }

    for (const [characterIndex, offset] of [[0, 120_000], [1, 60_000], [1, 0]] as const) {
      const chat = await prisma.chat.create({
        data: {
          title: `${prefix} chat ${characterIndex}-${offset}`,
          characterId: createdIds[characterIndex],
          updatedAt: new Date(Date.now() - offset)
        }
      });
      createdChatIds.push(chat.id);
    }

    const trashedChat = await prisma.chat.create({
      data: {
        title: `${prefix} trashed chat`,
        characterId: createdIds[4],
        deletedAt: new Date(),
        updatedAt: new Date(Date.now() + 60_000)
      }
    });
    createdChatIds.push(trashedChat.id);
  });

  after(async () => {
    await prisma.chat.deleteMany({ where: { id: { in: createdChatIds } } }).catch(() => {});
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
    assert.equal("prompt" in result.items[0]!, false);
    assert.equal("loreEntries" in result.items[0]!, false);
    assert.equal("quickReplies" in result.items[0]!, false);
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

  it("orders favorites first and can return favorites only", async () => {
    const all = await listCharactersPage({ q: prefix, page: 1, pageSize: 40 });
    const favorites = await listCharactersPage({
      q: prefix,
      favoriteOnly: true,
      page: 1,
      pageSize: 40
    });

    assert.equal(all.items[0]?.isFavorite, true);
    assert.equal(favorites.total, 1);
    assert.equal(favorites.items[0]?.name, `${prefix} 4`);
  });

  it("sorts by name, recent chat activity, and chat count", async () => {
    const byName = await listCharactersPage({ q: prefix, sort: "name_desc", page: 1, pageSize: 40 });
    const byRecentChat = await listCharactersPage({
      q: prefix,
      sort: "recently_chatted",
      page: 1,
      pageSize: 40
    });
    const byChatCount = await listCharactersPage({
      q: prefix,
      sort: "most_chats",
      page: 1,
      pageSize: 40
    });

    assert.equal(byName.items[0]?.name, `${prefix} 4`);
    assert.equal(byRecentChat.items[0]?.name, `${prefix} 1`);
    assert.equal(byChatCount.items[0]?.name, `${prefix} 1`);
  });
});
