import { Menu, MessageSquareText, Settings, Sparkles, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { APP_NAME } from "@local-roleplay/shared";
import { api } from "./lib/api";
import { useI18n, type TranslationKey } from "./i18n";
import { ChatPage } from "./pages/ChatPage";
import { CharactersPage } from "./pages/CharactersPage";
import { DocsPage } from "./pages/DocsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ChatHistoryList } from "./components/ChatHistoryList";
import { ConfirmDialog, Drawer } from "./components/ui";
import { useAppStore } from "./store/useAppStore";
import { useMobileViewport } from "./lib/useMobileViewport";
import type { AppSection } from "./types";

const navItems = [
  { id: "chat", labelKey: "nav.chat", icon: MessageSquareText },
  { id: "characters", labelKey: "nav.characters", icon: Users },
  { id: "settings", labelKey: "nav.settings", icon: Settings }
] as const;

const sectionMeta = {
  chat: {
    titleKey: "section.chat.title",
    subtitleKey: "section.chat.subtitle"
  },
  docs: {
    titleKey: "section.docs.title",
    subtitleKey: "section.docs.subtitle"
  },
  characters: {
    titleKey: "section.characters.title",
    subtitleKey: "section.characters.subtitle"
  },
  settings: {
    titleKey: "section.settings.title",
    subtitleKey: "section.settings.subtitle"
  }
} satisfies Record<AppSection, { titleKey: TranslationKey; subtitleKey: TranslationKey }>;

const isSection = (value: string): value is AppSection =>
  value === "chat" || value === "docs" || value === "characters" || value === "settings";

const sectionPaths: Record<AppSection, string> = {
  chat: "/",
  docs: "/docs",
  characters: "/characters",
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
  const { activeSection, setActiveSection, setLanguage, setShowMessageAvatars } = useAppStore();
  const { language, t } = useI18n();
  const active = sectionMeta[activeSection];
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<AppSection | null>(null);

  useMobileViewport();

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
      .then((settings) => {
        setLanguage(settings.language);
        setShowMessageAvatars(settings.showMessageAvatars);
      })
      .catch(() => {
        document.documentElement.lang = useAppStore.getState().language;
      });
  }, [setLanguage, setShowMessageAvatars]);

  const navigate = (section: AppSection) => {
    if (activeSection === "settings" && section !== "settings" && settingsDirty) {
      setPendingNavigation(section);
      return;
    }
    setActiveSection(section);
    setShowMobileNav(false);
    window.history.pushState({}, "", sectionPaths[section]);
  };

  const confirmNavigation = () => {
    if (pendingNavigation) {
      setActiveSection(pendingNavigation);
      setShowMobileNav(false);
      window.history.pushState({}, "", sectionPaths[pendingNavigation]);
      setPendingNavigation(null);
    }
  };

  const cancelNavigation = () => {
    setPendingNavigation(null);
  };

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);

  const handleSelectChat = useCallback(
    (id: string | null) => {
      setSelectedChatId(id);
      setShowMobileNav(false);
      if (id && activeSection !== "chat") {
        navigate("chat");
      }
    },
    [activeSection]
  );

  const triggerChatRefresh = useCallback(() => {
    setChatRefreshKey((current) => current + 1);
  }, []);

  const isNavItemSelected = useCallback(
    (section: (typeof navItems)[number]["id"]) =>
      section === "chat"
        ? activeSection === "chat" || activeSection === "docs"
        : activeSection === section,
    [activeSection]
  );

  const handlePlay = useCallback(async (characterId: string) => {
    try {
      const chat = await api.chats.create({
        title: "New Chat",
        characterId
      });
      setSelectedChatId(chat.id);
      setChatRefreshKey((current) => current + 1);
      navigate("chat");
    } catch {}
  }, []);

  return (
    <div className="h-dvh bg-ink-950 text-slate-100 selection:bg-ember-500/30 safe-area-top safe-area-bottom transition-[height] duration-200">
      <Drawer
        open={showMobileNav}
        onClose={() => setShowMobileNav(false)}
        title={
          <span className="flex items-center gap-2">
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-md shadow-ember-500/20">
              <Sparkles size={14} />
            </div>
            <span>{APP_NAME}</span>
          </span>
        }
      >
        <div className="flex h-full flex-col gap-4">
          <div>
            <p className="text-xs font-medium text-slate-400">{t("app.tagline")}</p>
            <nav className="mt-4 flex flex-col gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const selected = isNavItemSelected(item.id);

                return (
                  <button
                    className={`group flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-medium transition-all duration-200 sm:min-h-[48px] ${
                      selected
                        ? "bg-ember-500/15 text-ember-100 ring-1 ring-ember-500/30"
                        : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    }`}
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={18} className={selected ? "text-ember-300" : "text-slate-400"} />
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </nav>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/5 pt-4">
            <ChatHistoryList
              selectedChatId={selectedChatId}
              onSelectChat={handleSelectChat}
              onOpenDocs={() => navigate("docs")}
              refreshKey={chatRefreshKey}
            />
          </div>
        </div>
      </Drawer>

      <div className="mx-auto flex h-full max-w-[1600px] flex-col lg:flex-row">
        <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-full lg:w-56 lg:flex-col lg:border-r lg:border-white/5 lg:bg-ink-900/50 lg:backdrop-blur-xl">
          <div className="flex shrink-0 items-center justify-between gap-3 p-3 lg:mb-6 lg:pb-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-md shadow-ember-500/20">
                <Sparkles size={18} />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-bold tracking-tight text-white">{APP_NAME}</h1>
                <p className="truncate text-xs font-medium text-slate-400">{t("app.tagline")}</p>
              </div>
            </div>
          </div>

          <nav className="shrink-0 px-3 flex flex-col gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = isNavItemSelected(item.id);

              return (
                <button
                  className={`group flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-sm font-medium transition-all duration-200 sm:min-h-[44px] ${
                    selected
                      ? "bg-ember-500/15 text-ember-100 ring-1 ring-ember-500/30"
                      : "bg-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                >
                  <Icon
                    size={18}
                    className={
                      selected
                        ? "text-ember-300"
                        : "text-slate-400 group-hover:text-slate-200 transition-colors"
                    }
                  />
                  <span>{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 flex-col overflow-y-auto border-t border-white/5 px-3 pt-4 mt-4 flex">
            <ChatHistoryList
              selectedChatId={selectedChatId}
              onSelectChat={handleSelectChat}
              onOpenDocs={() => navigate("docs")}
              refreshKey={chatRefreshKey}
            />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden">
          <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between gap-2 bg-ink-950/95 px-3 py-2 backdrop-blur-md safe-area-top sm:px-4 sm:py-3">
            <button
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200 sm:h-11 sm:w-11"
              type="button"
              aria-label="Toggle navigation"
              onClick={() => setShowMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-md shadow-ember-500/20 sm:h-8 sm:w-8">
                <Sparkles size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  {APP_NAME}
                </p>
                <h2 className="truncate text-sm font-semibold tracking-tight text-white">
                  {t(active.titleKey)}
                </h2>
              </div>
            </div>
            {activeSection !== "chat" ? null : <div className="w-10 sm:w-11" />}
          </header>
          <header className="hidden lg:block sticky top-0 z-10 bg-ink-950/80 px-4 pt-4 backdrop-blur-md lg:px-6">
            <div className="rounded-xl border border-white/5 bg-ink-900/80 px-4 py-3 shadow-lg shadow-black/20 backdrop-blur-sm">
              <h2 className="text-xl font-bold tracking-tight text-slate-100">
                {t(active.titleKey)}
              </h2>
              <p className="mt-1 text-sm leading-5 text-slate-400">{t(active.subtitleKey)}</p>
            </div>
          </header>
          <div className="animate-fade-in flex-1 min-h-0 overflow-x-hidden overflow-y-auto p-2 sm:p-4 lg:p-6">
            {activeSection === "chat" ? (
              <ChatPage selectedChatId={selectedChatId} onChatsChanged={triggerChatRefresh} />
            ) : null}
            {activeSection === "docs" ? <DocsPage /> : null}
            {activeSection === "characters" ? (
              <CharactersPage onPlay={(characterId) => void handlePlay(characterId)} />
            ) : null}
            {activeSection === "settings" ? (
              <SettingsPage onDirtyChange={setSettingsDirty} />
            ) : null}
          </div>
        </main>
      </div>
      {pendingNavigation ? (
        <ConfirmDialog
          title={
            language === "zh-CN" ? "未保存的更改" : "Unsaved Changes"
          }
          message={
            language === "zh-CN"
              ? "当前设置有未保存的更改，离开将丢失修改。确定离开吗？"
              : "You have unsaved settings changes. Leaving will discard them. Are you sure?"
          }
          confirmLabel={language === "zh-CN" ? "确定离开" : "Leave"}
          cancelLabel={language === "zh-CN" ? "取消" : "Cancel"}
          variant="danger"
          onCancel={cancelNavigation}
          onConfirm={confirmNavigation}
        />
      ) : null}
    </div>
  );
}
