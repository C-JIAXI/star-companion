type UserCustomConfig = {
  displayName: string;
  prefix: string;
  prompt: string;
  suffix: string;
};

const emptyUserCustomConfig = (): UserCustomConfig => ({
  displayName: "",
  prefix: "",
  prompt: "",
  suffix: ""
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUserCustomConfigEnvelope = (value: unknown) =>
  isRecord(value) &&
  value.type === "user-custom-config" &&
  (value.version === 1 || value.version === 2) &&
  typeof value.prefix === "string" &&
  typeof value.prompt === "string" &&
  typeof value.suffix === "string" &&
  (value.version === 1 || typeof value.displayName === "string");

const normalizeUserCustomConfig = (
  value?: Partial<UserCustomConfig> | null
): UserCustomConfig => ({
  displayName: value?.displayName ?? "",
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
      return normalizeUserCustomConfig(parsed as Partial<UserCustomConfig>);
    }
  } catch {}

  return emptyUserCustomConfig();
};

export const serializeUserCustomConfig = (value?: Partial<UserCustomConfig> | null) => {
  const normalized = normalizeUserCustomConfig(value);

  if (
    !normalized.displayName.trim() &&
    !normalized.prefix.trim() &&
    !normalized.prompt.trim() &&
    !normalized.suffix.trim()
  ) {
    return "";
  }

  return JSON.stringify({
    type: "user-custom-config",
    version: 2,
    ...normalized
  });
};

export const getUserCustomConfigSegments = (value?: string | null) => {
  const config = parseUserCustomConfig(value);
  return [config.prefix.trim(), config.prompt.trim(), config.suffix.trim()].filter(Boolean);
};
