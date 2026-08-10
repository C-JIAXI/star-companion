import { createHash } from "node:crypto";
import { z } from "zod";
import {
  backupCharacterSchema,
  backupChatSchema,
  backupMemorySchema,
  backupMessageSchema,
  backupSettingsSchema
} from "../schemas.js";
import type { backupImportSchema } from "../schemas.js";

export const backupEntityTypes = [
  "settings",
  "characters",
  "chats",
  "messages",
  "memories"
] as const;

export type BackupEntityType = (typeof backupEntityTypes)[number];
export type BackupMode = "merge" | "replace";
export type BackupConflictAction = "keep_existing" | "use_incoming" | "skip";
export type ParsedBackup = z.infer<typeof backupImportSchema>;

export type BackupImpactCounts = {
  added: number;
  updated: number;
  skipped: number;
  conflicts: number;
  invalid: number;
  deleted: number;
};

export type BackupValidationIssue = {
  entity: BackupEntityType | "backup";
  index: number | null;
  code: "schema_version" | "invalid_record" | "duplicate_id" | "missing_reference";
  message: string;
};

export type BackupConflict = {
  key: string;
  entity: BackupEntityType;
  id: string;
};

export type BackupPreview = {
  previewId: string;
  schemaVersion: 1 | null;
  mode: BackupMode;
  sourceExportedAt: string | null;
  counts: BackupImpactCounts;
  byEntity: Record<BackupEntityType, BackupImpactCounts>;
  conflicts: BackupConflict[];
  issues: BackupValidationIssue[];
  canExecute: boolean;
  requiresRecoveryPoint: boolean;
};

export type BackupCandidate = {
  schemaVersion?: unknown;
  exportedAt?: unknown;
  settings?: unknown;
  characters?: unknown;
  chats?: unknown;
  messages?: unknown;
  memories?: unknown;
  mode: BackupMode;
};

export type BackupRecordStatus = "added" | "skipped" | "conflict" | "invalid";

export type AnalyzedRecord<T> = {
  index: number;
  value: T;
  id: string | null;
  key: string | null;
  status: BackupRecordStatus;
};

export type BackupAnalysis = {
  backup: ParsedBackup;
  preview: BackupPreview;
  records: {
    settings: AnalyzedRecord<NonNullable<ParsedBackup["settings"]>> | null;
    characters: Array<AnalyzedRecord<ParsedBackup["characters"][number]>>;
    chats: Array<AnalyzedRecord<ParsedBackup["chats"][number]>>;
    messages: Array<AnalyzedRecord<ParsedBackup["messages"][number]>>;
    memories: Array<AnalyzedRecord<ParsedBackup["memories"][number]>>;
  };
};

const emptyCounts = (): BackupImpactCounts => ({
  added: 0,
  updated: 0,
  skipped: 0,
  conflicts: 0,
  invalid: 0,
  deleted: 0
});

const canonicalize = (value: unknown, key = ""): unknown => {
  if (key === "createdAt" || key === "updatedAt" || key === "exportedAt" || key === "messageCount") {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry)).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([entryKey, entryValue]) => {
          const normalized = canonicalize(entryValue, entryKey);
          return normalized === undefined ? [] : [[entryKey, normalized]];
        })
    );
  }
  return value;
};

const sameValue = (incoming: unknown, existing: unknown, partial = false) => {
  if (partial && incoming && existing && typeof incoming === "object" && typeof existing === "object") {
    const incomingRecord = incoming as Record<string, unknown>;
    const existingRecord = existing as Record<string, unknown>;
    const projected = Object.fromEntries(
      Object.keys(incomingRecord).map((key) => [key, existingRecord[key]])
    );
    return JSON.stringify(canonicalize(incomingRecord)) === JSON.stringify(canonicalize(projected));
  }
  return JSON.stringify(canonicalize(incoming)) === JSON.stringify(canonicalize(existing));
};

const formatInvalidMessage = (entity: BackupEntityType, index: number) =>
  `${entity} record ${index + 1} has invalid fields or dates.`;

const parseCollection = <T>(
  candidate: BackupCandidate,
  entity: Exclude<BackupEntityType, "settings">,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  issues: BackupValidationIssue[],
  invalidIndexes: Record<Exclude<BackupEntityType, "settings">, Set<number>>
) => {
  const raw = candidate[entity];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({
      entity,
      index: null,
      code: "invalid_record",
      message: `${entity} must be a list.`
    });
    return [];
  }

  const parsed: T[] = [];
  raw.forEach((value, index) => {
    const result = schema.safeParse(value);
    if (result.success) {
      parsed.push(result.data);
      return;
    }
    invalidIndexes[entity].add(index);
    issues.push({
      entity,
      index,
      code: "invalid_record",
      message: formatInvalidMessage(entity, index)
    });
  });
  return parsed;
};

const addIssue = (
  issues: BackupValidationIssue[],
  invalidIndexes: Record<Exclude<BackupEntityType, "settings">, Set<number>>,
  entity: Exclude<BackupEntityType, "settings">,
  index: number,
  code: BackupValidationIssue["code"],
  message: string
) => {
  invalidIndexes[entity].add(index);
  issues.push({ entity, index, code, message });
};

const collectIds = (records: Array<{ id?: string }>) =>
  new Set(records.flatMap((record) => (record.id ? [record.id] : [])));

const duplicateIds = (
  records: Array<{ id?: string }>,
  entity: Exclude<BackupEntityType, "settings">,
  issues: BackupValidationIssue[],
  invalidIndexes: Record<Exclude<BackupEntityType, "settings">, Set<number>>
) => {
  const seen = new Map<string, number>();
  records.forEach((record, index) => {
    if (!record.id) return;
    const prior = seen.get(record.id);
    if (prior === undefined) {
      seen.set(record.id, index);
      return;
    }
    addIssue(
      issues,
      invalidIndexes,
      entity,
      index,
      "duplicate_id",
      `${entity} record ${index + 1} repeats an ID already used in this backup.`
    );
  });
};

export const analyzeBackupCandidate = (
  candidate: BackupCandidate,
  current: ParsedBackup
): BackupAnalysis => {
  const issues: BackupValidationIssue[] = [];
  const invalidIndexes = {
    characters: new Set<number>(),
    chats: new Set<number>(),
    messages: new Set<number>(),
    memories: new Set<number>()
  };

  const schemaVersion = candidate.schemaVersion === 1 ? 1 : null;
  if (schemaVersion !== 1) {
    issues.push({
      entity: "backup",
      index: null,
      code: "schema_version",
      message: "This backup version is not supported. Star Companion currently accepts schemaVersion 1."
    });
  }

  let sourceExportedAt: string | null = null;
  if (candidate.exportedAt !== undefined) {
    const parsedDate = z.string().datetime().safeParse(candidate.exportedAt);
    if (!parsedDate.success) {
      issues.push({
        entity: "backup",
        index: null,
        code: "invalid_record",
        message: "The backup export date is invalid."
      });
    } else {
      sourceExportedAt = parsedDate.data;
    }
  }

  let settings: ParsedBackup["settings"] = null;
  if (candidate.settings !== undefined && candidate.settings !== null) {
    const result = backupSettingsSchema.safeParse(candidate.settings);
    if (result.success) {
      settings = result.data;
    } else {
      issues.push({
        entity: "settings",
        index: 0,
        code: "invalid_record",
        message: "The backup settings record is invalid."
      });
    }
  }

  const characters = parseCollection(candidate, "characters", backupCharacterSchema, issues, invalidIndexes);
  const chats = parseCollection(candidate, "chats", backupChatSchema, issues, invalidIndexes);
  const messages = parseCollection(candidate, "messages", backupMessageSchema, issues, invalidIndexes);
  const memories = parseCollection(candidate, "memories", backupMemorySchema, issues, invalidIndexes);

  duplicateIds(characters, "characters", issues, invalidIndexes);
  duplicateIds(chats, "chats", issues, invalidIndexes);
  duplicateIds(messages, "messages", issues, invalidIndexes);
  duplicateIds(memories, "memories", issues, invalidIndexes);

  const characterIds = new Set([...collectIds(current.characters), ...collectIds(characters)]);
  const chatIds = new Set([...collectIds(current.chats), ...collectIds(chats)]);
  const messageIds = new Set([...collectIds(current.messages), ...collectIds(messages)]);
  const messagesById = new Map(
    [...current.messages, ...messages].flatMap((message) => (message.id ? [[message.id, message] as const] : []))
  );

  chats.forEach((chat, index) => {
    if (chat.characterId && !characterIds.has(chat.characterId)) {
      addIssue(issues, invalidIndexes, "chats", index, "missing_reference", `Chat record ${index + 1} refers to a character that is not available.`);
    }
    if (chat.parentChatId && !chatIds.has(chat.parentChatId)) {
      addIssue(issues, invalidIndexes, "chats", index, "missing_reference", `Chat record ${index + 1} refers to a parent chat that is not available.`);
    }
    if (chat.branchSourceMessageId) {
      const source = messagesById.get(chat.branchSourceMessageId);
      if (!source || (chat.parentChatId && source.chatId !== chat.parentChatId)) {
        addIssue(issues, invalidIndexes, "chats", index, "missing_reference", `Chat record ${index + 1} has an invalid branch source message reference.`);
      }
    }
  });

  const chatsById = new Map([...current.chats, ...chats].flatMap((chat) => (chat.id ? [[chat.id, chat] as const] : [])));
  messages.forEach((message, index) => {
    const chat = chatsById.get(message.chatId);
    if (!chat) {
      addIssue(issues, invalidIndexes, "messages", index, "missing_reference", `Message record ${index + 1} refers to a chat that is not available.`);
    }
    if (message.characterId && !characterIds.has(message.characterId)) {
      addIssue(issues, invalidIndexes, "messages", index, "missing_reference", `Message record ${index + 1} refers to a character that is not available.`);
    }
    if (chat?.characterId && message.characterId && chat.characterId !== message.characterId) {
      addIssue(issues, invalidIndexes, "messages", index, "missing_reference", `Message record ${index + 1} does not belong to the chat character.`);
    }
  });

  memories.forEach((memory, index) => {
    if (!chatIds.has(memory.chatId)) {
      addIssue(issues, invalidIndexes, "memories", index, "missing_reference", `Memory record ${index + 1} refers to a chat that is not available.`);
    }
    for (const sourceMessageId of memory.sourceMessageIds) {
      const source = messagesById.get(sourceMessageId);
      if (!messageIds.has(sourceMessageId) || source?.chatId !== memory.chatId) {
        addIssue(issues, invalidIndexes, "memories", index, "missing_reference", `Memory record ${index + 1} has an invalid source message reference.`);
        break;
      }
    }
  });

  const backup: ParsedBackup = {
    schemaVersion: 1,
    ...(sourceExportedAt ? { exportedAt: sourceExportedAt } : {}),
    settings,
    characters,
    chats,
    messages,
    memories,
    mode: candidate.mode
  };

  const byEntity = Object.fromEntries(backupEntityTypes.map((entity) => [entity, emptyCounts()])) as Record<BackupEntityType, BackupImpactCounts>;
  byEntity.settings.invalid = issues.some((issue) => issue.entity === "settings") ? 1 : 0;
  for (const entity of ["characters", "chats", "messages", "memories"] as const) {
    byEntity[entity].invalid = invalidIndexes[entity].size + issues.filter(
      (issue) => issue.entity === entity && issue.index === null
    ).length;
  }

  const conflicts: BackupConflict[] = [];
  const analyzeRecord = <T extends { id?: string }>(entity: Exclude<BackupEntityType, "settings">, value: T, index: number, existingById: Map<string, unknown>): AnalyzedRecord<T> => {
    const id = value.id ?? null;
    if (invalidIndexes[entity].has(index)) return { index, value, id, key: null, status: "invalid" };
    const existing = id ? existingById.get(id) : undefined;
    if (!existing) {
      byEntity[entity].added += 1;
      return { index, value, id, key: null, status: "added" };
    }
    if (sameValue(value, existing)) {
      byEntity[entity].skipped += 1;
      return { index, value, id, key: null, status: "skipped" };
    }
    const key = `${entity}:${id}`;
    byEntity[entity].updated += 1;
    byEntity[entity].conflicts += 1;
    conflicts.push({ key, entity, id: id! });
    return { index, value, id, key, status: "conflict" };
  };

  const currentMaps = {
    characters: new Map(current.characters.flatMap((value) => (value.id ? [[value.id, value] as const] : []))),
    chats: new Map(current.chats.flatMap((value) => (value.id ? [[value.id, value] as const] : []))),
    messages: new Map(current.messages.flatMap((value) => (value.id ? [[value.id, value] as const] : []))),
    memories: new Map(current.memories.flatMap((value) => (value.id ? [[value.id, value] as const] : [])))
  };

  let settingsRecord: BackupAnalysis["records"]["settings"] = null;
  if (settings && byEntity.settings.invalid === 0) {
    if (!current.settings) {
      byEntity.settings.added = 1;
      settingsRecord = { index: 0, value: settings, id: "settings", key: null, status: "added" };
    } else if (sameValue(settings, current.settings, true)) {
      byEntity.settings.skipped = 1;
      settingsRecord = { index: 0, value: settings, id: "settings", key: null, status: "skipped" };
    } else {
      const key = "settings:settings";
      byEntity.settings.updated = 1;
      byEntity.settings.conflicts = 1;
      conflicts.push({ key, entity: "settings", id: "settings" });
      settingsRecord = { index: 0, value: settings, id: "settings", key, status: "conflict" };
    }
  }

  const records = {
    settings: settingsRecord,
    characters: characters.map((value, index) => analyzeRecord("characters", value, index, currentMaps.characters)),
    chats: chats.map((value, index) => analyzeRecord("chats", value, index, currentMaps.chats)),
    messages: messages.map((value, index) => analyzeRecord("messages", value, index, currentMaps.messages)),
    memories: memories.map((value, index) => analyzeRecord("memories", value, index, currentMaps.memories))
  };

  if (candidate.mode === "replace") {
    for (const entity of ["characters", "chats", "messages", "memories"] as const) {
      const incomingIds = collectIds(backup[entity]);
      byEntity[entity].deleted = current[entity].filter((value) => value.id && !incomingIds.has(value.id)).length;
    }
  }

  const counts = backupEntityTypes.reduce((total, entity) => {
    const currentCounts = byEntity[entity];
    for (const field of Object.keys(total) as Array<keyof BackupImpactCounts>) {
      total[field] += currentCounts[field];
    }
    return total;
  }, emptyCounts());
  counts.invalid += issues.filter((issue) => issue.entity === "backup").length;

  const fingerprintIds = {
    characters: collectIds(characters),
    chats: collectIds(chats),
    messages: collectIds(messages),
    memories: collectIds(memories)
  };
  const fingerprintCurrent = candidate.mode === "replace"
    ? current
    : {
        settings: settings ? current.settings : null,
        characters: current.characters.filter((value) => value.id && fingerprintIds.characters.has(value.id)),
        chats: current.chats.filter((value) => value.id && fingerprintIds.chats.has(value.id)),
        messages: current.messages.filter((value) => value.id && fingerprintIds.messages.has(value.id)),
        memories: current.memories.filter((value) => value.id && fingerprintIds.memories.has(value.id))
      };
  const previewId = createHash("sha256")
    .update(JSON.stringify(canonicalize({ backup, current: fingerprintCurrent, mode: candidate.mode, issues })))
    .digest("hex");
  const requiresRecoveryPoint = candidate.mode === "replace" || counts.updated > 0 || counts.deleted > 0;

  return {
    backup,
    records,
    preview: {
      previewId,
      schemaVersion,
      mode: candidate.mode,
      sourceExportedAt,
      counts,
      byEntity,
      conflicts,
      issues,
      canExecute: schemaVersion === 1 && issues.length === 0,
      requiresRecoveryPoint
    }
  };
};
