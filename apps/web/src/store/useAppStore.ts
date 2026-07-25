import { create } from "zustand";
import type { AppLanguage, AppSection } from "../types";

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
  setActiveSection: (section: AppSection) => void;
  setLanguage: (language: AppLanguage) => void;
  setShowMessageAvatars: (showMessageAvatars: boolean) => void;
  setShowMessageTimestamps: (showMessageTimestamps: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeSection: "chat",
  language: getInitialLanguage(),
  showMessageAvatars: true,
  showMessageTimestamps: false,
  setActiveSection: (activeSection) => set({ activeSection }),
  setLanguage: (language) => {
    window.localStorage.setItem("app-language", language);
    document.documentElement.lang = language;
    set({ language });
  },
  setShowMessageAvatars: (showMessageAvatars) => set({ showMessageAvatars }),
  setShowMessageTimestamps: (showMessageTimestamps) => set({ showMessageTimestamps })
}));
