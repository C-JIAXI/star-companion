import {
  defaultAppearancePreferences,
  normalizeAppearancePreferences,
  type AppearancePreferencesDTO
} from "@local-roleplay/shared";

export const APPEARANCE_MIRROR_KEY = "star-companion:appearance-v1";

const resolveTheme = (preferences: AppearancePreferencesDTO) =>
  preferences.themeMode === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : preferences.themeMode;

const resolveMotion = (preferences: AppearancePreferencesDTO) =>
  preferences.motion === "system"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full"
    : preferences.motion;

export const readAppearanceMirror = (): AppearancePreferencesDTO => {
  if (typeof window === "undefined") return { ...defaultAppearancePreferences };
  try {
    return normalizeAppearancePreferences(JSON.parse(window.localStorage.getItem(APPEARANCE_MIRROR_KEY) ?? "null"));
  } catch {
    return { ...defaultAppearancePreferences };
  }
};

export const applyAppearancePreferences = (
  value: unknown,
  options: { persistMirror?: boolean } = {}
) => {
  const preferences = normalizeAppearancePreferences(value);
  if (typeof document === "undefined" || typeof window === "undefined") return preferences;

  const root = document.documentElement;
  const theme = resolveTheme(preferences);
  const motion = resolveMotion(preferences);
  Object.assign(root.dataset, {
    themePreference: preferences.themeMode,
    theme,
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    chatWidth: preferences.chatWidth,
    messageSpacing: preferences.messageSpacing,
    contrast: preferences.contrast,
    motionPreference: preferences.motion,
    motion,
    backgroundBlur: preferences.backgroundBlur,
    characterStyle: preferences.characterStyle
  });
  root.style.colorScheme = theme;
  root.style.setProperty("--chat-background-overlay", String(preferences.backgroundOverlay));
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0e0d" : "#f7faf9");

  if (options.persistMirror !== false) {
    try {
      window.localStorage.setItem(APPEARANCE_MIRROR_KEY, JSON.stringify(preferences));
    } catch {
      // The server remains authoritative when browser storage is unavailable.
    }
  }
  return preferences;
};

export const subscribeToSystemAppearance = (getPreferences: () => AppearancePreferencesDTO) => {
  const color = window.matchMedia("(prefers-color-scheme: dark)");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const refresh = () => applyAppearancePreferences(getPreferences(), { persistMirror: false });
  color.addEventListener("change", refresh);
  motion.addEventListener("change", refresh);
  return () => {
    color.removeEventListener("change", refresh);
    motion.removeEventListener("change", refresh);
  };
};
