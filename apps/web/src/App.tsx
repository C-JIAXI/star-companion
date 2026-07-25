import { Menu, MessageSquarePlus, MessageSquareText, Plus, Settings, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import { useI18n, type TranslationKey } from "./i18n";
import { ChatPage } from "./pages/ChatPage";
import { CharactersPage } from "./pages/CharactersPage";
import { DocsPage } from "./pages/DocsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ChatHistoryList } from "./components/ChatHistoryList";
import { NewChatDialog } from "./components/NewChatDialog";
import { ConfirmDialog, Drawer, ErrorNotice } from "./components/ui";
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

const SELECTED_CHAT_STORAGE_KEY = "star-companion:selected-chat";

const getStoredSelectedChatId = () => {
  try {
    const chatId = window.localStorage.getItem(SELECTED_CHAT_STORAGE_KEY)?.trim();
    return chatId || null;
  } catch {
    return null;
  }
};

const storeSelectedChatId = (chatId: string | null) => {
  try {
    if (chatId) {
      window.localStorage.setItem(SELECTED_CHAT_STORAGE_KEY, chatId);
    } else {
      window.localStorage.removeItem(SELECTED_CHAT_STORAGE_KEY);
    }
  } catch {
    // Selection persistence is best-effort when browser storage is unavailable.
  }
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
  const appName = t("app.name");
  const active = sectionMeta[activeSection];
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [showNewChatDialog, setShowNewChatDialog] = useState(false);
  const [chatCreationError, setChatCreationError] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<AppSection | null>(null);

  useMobileViewport();

  useEffect(() => {
    document.title = `${t(active.titleKey)} | ${appName}`;
  }, [active.titleKey, appName, t]);

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
        useAppStore.getState().setShowMessageTimestamps(settings.showMessageTimestamps);
      })
      .catch(() => {
        document.documentElement.lang = useAppStore.getState().language;
      });
  }, [setLanguage, setShowMessageAvatars]);

  const navigate = useCallback(
    (section: AppSection) => {
      if (activeSection === "settings" && section !== "settings" && settingsDirty) {
        setPendingNavigation(section);
        return;
      }
      setActiveSection(section);
      setShowMobileNav(false);
      window.history.pushState({}, "", sectionPaths[section]);
    },
    [activeSection, setActiveSection, settingsDirty]
  );

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

  const [selectedChatId, setSelectedChatId] = useState<string | null>(getStoredSelectedChatId);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);

  const handleSelectChat = useCallback(
    (id: string | null) => {
      setSelectedChatId(id);
      storeSelectedChatId(id);
      setShowMobileNav(false);
      if (id && activeSection !== "chat") {
        navigate("chat");
      }
    },
    [activeSection, navigate]
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

  const createChatForCharacter = useCallback(
    async (characterId: string) => {
      const chat = await api.chats.create({
        title: "New Chat",
        characterId
      });
      setSelectedChatId(chat.id);
      storeSelectedChatId(chat.id);
      setChatRefreshKey((current) => current + 1);
      navigate("chat");
    },
    [navigate]
  );

  const handlePlay = useCallback(
    async (characterId: string) => {
      setChatCreationError(null);
      try {
        await createChatForCharacter(characterId);
      } catch (caught) {
        setChatCreationError(caught instanceof Error ? caught.message : t("chat.failedCreate"));
      }
    },
    [createChatForCharacter, t]
  );

  return (
    <div className="h-dvh bg-ink-950 text-ink-50 selection:bg-ember-400/25 safe-area-top safe-area-bottom transition-[height] duration-200">
      <ErrorNotice message={chatCreationError} />
      <Drawer
        open={showMobileNav}
        onClose={() => setShowMobileNav(false)}
        title={
          <span className="flex items-center gap-2">
            <img className="h-9 w-9 shrink-0 rounded-md object-cover" src="/app-logo-v2.png" alt="" />
            <span>{appName}</span>
          </span>
        }
      >
        <div className="flex h-full flex-col gap-4" data-testid="mobile-nav-content">
          <div>
            <p className="text-xs font-medium text-slate-400">{t("app.tagline")}</p>
            <nav className="mt-4 flex flex-col gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const selected = isNavItemSelected(item.id);

                return (
                  <button
                    className={`group flex min-h-[44px] items-center gap-3 rounded-md border px-3 text-sm font-medium transition-colors ${
                      selected
                        ? "border-ember-400/20 bg-ember-500/10 text-ember-100"
                        : "border-transparent text-ink-300 hover:bg-white/[0.045] hover:text-ink-50"
                    }`}
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={18} className={selected ? "text-ember-300" : "text-ink-400"} />
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </nav>
            <button
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-ember-400/20 bg-ember-500 px-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-ember-400"
              data-testid="new-chat-trigger-drawer"
              type="button"
              onClick={() => {
                setShowMobileNav(false);
                setShowNewChatDialog(true);
              }}
            >
              <MessageSquarePlus size={17} />
              {t("chat.newChat")}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.08] pt-4">
            <ChatHistoryList
              selectedChatId={selectedChatId}
              onSelectChat={handleSelectChat}
              onOpenDocs={() => navigate("docs")}
              refreshKey={chatRefreshKey}
            />
          </div>
        </div>
      </Drawer>

      <div className="flex h-full min-w-0 flex-col lg:flex-row">
        <aside
          className="hidden lg:sticky lg:top-0 lg:flex lg:h-full lg:w-60 lg:flex-col lg:border-r lg:border-white/[0.08] lg:bg-ink-900"
          data-testid="desktop-sidebar"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-5">
            <div className="flex items-center gap-3 min-w-0">
              <img
                className="h-10 w-10 shrink-0 rounded-md object-cover ring-1 ring-white/10"
                src="/app-logo-v2.png"
                alt=""
              />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-ink-50">{appName}</h1>
                <p className="truncate text-xs text-ink-400">{t("app.tagline")}</p>
              </div>
            </div>
          </div>

          <nav className="flex shrink-0 flex-col gap-1 px-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = isNavItemSelected(item.id);

              return (
                <button
                  className={`group flex min-h-10 items-center gap-2.5 rounded-md border px-3 text-sm font-medium transition-colors ${
                    selected
                      ? "border-ember-400/20 bg-ember-500/10 text-ember-100"
                      : "border-transparent bg-transparent text-ink-300 hover:bg-white/[0.045] hover:text-ink-50"
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
                        : "text-ink-400 transition-colors group-hover:text-ink-200"
                    }
                  />
                  <span>{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>

          <button
            className="mx-3 mt-3 flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-ember-400/20 bg-ember-500 px-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-ember-400"
            data-testid="new-chat-trigger-desktop"
            type="button"
            onClick={() => setShowNewChatDialog(true)}
          >
            <MessageSquarePlus size={16} />
            {t("chat.newChat")}
          </button>

          <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-white/[0.08] px-3 pt-4">
            <ChatHistoryList
              selectedChatId={selectedChatId}
              onSelectChat={handleSelectChat}
              onOpenDocs={() => navigate("docs")}
              refreshKey={chatRefreshKey}
            />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-white/[0.08] bg-ink-950/95 px-3 py-2.5 backdrop-blur-md safe-area-top sm:px-4 lg:hidden">
            <button
              className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
              type="button"
              aria-label="Toggle navigation"
              onClick={() => setShowMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <img
                className="h-9 w-9 shrink-0 rounded-md object-cover ring-1 ring-white/10"
                src="/app-logo-v2.png"
                alt=""
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-ink-400">
                  {appName}
                </p>
                <h2 className="truncate text-sm font-semibold text-ink-50">
                  {t(active.titleKey)}
                </h2>
              </div>
            </div>
            {activeSection === "chat" ? (
              <button
                aria-label={t("chat.newChat")}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
                data-testid="new-chat-trigger-mobile"
                title={t("chat.newChat")}
                type="button"
                onClick={() => setShowNewChatDialog(true)}
              >
                <Plus size={20} />
              </button>
            ) : (
              <div className="w-10 sm:w-11" />
            )}
          </header>
          <header className="sticky top-0 z-20 hidden shrink-0 border-b border-white/[0.08] bg-ink-950/90 px-6 py-4 backdrop-blur-md lg:block lg:px-8">
            <div>
              <h2 className="text-lg font-semibold text-ink-50">
                {t(active.titleKey)}
              </h2>
              <p className="mt-0.5 text-sm leading-5 text-ink-400">{t(active.subtitleKey)}</p>
            </div>
          </header>
          <div className="animate-fade-in min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-5 lg:p-6 xl:p-8">
            {activeSection === "chat" ? (
              <ChatPage
                selectedChatId={selectedChatId}
                onChatsChanged={triggerChatRefresh}
                onNewChat={() => setShowNewChatDialog(true)}
                onSelectChat={handleSelectChat}
              />
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
      <NewChatDialog
        open={showNewChatDialog}
        onClose={() => setShowNewChatDialog(false)}
        onCreate={createChatForCharacter}
        onOpenCharacters={() => {
          setShowNewChatDialog(false);
          navigate("characters");
        }}
      />
    </div>
  );
}
