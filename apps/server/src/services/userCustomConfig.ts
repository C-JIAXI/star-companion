type UserCustomConfig = {
  prefix: string;
  prompt: string;
  suffix: string;
};

type UserCustomConfigEnvelope = UserCustomConfig & {
  type: "user-custom-config";
  version: 1;
};

const emptyUserCustomConfig = (): UserCustomConfig => ({
  prefix: "",
  prompt: "",
  suffix: ""
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUserCustomConfigEnvelope = (value: unknown): value is UserCustomConfigEnvelope =>
  isRecord(value) &&
  value.type === "user-custom-config" &&
  value.version === 1 &&
  typeof value.prefix === "string" &&
  typeof value.prompt === "string" &&
  typeof value.suffix === "string";

const normalizeUserCustomConfig = (value?: Partial<UserCustomConfig> | null): UserCustomConfig => ({
  prefix: value?.prefix ?? "",
  prompt: value?.prompt ?? "",
  suffix: value?.suffix ?? ""
});

export const parseUserCustomConfig = (value?: string | null): UserCustomConfig => {
  const raw = value ?? "";

  if (!raw.trim()) {
    return emptyUserCustomConfig();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isUserCustomConfigEnvelope(parsed)) {
      return normalizeUserCustomConfig(parsed);
    }
  } catch {
    // Legacy free-form userPersona text falls through to prompt body.
  }

  return {
    prefix: "",
    prompt: raw,
    suffix: ""
  };
};

export const serializeUserCustomConfig = (value?: Partial<UserCustomConfig> | null) => {
  const normalized = normalizeUserCustomConfig(value);

  if (!normalized.prefix.trim() && !normalized.prompt.trim() && !normalized.suffix.trim()) {
    return "";
  }

  return JSON.stringify({
    type: "user-custom-config",
    version: 1,
    ...normalized
  } satisfies UserCustomConfigEnvelope);
};

export const getUserCustomConfigSegments = (value?: string | null) => {
  const config = parseUserCustomConfig(value);
  return [config.prefix.trim(), config.prompt.trim(), config.suffix.trim()].filter(Boolean);
};
