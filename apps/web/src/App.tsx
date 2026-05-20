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
    <div className="min-h-screen bg-ink-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col lg:flex-row">
        <aside className="border-b border-white/10 bg-ink-900/95 p-4 lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-ember-500 text-ink-950">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{APP_NAME}</h1>
              <p className="text-xs text-slate-400">{t("app.tagline")}</p>
            </div>
          </div>

          <nav className="mt-6 grid grid-cols-4 gap-2 lg:grid-cols-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = activeSection === item.id;

              return (
                <button
                  className={`flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm transition lg:justify-start ${
                    selected
                      ? "bg-ember-500 text-ink-950"
                      : "bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={18} />
                  <span className="hidden sm:inline">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="border-b border-white/10 bg-ink-900/70 px-5 py-4">
            <h2 className="text-2xl font-semibold">{t(active.titleKey)}</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">{t(active.subtitleKey)}</p>
          </header>

          <section className="p-4">
            {activeSection === "chat" ? <ChatPage /> : null}
            {activeSection === "characters" ? <CharactersPage /> : null}
            {activeSection === "lore" ? <LorePage /> : null}
            {activeSection === "settings" ? <SettingsPage /> : null}
          </section>
        </main>
      </div>
    </div>
  );
}
