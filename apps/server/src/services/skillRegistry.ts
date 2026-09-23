import type { Prisma, SkillPackage } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { BUILTIN_SKILLS, parseSkillImport } from "./skillPackages.js";

const strings = (value: Prisma.JsonValue): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const references = (value: Prisma.JsonValue): Record<string, string> => {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};
const summary = (skill: SkillPackage) => ({
  name: skill.name, description: skill.description, source: skill.source as "builtin" | "imported",
  version: skill.version, digest: skill.digest, compatibility: skill.compatibility,
  unsupportedFiles: strings(skill.unsupportedFiles), agentEnabled: skill.agentEnabled,
  enabledChatIds: strings(skill.enabledChatIds), updatedAt: skill.updatedAt.toISOString()
});

export const ensureBuiltinSkills = async () => {
  for (const builtin of BUILTIN_SKILLS) {
    const existing = await prisma.skillPackage.findUnique({ where: { name: builtin.name }, select: { source: true, digest: true } });
    if (existing?.source === "imported") continue;
    const values = {
      description: builtin.description, digest: builtin.digest, skillMd: builtin.skillMd,
      references: builtin.references as Prisma.InputJsonValue, compatibility: builtin.compatibility,
      unsupportedFiles: builtin.unsupportedFiles as Prisma.InputJsonValue
    };
    if (!existing) await prisma.skillPackage.create({ data: { name: builtin.name, source: "builtin", agentEnabled: true, ...values } });
    else if (existing.digest !== builtin.digest) await prisma.skillPackage.update({ where: { name: builtin.name }, data: { ...values, version: { increment: 1 } } });
  }
};

export const listSkills = async () => {
  await ensureBuiltinSkills();
  return (await prisma.skillPackage.findMany({ orderBy: { name: "asc" } })).map(summary);
};

export const getSkill = async (name: string) => {
  await ensureBuiltinSkills();
  const skill = await prisma.skillPackage.findUnique({ where: { name } });
  if (!skill) throw new HttpError(404, "Skill not found");
  return { ...summary(skill), skillMd: skill.skillMd, referencePaths: Object.keys(references(skill.references)).sort() };
};

export const getSkillReference = async (name: string, path: string) => {
  const skill = await prisma.skillPackage.findUnique({ where: { name } });
  if (!skill) throw new HttpError(404, "Skill not found");
  const content = references(skill.references)[path];
  if (content === undefined) throw new HttpError(404, "Skill reference not found");
  return { name, path, content };
};

export const previewSkillImport = async (input: { format: "markdown" | "zip"; markdown?: string; dataBase64?: string }) => {
  const parsed = await parseSkillImport(input);
  const existing = await prisma.skillPackage.findUnique({ where: { name: parsed.name }, select: { version: true, source: true } });
  const builtIn = BUILTIN_SKILLS.some((skill) => skill.name === parsed.name);
  return { name: parsed.name, description: parsed.description, digest: parsed.digest,
    compatibility: parsed.compatibility, unsupportedFiles: parsed.unsupportedFiles,
    referencePaths: Object.keys(parsed.references).sort(), existingVersion: existing?.version ?? null,
    canReplace: !builtIn && existing?.source !== "builtin" };
};

export const importSkill = async (input: { format: "markdown" | "zip"; markdown?: string; dataBase64?: string; replaceVersion?: number }) => {
  const parsed = await parseSkillImport(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.skillPackage.findUnique({ where: { name: parsed.name } });
    if (BUILTIN_SKILLS.some((builtin) => builtin.name === parsed.name) || existing?.source === "builtin") throw new HttpError(409, "Built-in Skills cannot be replaced");
    if (existing && existing.version !== input.replaceVersion) throw new HttpError(409, "Skill name already exists; confirm the current version before replacing");
    if (!existing && input.replaceVersion !== undefined) throw new HttpError(409, "Skill changed after preview");
    const values = {
      description: parsed.description, digest: parsed.digest, skillMd: parsed.skillMd,
      references: parsed.references as Prisma.InputJsonValue, compatibility: parsed.compatibility,
      unsupportedFiles: parsed.unsupportedFiles as Prisma.InputJsonValue
    };
    const skill = existing
      ? await tx.skillPackage.update({ where: { name: parsed.name, version: existing.version }, data: { ...values, version: { increment: 1 }, agentEnabled: false, enabledChatIds: [] } })
      : await tx.skillPackage.create({ data: { name: parsed.name, source: "imported", agentEnabled: false, ...values } });
    return summary(skill);
  });
};

export const setSkillEnabled = async (name: string, input: { expectedVersion: number; agentEnabled?: boolean; chatId?: string; chatEnabled?: boolean }) => {
  return prisma.$transaction(async (tx) => {
    const skill = await tx.skillPackage.findUnique({ where: { name } });
    if (!skill) throw new HttpError(404, "Skill not found");
    if (skill.version !== input.expectedVersion) throw new HttpError(409, "Skill changed; review its current version");
    const ids = new Set(strings(skill.enabledChatIds));
    if (input.chatId) {
      const chat = await tx.chat.findFirst({ where: { id: input.chatId, deletedAt: null }, select: { id: true } });
      if (!chat) throw new HttpError(404, "Chat not found");
      if (input.chatEnabled) ids.add(input.chatId); else ids.delete(input.chatId);
      if (ids.size > 200) throw new HttpError(400, "Too many chats enabled for one Skill");
    }
    const updated = await tx.skillPackage.update({ where: { name, version: skill.version }, data: {
      agentEnabled: input.agentEnabled ?? skill.agentEnabled,
      enabledChatIds: [...ids] as Prisma.InputJsonValue,
      version: { increment: 1 }
    } });
    return summary(updated);
  });
};

export const deleteSkill = async (name: string, expectedVersion: number) => {
  const removed = await prisma.skillPackage.deleteMany({ where: { name, version: expectedVersion, source: "imported" } });
  if (!removed.count) throw new HttpError(409, "Skill changed or cannot be removed");
  return { deleted: true };
};

export const listEnabledAgentSkillCatalog = async () => {
  await ensureBuiltinSkills();
  return prisma.skillPackage.findMany({ where: { agentEnabled: true }, select: { name: true, description: true }, orderBy: { name: "asc" } });
};

export const listEnabledChatSkillCatalog = async (chatId: string) => {
  await ensureBuiltinSkills();
  const rows = await prisma.skillPackage.findMany({ select: { name: true, description: true, enabledChatIds: true }, orderBy: { name: "asc" } });
  return rows.filter((row) => strings(row.enabledChatIds).includes(chatId)).map(({ name, description }) => ({ name, description }));
};

export const loadEnabledAgentSkill = async (name: string, path?: string) => {
  const skill = await prisma.skillPackage.findFirst({ where: { name, agentEnabled: true } });
  if (!skill) return null;
  if (path) {
    const content = references(skill.references)[path];
    return content === undefined ? null : { name, path, content };
  }
  return { name, content: skill.skillMd, referencePaths: Object.keys(references(skill.references)).sort(), unsupportedFiles: strings(skill.unsupportedFiles) };
};

export const loadEnabledChatSkill = async (chatId: string, name: string, path?: string) => {
  const skill = await prisma.skillPackage.findUnique({ where: { name } });
  if (!skill || !strings(skill.enabledChatIds).includes(chatId)) return null;
  if (path) {
    const content = references(skill.references)[path];
    return content === undefined ? null : { name, path, content };
  }
  return { name, content: skill.skillMd, referencePaths: Object.keys(references(skill.references)).sort(), unsupportedFiles: strings(skill.unsupportedFiles) };
};
