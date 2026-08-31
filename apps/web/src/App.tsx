import {
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Plus,
  Search,
  Settings,
  Users
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import { useI18n, type TranslationKey } from "./i18n";
import { NewChatDialog } from "./components/NewChatDialog";
import { ConfirmDialog, Drawer, ErrorNotice } from "./components/ui";
import { useAppStore } from "./store/useAppStore";
import { useMobileViewport } from "./lib/useMobileViewport";
import { subscribeToSystemAppearance } from "./lib/appearance";
import type { AppSection } from "./types";

const loadChatPage = () =>
  import("./pages/ChatPage").then((module) => ({ default: module.ChatPage }));
const loadCharactersPage = () =>
  import("./pages/CharactersPage").then((module) => ({ default: module.CharactersPage }));
const loadDocsPage = () =>
  import("./pages/DocsPage").then((module) => ({ default: module.DocsPage }));
const loadSettingsPage = () =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage }));
const OnboardingDialog = lazy(() =>
  import("./components/OnboardingDialog").then((module) => ({ default: module.OnboardingDialog }))
);
const ChatHistoryList = lazy(() =>
  import("./components/ChatHistoryList").then((module) => ({ default: module.ChatHistoryList }))
);

const ChatPage = lazy(loadChatPage);
const CharactersPage = lazy(loadCharactersPage);
const DocsPage = lazy(loadDocsPage);
const SettingsPage = lazy(loadSettingsPage);

const sectionLoaders: Record<AppSection, () => Promise<unknown>> = {
  chat: loadChatPage,
  characters: loadCharactersPage,
  docs: loadDocsPage,
  settings: loadSettingsPage
};

const preloadSection = (section: AppSection) => {
  void sectionLoaders[section]();
};

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
  const { activeSection, setActiveSection, setLanguage, setShowMessageAvatars, isPrivacyLocked, unlockPrivacy, readiness, refreshReadiness } = useAppStore();
  const { t, language } = useI18n();
  const appName = t("app.name");
  const active = sectionMeta[activeSection];
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [showNewChatDialog, setShowNewChatDialog] = useState(false);
  const [chatCreationError, setChatCreationError] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [charactersDirty, setCharactersDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<AppSection | null>(null);
  const [globalSearchRequest, setGlobalSearchRequest] = useState(0);
  const [upgradeNotice, setUpgradeNotice] = useState<{ previous: string | null; count: number } | null>(null);
  const [unlockPasscode, setUnlockPasscode] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [privacyStatusReady, setPrivacyStatusReady] = useState(false);

  useMobileViewport();

  useEffect(() => subscribeToSystemAppearance(() => useAppStore.getState().appearancePreferences), []);

  useEffect(() => {
    void api.privacy.status()
      .then(({ locked }) => useAppStore.getState().setPrivacyLocked(locked))
      .finally(() => setPrivacyStatusReady(true));
  }, []);

  useEffect(() => {
    const handleBackendLock = () => useAppStore.getState().setPrivacyLocked(true);
    window.addEventListener("star-companion:privacy-locked", handleBackendLock);
    return () => window.removeEventListener("star-companion:privacy-locked", handleBackendLock);
  }, []);

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
        useAppStore.getState().setAppearancePreferences(settings.appearancePreferences);
      })
      .catch(() => {
        document.documentElement.lang = useAppStore.getState().language;
      });
  }, [setLanguage, setShowMessageAvatars]);

  useEffect(() => {
    void api.app.info().then((info) => {
      if (info.migration.status === "upgraded") {
        setUpgradeNotice({ previous: info.migration.previousAppVersion, count: info.migration.appliedCount });
      }
    }).catch(() => undefined);
  }, []);

  const openGlobalSearch = useCallback(() => {
    setGlobalSearchRequest((current) => current + 1);
  }, []);

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      openGlobalSearch();
    };

    window.addEventListener("keydown", handleGlobalSearchShortcut);
    return () => window.removeEventListener("keydown", handleGlobalSearchShortcut);
  }, [openGlobalSearch]);

  const navigate = useCallback(
    (section: AppSection) => {
      const activeSectionDirty =
        (activeSection === "settings" && settingsDirty) ||
        (activeSection === "characters" && charactersDirty);
      if (section !== activeSection && activeSectionDirty) {
        setPendingNavigation(section);
        return;
      }
      setActiveSection(section);
      setShowMobileNav(false);
      window.history.pushState({}, "", sectionPaths[section]);
    },
    [activeSection, charactersDirty, setActiveSection, settingsDirty]
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

  useEffect(() => {
    if (!privacyStatusReady || isPrivacyLocked) return;
    void refreshReadiness();
  }, [chatRefreshKey, activeSection, isPrivacyLocked, privacyStatusReady, refreshReadiness]);

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
    void useAppStore.getState().refreshReadiness();
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
      void useAppStore.getState().refreshReadiness();
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

  if (!privacyStatusReady) {
    return (
      <main id="main-content" className="grid h-dvh place-items-center bg-ink-950 text-ink-50" data-testid="privacy-status-loading">
        <LoaderCircle aria-hidden="true" className="animate-spin text-ember-300" size={24} />
        <span className="sr-only">{language === "zh-CN" ? "正在加载" : "Loading"}</span>
      </main>
    );
  }

  if (isPrivacyLocked) {
    return (
      <main id="main-content" className="grid h-dvh place-items-center bg-ink-950 p-4 text-ink-50" data-testid="privacy-lock-screen">
        <form
          className="w-full max-w-sm rounded-xl border border-white/10 bg-ink-900 p-6 shadow-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            void unlockPrivacy(unlockPasscode).then((unlocked) => {
            if (unlocked) {
              setUnlockPasscode("");
              setUnlockError(null);
            } else {
              setUnlockError(language === "zh-CN" ? "解锁码不正确。" : "Incorrect unlock code.");
            }
            });
          }}
        >
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ember-500/10 text-ember-300">
            <LockKeyhole size={22} />
          </div>
          <h1 className="mt-4 text-center text-lg font-semibold">
            {language === "zh-CN" ? "应用已锁定" : "App locked"}
          </h1>
          <p className="mt-2 text-center text-sm leading-6 text-slate-400">
            {language === "zh-CN"
              ? "聊天关联、使用量和费用明细已从界面卸载。输入本次会话的解锁码继续。"
              : "Chat links, usage, and cost details are unmounted. Enter this session's unlock code to continue."}
          </p>
          <input
            autoFocus
            className="mt-5 min-h-11 w-full rounded-md border border-white/10 bg-ink-950 px-3 text-sm outline-none focus:border-ember-400"
            data-testid="privacy-unlock-input"
            maxLength={128}
            minLength={4}
            placeholder={language === "zh-CN" ? "解锁码" : "Unlock code"}
            type="password"
            value={unlockPasscode}
            onChange={(event) => setUnlockPasscode(event.target.value)}
          />
          {unlockError ? <p className="mt-2 text-sm text-rose-300" role="alert">{unlockError}</p> : null}
          <button className="mt-4 min-h-11 w-full rounded-md bg-ember-500 px-4 text-sm font-semibold text-accentForeground hover:bg-ember-400" data-testid="privacy-unlock-submit" type="submit">
            {language === "zh-CN" ? "解锁" : "Unlock"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="h-dvh bg-ink-950 text-ink-50 selection:bg-ember-400/25 safe-area-top safe-area-bottom transition-[height] duration-200">
      <a className="skip-link" href="#main-content">
        {language === "zh-CN" ? "跳到主要内容" : "Skip to main content"}
      </a>
      <ErrorNotice message={chatCreationError} />
      {readiness?.overallStatus === "server_unreachable" ? (
        <div className="fixed left-1/2 top-4 z-[80] flex w-[min(92vw,42rem)] -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-400/30 bg-ink-900 px-4 py-3 text-sm text-rose-100 shadow-2xl" data-testid="backend-unreachable" role="alert">
          <span>{language === "zh-CN" ? "本地后端暂时不可达。数据仍保留在本机；请确认本地服务已启动后重试。" : "The local backend is unreachable. Your local data remains in place; make sure the local service is running, then retry."}</span>
          <button className="min-h-9 rounded-md border border-rose-300/30 px-3 font-semibold hover:bg-white/5" type="button" onClick={() => void refreshReadiness()}>{language === "zh-CN" ? "重试" : "Retry"}</button>
        </div>
      ) : null}
      {upgradeNotice ? (
        <div className="fixed left-1/2 top-4 z-[80] flex w-[min(92vw,42rem)] -translate-x-1/2 items-start justify-between gap-3 rounded-lg border border-emerald-400/25 bg-ink-900 px-4 py-3 text-sm text-emerald-100 shadow-2xl" data-testid="upgrade-launch-notice" role="status">
          <span>{language === "zh-CN" ? `版本升级与数据迁移已安全完成${upgradeNotice.previous ? `（来自 ${upgradeNotice.previous}）` : ""}，共应用 ${upgradeNotice.count} 项迁移。` : `Version upgrade and data migration completed safely${upgradeNotice.previous ? ` from ${upgradeNotice.previous}` : ""}; ${upgradeNotice.count} migration(s) applied.`}</span>
          <button className="shrink-0 text-emerald-300 hover:text-white" type="button" onClick={() => setUpgradeNotice(null)}>×</button>
        </div>
      ) : null}
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
                    aria-current={selected ? "page" : undefined}
                    className={`group flex min-h-[44px] items-center gap-3 rounded-md border px-3 text-sm font-medium transition-colors ${
                      selected
                        ? "border-ember-400/20 bg-ember-500/10 text-ember-100"
                        : "border-transparent text-ink-300 hover:bg-white/[0.045] hover:text-ink-50"
                    }`}
                    key={item.id}
                    type="button"
                    onFocus={() => preloadSection(item.id)}
                    onMouseEnter={() => preloadSection(item.id)}
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={18} className={selected ? "text-ember-300" : "text-ink-400"} />
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </nav>
            <button
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-ember-400/20 bg-ember-500 px-3 text-sm font-semibold text-accentForeground transition-colors hover:bg-ember-400"
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
            <Suspense fallback={null}>
              <ChatHistoryList
                globalSearchRequest={globalSearchRequest}
                selectedChatId={selectedChatId}
                onSelectChat={handleSelectChat}
                onOpenDocs={() => navigate("docs")}
                refreshKey={chatRefreshKey}
              />
            </Suspense>
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
            <button
              aria-keyshortcuts="Control+K Meta+K"
              aria-label={t("chat.globalSearch")}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
              data-testid="global-search-trigger-desktop"
              title={t("chat.globalSearch")}
              type="button"
              onClick={openGlobalSearch}
            >
              <Search size={17} />
            </button>
          </div>

          <nav className="flex shrink-0 flex-col gap-1 px-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = isNavItemSelected(item.id);

              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={`group flex min-h-10 items-center gap-2.5 rounded-md border px-3 text-sm font-medium transition-colors ${
                    selected
                      ? "border-ember-400/20 bg-ember-500/10 text-ember-100"
                      : "border-transparent bg-transparent text-ink-300 hover:bg-white/[0.045] hover:text-ink-50"
                  }`}
                  key={item.id}
                  type="button"
                  onFocus={() => preloadSection(item.id)}
                  onMouseEnter={() => preloadSection(item.id)}
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
            className="mx-3 mt-3 flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-ember-400/20 bg-ember-500 px-3 text-sm font-semibold text-accentForeground transition-colors hover:bg-ember-400"
            data-testid="new-chat-trigger-desktop"
            type="button"
            onClick={() => setShowNewChatDialog(true)}
          >
            <MessageSquarePlus size={16} />
            {t("chat.newChat")}
          </button>

          <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-white/[0.08] px-3 pt-4">
            <Suspense fallback={null}>
              <ChatHistoryList
                globalSearchRequest={globalSearchRequest}
                selectedChatId={selectedChatId}
                onSelectChat={handleSelectChat}
                onOpenDocs={() => navigate("docs")}
                refreshKey={chatRefreshKey}
              />
            </Suspense>
          </div>
        </aside>

        <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden">
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
            <div className="flex shrink-0 items-center">
              <button
                aria-label={t("chat.globalSearch")}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
                data-testid="global-search-trigger-mobile"
                title={t("chat.globalSearch")}
                type="button"
                onClick={openGlobalSearch}
              >
                <Search size={19} />
              </button>
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
              ) : null}
            </div>
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
            <Suspense
              fallback={
                <div
                  className="grid min-h-[50vh] place-items-center text-sm text-ink-400"
                  data-testid="workspace-loading"
                  role="status"
                >
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                    {t("app.loadingSection")}
                  </span>
                </div>
              }
            >
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
                <CharactersPage
                  onDirtyChange={setCharactersDirty}
                  onPlay={(characterId) => void handlePlay(characterId)}
                />
              ) : null}
              {activeSection === "settings" ? (
                <SettingsPage onDirtyChange={setSettingsDirty} />
              ) : null}
            </Suspense>
          </div>
        </main>
      </div>
      {pendingNavigation ? (
        <ConfirmDialog
          title={t("app.unsavedChangesTitle")}
          message={t("app.unsavedChangesMessage")}
          confirmLabel={t("app.unsavedChangesLeave")}
          cancelLabel={t("common.cancel")}
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
      <Suspense fallback={null}>
        <OnboardingDialog
          language={language}
          onNavigate={navigate}
          onNewChat={() => setShowNewChatDialog(true)}
        />
      </Suspense>
    </div>
  );
}
