import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { serializeCharacter } from "../serializers.js";
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
  items: ReturnType<typeof serializeCharacter>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  availableTags: string[];
};

const buildCharacterSearchWhere = (q: string): Prisma.CharacterWhereInput | undefined => {
  const keyword = q.trim();
  if (!keyword) {
    return undefined;
  }

  return {
    OR: [
      { name: { contains: keyword } },
      { description: { contains: keyword } }
    ]
  };
};

const includesTag = (tags: string[], tag: string) =>
  tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase());

type CharacterWithChatStats = Prisma.CharacterGetPayload<{
  include: {
    chats: { where: { deletedAt: null }; select: { updatedAt: true } };
    _count: { select: { chats: { where: { deletedAt: null } } } };
  };
}>;

const compareUpdated = (left: CharacterWithChatStats, right: CharacterWithChatStats) =>
  right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id);

const sortCharacters = (
  characters: CharacterWithChatStats[],
  sort: NonNullable<CharacterPageQuery["sort"]>
) =>
  [...characters].sort((left, right) => {
    if (sort === "favorites") {
      return Number(right.isFavorite) - Number(left.isFavorite) || compareUpdated(left, right);
    }
    if (sort === "recently_chatted") {
      const recentDifference =
        (right.chats[0]?.updatedAt.getTime() ?? 0) - (left.chats[0]?.updatedAt.getTime() ?? 0);
      return recentDifference || compareUpdated(left, right);
    }
    if (sort === "most_chats") {
      return right._count.chats - left._count.chats || compareUpdated(left, right);
    }
    if (sort === "name_asc" || sort === "name_desc") {
      const nameDifference = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true
      });
      return (sort === "name_asc" ? nameDifference : -nameDifference) || compareUpdated(left, right);
    }
    return compareUpdated(left, right);
  });

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
  const baseCharacters = await prisma.character.findMany({
    where,
    include: {
      chats: {
        where: { deletedAt: null },
        select: { updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1
      },
      _count: { select: { chats: { where: { deletedAt: null } } } }
    }
  });
  const availableTags = Array.from(
    new Set(baseCharacters.flatMap((character) => toCharacterTags(character.tags)))
  ).sort((left, right) => left.localeCompare(right));
  const selectedTag = tag?.trim() ?? "";
  const filteredCharacters = selectedTag
    ? baseCharacters.filter((character) => includesTag(toCharacterTags(character.tags), selectedTag))
    : baseCharacters;
  const sortedCharacters = sortCharacters(filteredCharacters, sort);
  const total = filteredCharacters.length;
  const characters = sortedCharacters.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items: characters.map((character) => serializeCharacter(character)),
    total,
    page,
    pageSize,
    totalPages,
    availableTags
  };
};
