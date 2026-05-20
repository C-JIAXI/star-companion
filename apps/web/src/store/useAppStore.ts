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
  setActiveSection: (section: AppSection) => void;
  setLanguage: (language: AppLanguage) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeSection: "chat",
  language: getInitialLanguage(),
  setActiveSection: (activeSection) => set({ activeSection }),
  setLanguage: (language) => {
    window.localStorage.setItem("app-language", language);
    document.documentElement.lang = language;
    set({ language });
  }
}));
