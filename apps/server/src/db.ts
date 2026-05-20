import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const connectDatabase = async () => {
  await prisma.$connect();
};

export const disconnectDatabase = async () => {
  await prisma.$disconnect();
};
