import { create } from "zustand";
import type { AppearancePreferencesDTO } from "@local-roleplay/shared";
import type { AppLanguage, AppSection, ReadinessDTO } from "../types";
import { api } from "../lib/api";
import { applyAppearancePreferences, readAppearanceMirror } from "../lib/appearance";

const getInitialLanguage = (): AppLanguage => {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  const stored = window.localStorage.getItem("app-language");
  if (stored === "zh-CN" || stored === "en") {
    return stored;
  }

  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
};

interface AppState {
  activeSection: AppSection;
  language: AppLanguage;
  showMessageAvatars: boolean;
  showMessageTimestamps: boolean;
  appearancePreferences: AppearancePreferencesDTO;
  isPrivacyLocked: boolean;
  readiness: ReadinessDTO | null;
  readinessLoading: boolean;
  setActiveSection: (section: AppSection) => void;
  setLanguage: (language: AppLanguage) => void;
  setShowMessageAvatars: (showMessageAvatars: boolean) => void;
  setShowMessageTimestamps: (showMessageTimestamps: boolean) => void;
  setAppearancePreferences: (appearancePreferences: AppearancePreferencesDTO) => void;
  setPrivacyLocked: (locked: boolean) => void;
  refreshReadiness: () => Promise<ReadinessDTO>;
  lockPrivacy: (passcode: string) => Promise<boolean>;
  unlockPrivacy: (passcode: string) => Promise<boolean>;
}

export const useAppStore = create<AppState>((set) => ({
  activeSection: "chat",
  language: getInitialLanguage(),
  showMessageAvatars: true,
  showMessageTimestamps: false,
  appearancePreferences: readAppearanceMirror(),
  isPrivacyLocked: false,
  readiness: null,
  readinessLoading: false,
  setActiveSection: (activeSection) => set({ activeSection }),
  setLanguage: (language) => {
    window.localStorage.setItem("app-language", language);
    document.documentElement.lang = language;
    set({ language });
  },
  setShowMessageAvatars: (showMessageAvatars) => set({ showMessageAvatars }),
  setShowMessageTimestamps: (showMessageTimestamps) => set({ showMessageTimestamps }),
  setAppearancePreferences: (value) => {
    const appearancePreferences = applyAppearancePreferences(value);
    set({ appearancePreferences });
  },
  setPrivacyLocked: (isPrivacyLocked) => set({ isPrivacyLocked, ...(isPrivacyLocked ? { readiness: null } : {}) }),
  refreshReadiness: async () => {
    set({ readinessLoading: true });
    try {
      const readiness = await api.readiness.get();
      set({ readiness, readinessLoading: false });
      return readiness;
    } catch {
      const { createUnavailableReadiness } = await import("../lib/unavailableReadiness");
      const readiness = createUnavailableReadiness();
      set({ readiness, readinessLoading: false });
      return readiness;
    }
  },
  lockPrivacy: async (passcode) => {
    if (passcode.length < 4 || passcode.length > 128) return false;
    try { await api.privacy.lock(passcode); set({ isPrivacyLocked: true }); return true; } catch { return false; }
  },
  unlockPrivacy: async (passcode) => {
    try { await api.privacy.unlock(passcode); set({ isPrivacyLocked: false }); return true; } catch { return false; }
  }
}));
