import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { serializeCharacter } from "../serializers.js";
import { toCharacterTags } from "./characterCards.js";

type CharacterPageQuery = {
  q: string;
  tag?: string;
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

export const listCharactersPage = async ({
  q,
  tag,
  page,
  pageSize
}: CharacterPageQuery): Promise<CharacterPage> => {
  const where = buildCharacterSearchWhere(q);
  const baseCharacters = await prisma.character.findMany({
    where,
    orderBy: { updatedAt: "desc" }
  });
  const availableTags = Array.from(
    new Set(baseCharacters.flatMap((character) => toCharacterTags(character.tags)))
  ).sort((left, right) => left.localeCompare(right));
  const selectedTag = tag?.trim() ?? "";
  const filteredCharacters = selectedTag
    ? baseCharacters.filter((character) => includesTag(toCharacterTags(character.tags), selectedTag))
    : baseCharacters;
  const total = filteredCharacters.length;
  const characters = filteredCharacters.slice((page - 1) * pageSize, page * pageSize);
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
