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

export function App() {
  const { activeSection, setActiveSection, setLanguage } = useAppStore();
  const { t } = useI18n();
  const active = sectionMeta[activeSection];

  useEffect(() => {
    const syncFromHash = () => {
      const next = window.location.hash.replace(/^#\/?/, "");
      if (isSection(next)) {
        setActiveSection(next);
      }
    };

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
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
    window.location.hash = section;
  };

  return (
    <div className="min-h-screen bg-ink-950 text-slate-100 selection:bg-ember-500/30">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col lg:flex-row">
        <aside className="border-b border-white/5 bg-ink-900/50 backdrop-blur-xl p-5 lg:sticky lg:top-0 lg:h-screen lg:w-72 lg:border-b-0 lg:border-r lg:flex lg:flex-col">
          <div className="flex items-center gap-4 lg:mb-8">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-lg shadow-ember-500/20">
              <Sparkles size={24} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold tracking-tight text-white">{APP_NAME}</h1>
              <p className="text-sm text-slate-400 font-medium">{t("app.tagline")}</p>
            </div>
          </div>

          <nav className="mt-6 lg:mt-0 grid grid-cols-4 gap-2 lg:grid-cols-1 lg:flex-1 lg:gap-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = activeSection === item.id;

              return (
                <button
                  className={`group flex min-h-[44px] items-center justify-center gap-3 rounded-xl px-4 text-sm font-medium transition-all duration-200 lg:justify-start ${
                    selected
                      ? "bg-ember-500 text-ink-950 shadow-md shadow-ember-500/20"
                      : "bg-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={18} className={selected ? "text-ink-950" : "text-slate-400 group-hover:text-slate-200 transition-colors"} />
                  <span className="hidden lg:inline">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="flex-1 overflow-x-hidden">
          <header className="border-b border-white/5 bg-ink-950/80 backdrop-blur-md sticky top-0 z-10 px-6 py-5 lg:px-10">
            <h2 className="text-xl font-bold tracking-tight text-slate-100">{t(active.titleKey)}</h2>
            <p className="mt-1 text-sm text-slate-400">{t(active.subtitleKey)}</p>
          </header>
          <div className="p-6 lg:p-10 animate-fade-in">
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
