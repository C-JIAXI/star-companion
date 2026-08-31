import "dotenv/config";
import { PrismaClient, type Prisma } from "@prisma/client";

const performanceMetricsEnabled = process.env.STAR_COMPANION_PERF_METRICS === "1";
let performanceQueryCount = 0;
const prismaOptions: Prisma.PrismaClientOptions = performanceMetricsEnabled
  ? { log: [{ emit: "event", level: "query" }] }
  : {};

export const prisma = new PrismaClient(prismaOptions) as PrismaClient<Prisma.PrismaClientOptions, "query">;
if (performanceMetricsEnabled) prisma.$on("query", () => { performanceQueryCount += 1; });

export const getLocalPerformanceMetrics = () => ({
  enabled: performanceMetricsEnabled,
  queryCount: performanceQueryCount,
  rssBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed
});

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
