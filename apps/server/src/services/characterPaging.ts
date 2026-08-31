import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { serializeCharacterSummary } from "../serializers.js";
import { toCharacterTags } from "./characterCards.js";

type CharacterPageQuery = {
  q: string;
  tag?: string;
  favoriteOnly?: boolean;
  sort?: "favorites" | "recently_chatted" | "most_chats" | "recently_updated" | "name_asc" | "name_desc";
  page: number;
  pageSize: number;
};

type CharacterPage = {
  items: ReturnType<typeof serializeCharacterSummary>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  availableTags: string[];
};

const summarySelect = {
  id: true,
  name: true,
  avatar: true,
  description: true,
  tags: true,
  loreEntries: true,
  isFavorite: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CharacterSelect;

const buildCharacterSearchWhere = (q: string): Prisma.CharacterWhereInput | undefined => {
  const keyword = q.trim();
  return keyword ? { OR: [{ name: { contains: keyword } }, { description: { contains: keyword } }] } : undefined;
};

const includesTag = (tags: string[], tag: string) =>
  tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase());

type CharacterWithChatStats = Prisma.CharacterGetPayload<{
  select: typeof summarySelect & {
    chats: { where: { deletedAt: null }; select: { updatedAt: true } };
    _count: { select: { chats: { where: { deletedAt: null } } } };
  };
}>;

const compareUpdated = (left: CharacterWithChatStats, right: CharacterWithChatStats) =>
  right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id);

const sortCharacters = (characters: CharacterWithChatStats[], sort: NonNullable<CharacterPageQuery["sort"]>) =>
  [...characters].sort((left, right) => {
    if (sort === "favorites") return Number(right.isFavorite) - Number(left.isFavorite) || compareUpdated(left, right);
    if (sort === "recently_chatted") {
      return (right.chats[0]?.updatedAt.getTime() ?? 0) - (left.chats[0]?.updatedAt.getTime() ?? 0) || compareUpdated(left, right);
    }
    if (sort === "most_chats") return right._count.chats - left._count.chats || compareUpdated(left, right);
    if (sort === "name_asc" || sort === "name_desc") {
      const difference = left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
      return (sort === "name_asc" ? difference : -difference) || compareUpdated(left, right);
    }
    return compareUpdated(left, right);
  });

const databaseOrder = (sort: NonNullable<CharacterPageQuery["sort"]>): Prisma.CharacterOrderByWithRelationInput[] | null => {
  if (sort === "favorites") return [{ isFavorite: "desc" }, { updatedAt: "desc" }, { id: "asc" }];
  if (sort === "recently_updated") return [{ updatedAt: "desc" }, { id: "asc" }];
  if (sort === "name_asc") return [{ name: "asc" }, { updatedAt: "desc" }, { id: "asc" }];
  if (sort === "name_desc") return [{ name: "desc" }, { updatedAt: "desc" }, { id: "asc" }];
  if (sort === "most_chats") return [{ chats: { _count: "desc" } }, { updatedAt: "desc" }, { id: "asc" }];
  return null;
};

export const listCharactersPage = async ({
  q,
  tag,
  favoriteOnly = false,
  sort = "favorites",
  page,
  pageSize
}: CharacterPageQuery): Promise<CharacterPage> => {
  const searchWhere = buildCharacterSearchWhere(q);
  const where: Prisma.CharacterWhereInput | undefined = favoriteOnly
    ? { AND: [...(searchWhere ? [searchWhere] : []), { isFavorite: true }] }
    : searchWhere;
  const selectedTag = tag?.trim() ?? "";
  const orderBy = databaseOrder(sort);
  const tagRowsPromise = prisma.character.findMany({ where, select: { tags: true } });

  if (!selectedTag && orderBy) {
    const [characters, total, tagRows] = await Promise.all([
      prisma.character.findMany({ where, select: summarySelect, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.character.count({ where }),
      tagRowsPromise
    ]);
    const availableTags = Array.from(new Set(tagRows.flatMap((character) => toCharacterTags(character.tags))))
      .sort((left, right) => left.localeCompare(right));
    return {
      items: characters.map(serializeCharacterSummary),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      availableTags
    };
  }

  // Tag values live in a JSON array and recently-chatted sorts by a relation max.
  // These uncommon views still avoid full prompts, HTML, lore content and quick replies.
  const [baseCharacters, tagRows] = await Promise.all([
    prisma.character.findMany({
      where,
      select: {
        ...summarySelect,
        chats: { where: { deletedAt: null }, select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        _count: { select: { chats: { where: { deletedAt: null } } } }
      }
    }),
    tagRowsPromise
  ]);
  const availableTags = Array.from(new Set(tagRows.flatMap((character) => toCharacterTags(character.tags))))
    .sort((left, right) => left.localeCompare(right));
  const filtered = selectedTag
    ? baseCharacters.filter((character) => includesTag(toCharacterTags(character.tags), selectedTag))
    : baseCharacters;
  const sorted = sortCharacters(filtered, sort);
  const total = filtered.length;
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize).map(serializeCharacterSummary),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    availableTags
  };
};
