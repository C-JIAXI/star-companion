import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { serializeCharacter } from "../serializers.js";

type CharacterPageQuery = {
  q: string;
  page: number;
  pageSize: number;
};

type CharacterPage = {
  items: ReturnType<typeof serializeCharacter>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const buildCharacterSearchWhere = (q: string): Prisma.CharacterWhereInput | undefined => {
  const keyword = q.trim();
  if (!keyword) {
    return undefined;
  }

  return {
    OR: [
      { name: { contains: keyword } },
      { prefix: { contains: keyword } },
      { prompt: { contains: keyword } },
      { suffix: { contains: keyword } },
      { htmlCss: { contains: keyword } }
    ]
  };
};

export const listCharactersPage = async ({
  q,
  page,
  pageSize
}: CharacterPageQuery): Promise<CharacterPage> => {
  const where = buildCharacterSearchWhere(q);
  const [total, characters] = await prisma.$transaction([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items: characters.map((character) => serializeCharacter(character)),
    total,
    page,
    pageSize,
    totalPages
  };
};
