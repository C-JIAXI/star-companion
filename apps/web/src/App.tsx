import { BookOpen, MessageSquareText, Settings, Sparkles, Users } from "lucide-react";
import { useEffect } from "react";
import { APP_NAME } from "@local-roleplay/shared";
import { api } from "./lib/api";
import { useI18n, type TranslationKey } from "./i18n";
import { ChatPage } from "./pages/ChatPage";
import { CharactersPage } from "./pages/CharactersPage";
import { LorePage } from "./pages/LorePage";
import { SettingsPage } from "./pages/SettingsPage";
import { useAppStore } from "./store/useAppStore";
import type { AppSection } from "./types";

const navItems = [
  { id: "chat", labelKey: "nav.chat", icon: MessageSquareText },
  { id: "characters", labelKey: "nav.characters", icon: Users },
  { id: "lore", labelKey: "nav.lore", icon: BookOpen },
  { id: "settings", labelKey: "nav.settings", icon: Settings }
] as const;

const sectionMeta = {
  chat: {
    titleKey: "section.chat.title",
    subtitleKey: "section.chat.subtitle"
  },
  characters: {
    titleKey: "section.characters.title",
    subtitleKey: "section.characters.subtitle"
  },
  lore: {
    titleKey: "section.lore.title",
    subtitleKey: "section.lore.subtitle"
  },
  settings: {
    titleKey: "section.settings.title",
    subtitleKey: "section.settings.subtitle"
  }
} satisfies Record<AppSection, { titleKey: TranslationKey; subtitleKey: TranslationKey }>;

const isSection = (value: string): value is AppSection =>
  value === "chat" || value === "characters" || value === "lore" || value === "settings";

const sectionPaths: Record<AppSection, string> = {
  chat: "/",
  characters: "/characters",
  lore: "/lore",
  settings: "/settings"
};

const sectionFromLocation = () => {
  const hashSection = window.location.hash.replace(/^#\/?/, "");
  if (isSection(hashSection)) {
    return hashSection;
  }

  const [pathSection = ""] = window.location.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (!pathSection) {
    return "chat";
  }

  return isSection(pathSection) ? pathSection : null;
};

export function App() {
  const { activeSection, setActiveSection, setLanguage } = useAppStore();
  const { t } = useI18n();
  const active = sectionMeta[activeSection];

  useEffect(() => {
    const syncFromLocation = () => {
      const next = sectionFromLocation();
      if (next) {
        setActiveSection(next);
      }
    };

    syncFromLocation();
    window.addEventListener("hashchange", syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, [setActiveSection]);

  useEffect(() => {
    document.documentElement.lang = useAppStore.getState().language;
    void api.settings
      .get()
      .then((settings) => setLanguage(settings.language))
      .catch(() => {
        document.documentElement.lang = useAppStore.getState().language;
      });
  }, [setLanguage]);

  const navigate = (section: AppSection) => {
    setActiveSection(section);
    window.history.pushState({}, "", sectionPaths[section]);
  };

  return (
    <div className="min-h-screen bg-ink-950 text-slate-100 selection:bg-ember-500/30">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col lg:flex-row">
        <aside className="border-b border-white/5 bg-ink-900/50 p-3 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-56 lg:flex-col lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3 lg:mb-6">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-md shadow-ember-500/20">
              <Sparkles size={18} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold tracking-tight text-white">{APP_NAME}</h1>
              <p className="truncate text-xs font-medium text-slate-400">{t("app.tagline")}</p>
            </div>
          </div>

          <nav className="mt-4 grid grid-cols-4 gap-2 lg:mt-0 lg:flex lg:flex-col lg:gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = activeSection === item.id;

              return (
                <button
                  className={`group flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-all duration-200 lg:justify-start ${
                    selected
                      ? "bg-ember-500/15 text-ember-100 ring-1 ring-ember-500/30"
                      : "bg-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={18} className={selected ? "text-ember-300" : "text-slate-400 group-hover:text-slate-200 transition-colors"} />
                  <span className="hidden lg:inline">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-x-hidden">
          <header className="sticky top-0 z-10 border-b border-white/5 bg-ink-950/80 px-4 py-4 backdrop-blur-md lg:px-6">
            <h2 className="text-xl font-bold tracking-tight text-slate-100">{t(active.titleKey)}</h2>
            <p className="mt-1 text-sm text-slate-400">{t(active.subtitleKey)}</p>
          </header>
          <div className="animate-fade-in p-4 lg:p-6">
            {activeSection === "chat" ? <ChatPage /> : null}
            {activeSection === "characters" ? <CharactersPage /> : null}
            {activeSection === "lore" ? <LorePage /> : null}
            {activeSection === "settings" ? <SettingsPage /> : null}
          </div>
        </main>
      </div>
    </div>
  );
}
