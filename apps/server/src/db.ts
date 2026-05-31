import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

const repairDanglingCharacterRefs = async () => {
  await prisma.$executeRawUnsafe(`
    UPDATE Chat
    SET characterId = NULL
    WHERE characterId IS NOT NULL
      AND characterId NOT IN (SELECT id FROM Character)
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE Message
    SET characterId = NULL
    WHERE characterId IS NOT NULL
      AND characterId NOT IN (SELECT id FROM Character)
  `);
};

export const connectDatabase = async () => {
  await prisma.$connect();
  await repairDanglingCharacterRefs();
};

export const disconnectDatabase = async () => {
  await prisma.$disconnect();
};
