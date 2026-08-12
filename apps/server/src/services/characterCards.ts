import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import type { Character, Prisma } from "@prisma/client";
import { HttpError } from "../lib/http.js";

type LoreTriggerMode = "user" | "assistant" | "both";

export type CharacterLoreEntryRecord = {
  id: string;
  keys: string[];
  content: string;
  priority: number;
  scope: "prefix" | "prompt" | "suffix";
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
};

export type QuickReplyRecord = {
  id: string;
  label: string;
  content: string;
};

export type CharacterPromptFields = {
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  loreEntries: CharacterLoreEntryRecord[];
};

export type ResolvedCharacterRecord = CharacterPromptFields & {
  name: string;
  avatar: string | null;
  description: string;
  openingHtml: string;
  visibility: "public" | "private";
  canViewPrompt: boolean;
};

type PasswordAccessControl = {
  version: 1;
  salt: string;
  verifier: string;
};

type PrivateCharacterAccess = PasswordAccessControl;

export type CharacterExportCard =
  | {
      schemaVersion: 1;
      format: "character-card";
      visibility: "public";
      cardId: string;
      exportedAt?: string;
      character: {
        name: string;
        avatar?: string | null;
        description: string;
        tags: string[];
        prefix: string;
        prompt: string;
        suffix: string;
        htmlCss: string;
        openingHtml: string;
        loreEntries: ImportedCharacterLoreEntryInput[];
        quickReplies: ImportedQuickReplyInput[];
      };
    }
  | {
      schemaVersion: 1;
      format: "character-card";
      visibility: "private";
      cardId: string;
      exportedAt?: string;
      character: {
        name: string;
        avatar?: string | null;
        description?: string;
        tags?: string[];
        openingHtml?: string;
        quickReplies?: ImportedQuickReplyInput[];
      };
      protectedPayload: {
        version: 1;
        algorithm: "aes-256-gcm";
        salt: string;
        iv: string;
        tag: string;
        ciphertext: string;
        accessControl: PasswordAccessControl;
      };
    };

type ImportedCharacterLoreEntryInput = Omit<CharacterLoreEntryRecord, "id"> & { id?: string };
type ImportedQuickReplyInput = Omit<QuickReplyRecord, "id"> & { id?: string };

export type CharacterImportSource = CharacterExportCard;

type EncryptedPromptPayload = {
  version: 1;
  accessControl: PasswordAccessControl;
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  loreEntries: CharacterLoreEntryRecord[];
};

type StoredPrivateCharacterRecord = {
  __privateCharacter: {
    version: 1;
    algorithm: "aes-256-gcm";
    iv: string;
    tag: string;
    ciphertext: string;
    accessControl: PasswordAccessControl;
    exportSalt?: string;
  };
};

const STORE_KEY_MATERIAL = "local-roleplay-platform/private-character-store/v1";

const toBase64Url = (value: Buffer) => value.toString("base64url");

const fromBase64Url = (value: string) => Buffer.from(value, "base64url");

const storeKey = () =>
  createHash("sha256")
    .update(process.env.API_KEY_ENCRYPTION_SECRET ?? "local-roleplay-development-secret")
    .update(`:${STORE_KEY_MATERIAL}`)
    .digest();

const exportKey = (password: string, salt: string) => scryptSync(password, salt, 32);

const normalizeLoreTriggerMode = (value: unknown): LoreTriggerMode => {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return "both";
};

const normalizeLoreScope = (value: unknown): "prefix" | "prompt" | "suffix" => {
  if (value === "prefix" || value === "suffix") {
    return value;
  }
  return "prompt";
};

const isPasswordAccessControl = (value: unknown): value is PasswordAccessControl => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const accessControl = value as Record<string, unknown>;
  return (
    accessControl.version === 1 &&
    typeof accessControl.salt === "string" &&
    typeof accessControl.verifier === "string"
  );
};

const buildPasswordAccessControl = (password: string): PasswordAccessControl => {
  const salt = toBase64Url(randomBytes(16));
  return {
    version: 1,
    salt,
    verifier: toBase64Url(scryptSync(password, salt, 32))
  };
};

const verifyPasswordAccessControl = (password: string, accessControl: PasswordAccessControl) => {
  const actual = scryptSync(password, accessControl.salt, 32);
  const expected = fromBase64Url(accessControl.verifier);

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
};

export const toCharacterLoreEntries = (value: unknown): CharacterLoreEntryRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): CharacterLoreEntryRecord | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const entry = item as Record<string, unknown>;
      const id = entry.id;
      const keys = entry.keys;
      const content = entry.content;
      const priority = entry.priority;

      if (
        (!id || typeof id !== "string") ||
        !Array.isArray(keys) ||
        typeof content !== "string" ||
        typeof priority !== "number"
      ) {
        return null;
      }

      return {
        id: typeof id === "string" && id ? id : randomUUID(),
        keys: keys.filter((key): key is string => typeof key === "string"),
        content,
        priority,
        scope: normalizeLoreScope(entry.scope),
        triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
        alwaysActive: entry.alwaysActive === true,
        enabled: entry.enabled !== false
      };
    })
    .filter((entry): entry is CharacterLoreEntryRecord => entry !== null);
};

export const toQuickReplies = (value: unknown): QuickReplyRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): QuickReplyRecord | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const entry = item as Record<string, unknown>;
      const id = entry.id;
      const label = entry.label;
      const content = entry.content;

      if (typeof label !== "string" || !label || typeof content !== "string" || !content) {
        return null;
      }

      return {
        id: typeof id === "string" && id ? id : randomUUID(),
        label,
        content
      };
    })
    .filter((entry): entry is QuickReplyRecord => entry !== null);
};

export const toCharacterTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
};

const encryptPayload = (payload: EncryptedPromptPayload, key: Buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    ciphertext: toBase64Url(ciphertext)
  };
};

const decryptPayload = (encrypted: { iv: string; tag: string; ciphertext: string }, key: Buffer) => {
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64Url(encrypted.iv));
  decipher.setAuthTag(fromBase64Url(encrypted.tag));

  return JSON.parse(
    Buffer.concat([
      decipher.update(fromBase64Url(encrypted.ciphertext)),
      decipher.final()
    ]).toString("utf8")
  ) as EncryptedPromptPayload;
};

const isStoredPrivateCharacterRecord = (value: Prisma.JsonValue): value is StoredPrivateCharacterRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const privateCharacter = candidate.__privateCharacter;
  if (!privateCharacter || typeof privateCharacter !== "object" || Array.isArray(privateCharacter)) {
    return false;
  }

  const envelope = privateCharacter as Record<string, unknown>;
  return (
    envelope.version === 1 &&
    envelope.algorithm === "aes-256-gcm" &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.ciphertext === "string" &&
    isPasswordAccessControl(envelope.accessControl)
  );
};

const resolvePrivateCharacterAccess = (
  payload: Pick<EncryptedPromptPayload, "accessControl">,
  envelope: Pick<StoredPrivateCharacterRecord["__privateCharacter"], "accessControl">
): PrivateCharacterAccess => {
  if (!isPasswordAccessControl(payload.accessControl) || !isPasswordAccessControl(envelope.accessControl)) {
    throw new Error("Unsupported private character access control");
  }

  if (
    payload.accessControl.salt !== envelope.accessControl.salt ||
    payload.accessControl.verifier !== envelope.accessControl.verifier
  ) {
    throw new Error("Stored private character password verifier mismatch");
  }

  return payload.accessControl;
};

const toEncryptedPromptPayload = (
  fields: CharacterPromptFields,
  access: PrivateCharacterAccess
): EncryptedPromptPayload => ({
  version: 1,
  accessControl: access,
  prefix: fields.prefix,
  prompt: fields.prompt,
  suffix: fields.suffix,
  htmlCss: fields.htmlCss,
  loreEntries: fields.loreEntries
});

const normalizePromptFields = (value: {
  prefix?: string | null;
  prompt?: string | null;
  suffix?: string | null;
  htmlCss?: string | null;
  loreEntries?: unknown;
}): CharacterPromptFields => ({
  prefix: value.prefix ?? "",
  prompt: value.prompt ?? "",
  suffix: value.suffix ?? "",
  htmlCss: value.htmlCss ?? "",
  loreEntries: toCharacterLoreEntries(value.loreEntries)
});

const decryptStoredPromptFields = (record: StoredPrivateCharacterRecord, password?: string): {
  access: PrivateCharacterAccess;
  fields: CharacterPromptFields;
} => {
  const { __privateCharacter } = record;

  if (__privateCharacter.exportSalt) {
    if (!password) {
      throw new HttpError(400, "Password is required to unlock imported private character");
    }

    if (isPasswordAccessControl(__privateCharacter.accessControl)) {
      if (!verifyPasswordAccessControl(password, __privateCharacter.accessControl)) {
        throw new HttpError(403, "Private character password is invalid");
      }
    }

    const key = exportKey(password, __privateCharacter.exportSalt);
    const payload = decryptPayload(__privateCharacter, key);
    return {
      access: resolvePrivateCharacterAccess(payload, __privateCharacter),
      fields: normalizePromptFields(payload)
    };
  }

  const payload = decryptPayload(__privateCharacter, storeKey());

  return {
    access: resolvePrivateCharacterAccess(payload, __privateCharacter),
    fields: normalizePromptFields(payload)
  };
};

const buildStoredPrivateCharacterJson = (
  fields: CharacterPromptFields,
  access: PrivateCharacterAccess
): Prisma.InputJsonValue => {
  const encrypted = encryptPayload(toEncryptedPromptPayload(fields, access), storeKey());

  return {
    __privateCharacter: {
      version: 1,
      algorithm: "aes-256-gcm",
      ...encrypted,
      accessControl: access
    }
  } satisfies StoredPrivateCharacterRecord;
};

export const reEncryptImportedCharacter = (
  character: Pick<Character, "loreEntries">,
  password: string
): Prisma.InputJsonValue => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    throw new HttpError(400, "Character is not a private character");
  }

  const record = character.loreEntries as StoredPrivateCharacterRecord;
  if (!record.__privateCharacter.exportSalt) {
    throw new HttpError(400, "Character is not an imported character");
  }

  const { access, fields } = decryptStoredPromptFields(character.loreEntries, password);
  return buildStoredPrivateCharacterJson(fields, access);
};

const canViewPrivateCharacter = (access: PrivateCharacterAccess, password?: string) => {
  return Boolean(password && verifyPasswordAccessControl(password, access));
};

const assertPrivateCharacterPassword = (
  access: PrivateCharacterAccess,
  password: string | undefined,
  options: {
    missingMessage: string;
    invalidMessage: string;
  }
) => {
  if (!password) {
    throw new HttpError(400, options.missingMessage);
  }

  if (!verifyPasswordAccessControl(password, access)) {
    throw new HttpError(403, options.invalidMessage);
  }
};

export const resolveCharacterRecord = (
  character: Pick<Character, "name" | "avatar" | "description" | "prefix" | "prompt" | "suffix" | "htmlCss" | "openingHtml" | "loreEntries">,
  password?: string
): ResolvedCharacterRecord => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    return {
      name: character.name,
      avatar: character.avatar,
      description: character.description,
      openingHtml: character.openingHtml ?? "",
      ...normalizePromptFields(character),
      visibility: "public",
      canViewPrompt: true
    };
  }

  const record = character.loreEntries as StoredPrivateCharacterRecord;

  if (record.__privateCharacter.exportSalt && !password) {
    return {
      name: character.name,
      avatar: character.avatar,
      description: character.description,
      openingHtml: character.openingHtml ?? "",
      prefix: "",
      prompt: "",
      suffix: "",
      htmlCss: "",
      loreEntries: [],
      visibility: "private",
      canViewPrompt: false
    };
  }

  try {
    const { access, fields } = decryptStoredPromptFields(character.loreEntries, password);
    const canViewPrompt = canViewPrivateCharacter(access, password);

    return {
      name: character.name,
      avatar: character.avatar,
      description: character.description,
      openingHtml: character.openingHtml ?? "",
      prefix: canViewPrompt ? fields.prefix : "",
      prompt: canViewPrompt ? fields.prompt : "",
      suffix: canViewPrompt ? fields.suffix : "",
      htmlCss: canViewPrompt ? fields.htmlCss : "",
      loreEntries: canViewPrompt ? fields.loreEntries : [],
      visibility: "private",
      canViewPrompt
    };
  } catch {
    return {
      name: character.name,
      avatar: character.avatar,
      description: character.description,
      openingHtml: character.openingHtml ?? "",
      prefix: "",
      prompt: "",
      suffix: "",
      htmlCss: "",
      loreEntries: [],
      visibility: "private",
      canViewPrompt: false
    };
  }
};

export const resolveCharacterPromptFields = (
  character: Pick<Character, "prefix" | "prompt" | "suffix" | "htmlCss" | "loreEntries">,
  password?: string
): CharacterPromptFields => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    return normalizePromptFields(character);
  }

  const record = character.loreEntries as StoredPrivateCharacterRecord;
  if (record.__privateCharacter.exportSalt && !password) {
    return { prefix: "", prompt: "", suffix: "", htmlCss: "", loreEntries: [] };
  }

  return decryptStoredPromptFields(character.loreEntries, password).fields;
};

export const createCharacterExportCard = (
  character: Pick<Character, "name" | "avatar" | "description" | "tags" | "prefix" | "prompt" | "suffix" | "htmlCss" | "openingHtml" | "loreEntries" | "quickReplies" | "cardId">,
  visibility: "public" | "private",
  password?: string
): CharacterExportCard => {
  const promptFields = resolveCharacterPromptFields(character, password);
  const existingPrivateRecord = isStoredPrivateCharacterRecord(character.loreEntries)
    ? decryptStoredPromptFields(character.loreEntries, password)
    : null;
  const quickReplies = toQuickReplies(character.quickReplies);
  const tags = toCharacterTags(character.tags);
  const openingHtml = character.openingHtml ?? "";

  if (visibility === "public") {
    if (existingPrivateRecord && !canViewPrivateCharacter(existingPrivateRecord.access, password)) {
      throw new HttpError(
        403,
        "Private character password is required to export this character publicly"
      );
    }

    return {
      schemaVersion: 1,
      format: "character-card",
      visibility: "public",
      cardId: character.cardId,
      exportedAt: new Date().toISOString(),
      character: {
        name: character.name,
        avatar: character.avatar,
        description: character.description,
        tags,
        ...promptFields,
        openingHtml,
        quickReplies
      }
    };
  }

  if (!password) {
    throw new HttpError(400, "Private export password is required");
  }

  if (existingPrivateRecord) {
    assertPrivateCharacterPassword(existingPrivateRecord.access, password, {
      missingMessage: "Private export password is required",
      invalidMessage: "Private character password is invalid"
    });
  }

  const exportAccess = buildPasswordAccessControl(password);
  const salt = toBase64Url(randomBytes(16));
  const encrypted = encryptPayload(toEncryptedPromptPayload(promptFields, exportAccess), exportKey(password, salt));

  return {
    schemaVersion: 1,
    format: "character-card",
    visibility: "private",
    cardId: character.cardId,
    exportedAt: new Date().toISOString(),
    character: {
      name: character.name,
      avatar: character.avatar,
      description: character.description,
      tags,
      openingHtml,
      quickReplies
    },
    protectedPayload: {
      version: 1,
      algorithm: "aes-256-gcm",
      salt,
      ...encrypted,
      accessControl: exportAccess
    }
  };
};

export const canExportCharacterPublicly = (
  character: Pick<Character, "loreEntries">,
  password?: string
): boolean => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    return true;
  }

  const record = character.loreEntries as StoredPrivateCharacterRecord;
  if (record.__privateCharacter.exportSalt && !password) {
    return false;
  }

  return canViewPrivateCharacter(decryptStoredPromptFields(character.loreEntries, password).access, password);
};

export const assertCharacterUnlockPassword = (
  character: Pick<Character, "loreEntries">,
  password: string
) => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    throw new HttpError(400, "Character is not private");
  }

  const { access } = decryptStoredPromptFields(character.loreEntries, password);
  assertPrivateCharacterPassword(access, password, {
    missingMessage: "Private character password is required",
    invalidMessage: "Private character password is invalid"
  });
};

export const importCharacterCard = (
  source: CharacterImportSource
): {
  name: string;
  avatar: string | null;
  description: string;
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  openingHtml: string;
  cardId: string;
  loreEntries: Prisma.InputJsonValue;
  quickReplies: Prisma.InputJsonValue;
  tags: Prisma.InputJsonValue;
} => {
  if (source.visibility === "public") {
    return {
      name: source.character.name,
      cardId: source.cardId,
      avatar: source.character.avatar ?? null,
      description: source.character.description ?? "",
      tags: source.character.tags ?? [],
      prefix: source.character.prefix,
      prompt: source.character.prompt,
      suffix: source.character.suffix,
      htmlCss: source.character.htmlCss,
      openingHtml: source.character.openingHtml ?? "",
      loreEntries: source.character.loreEntries,
      quickReplies: source.character.quickReplies ?? []
    };
  }

  const { protectedPayload } = source;

  return {
    name: source.character.name,
    cardId: source.cardId,
    avatar: source.character.avatar ?? null,
    description: source.character.description ?? "",
    tags: source.character.tags ?? [],
    prefix: "",
    prompt: "",
    suffix: "",
    htmlCss: "",
    openingHtml: source.character.openingHtml ?? "",
    loreEntries: {
      __privateCharacter: {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: protectedPayload.iv,
        tag: protectedPayload.tag,
        ciphertext: protectedPayload.ciphertext,
        accessControl: protectedPayload.accessControl,
        exportSalt: protectedPayload.salt
      }
    } satisfies StoredPrivateCharacterRecord,
    quickReplies: source.character.quickReplies ?? []
  };
};

export const buildCharacterUpdateData = (
  character: Pick<Character, "name" | "avatar" | "description" | "prefix" | "prompt" | "suffix" | "htmlCss" | "loreEntries">,
  updates: {
    name?: string;
    avatar?: string | null;
    description?: string;
    prefix?: string;
    prompt?: string;
    suffix?: string;
    htmlCss?: string;
    openingHtml?: string;
    tags?: Prisma.InputJsonValue;
    loreEntries?: Prisma.InputJsonValue;
    quickReplies?: Prisma.InputJsonValue;
    isFavorite?: boolean;
  },
  password?: string
): Prisma.CharacterUpdateInput => {
  if (!isStoredPrivateCharacterRecord(character.loreEntries)) {
    return {
      ...updates,
      loreEntries: updates.loreEntries
    };
  }

  const hasPrivateUpdates =
    updates.prefix !== undefined ||
    updates.prompt !== undefined ||
    updates.suffix !== undefined ||
    updates.htmlCss !== undefined ||
    updates.loreEntries !== undefined;

  if (!hasPrivateUpdates) {
    return {
      name: updates.name,
      avatar: "avatar" in updates ? updates.avatar : undefined,
      description: "description" in updates ? updates.description : undefined,
      tags: updates.tags,
      isFavorite: updates.isFavorite,
      openingHtml: updates.openingHtml,
      quickReplies: updates.quickReplies
    };
  }

  const { access, fields } = decryptStoredPromptFields(character.loreEntries, password);
  assertPrivateCharacterPassword(access, password, {
    missingMessage: "Private character password is required to update prompt content",
    invalidMessage: "Private character password is invalid"
  });

  const nextFields: CharacterPromptFields = {
    prefix: updates.prefix ?? fields.prefix,
    prompt: updates.prompt ?? fields.prompt,
    suffix: updates.suffix ?? fields.suffix,
    htmlCss: updates.htmlCss ?? fields.htmlCss,
    loreEntries:
      updates.loreEntries !== undefined ? toCharacterLoreEntries(updates.loreEntries) : fields.loreEntries
  };

  return {
    name: updates.name,
    avatar: "avatar" in updates ? updates.avatar : undefined,
    description: "description" in updates ? updates.description : undefined,
    tags: updates.tags,
    isFavorite: updates.isFavorite,
    openingHtml: updates.openingHtml,
    prefix: "",
    prompt: "",
    suffix: "",
    htmlCss: "",
    loreEntries: buildStoredPrivateCharacterJson(nextFields, access),
    quickReplies: updates.quickReplies
  };
};

export const buildCharacterDuplicateData = (
  character: Character,
  name: string
): Prisma.CharacterCreateInput => ({
  name,
  avatar: character.avatar,
  description: character.description,
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  htmlCss: character.htmlCss,
  openingHtml: character.openingHtml,
  tags: character.tags as Prisma.InputJsonValue,
  loreEntries: character.loreEntries as Prisma.InputJsonValue,
  quickReplies: character.quickReplies as Prisma.InputJsonValue,
  isFavorite: false
});
