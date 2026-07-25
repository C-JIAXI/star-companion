import {
  Archive,
  ArchiveRestore,
  Download,
  FileText,
  GitBranch,
  History,
  MessageSquarePlus,
  Pencil,
  Pin,
  RotateCcw,
  Save,
  Search,
  Settings,
  Trash2,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { buildChatTranscript, safeChatTranscriptName } from "../lib/chatTranscript";
import { readFileText, saveJsonFile, saveTextFile } from "../lib/files";
import { queueChatMessageJump } from "../lib/messageNavigation";
import type { CharacterDTO, ChatArchiveDTO, ChatDTO, GlobalChatMessageSearchDTO } from "../types";
import { ChatGroupHeader } from "./ChatGroupHeader";
import { ConfirmDialog, EmptyState, ErrorNotice, Modal, TextInput } from "./ui";

interface CharacterGroup {
  characterId: string;
  characterName: string;
  characterAvatar: string | null;
  chats: ChatDTO[];
}

type HistorySearchMode = "chats" | "messages";
type ChatHistoryScope = "active" | "archived" | "trash";

const compareChats = (a: ChatDTO, b: ChatDTO) => {
  const pinOrder = Number(b.isPinned) - Number(a.isPinned);
  return pinOrder || b.updatedAt.localeCompare(a.updatedAt);
};

export function ChatHistoryList({
  selectedChatId,
  onSelectChat,
  onOpenDocs,
  refreshKey
}: {
  selectedChatId: string | null;
  onSelectChat: (id: string | null) => void;
  onOpenDocs: () => void;
  refreshKey: number;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [characterCache, setCharacterCache] = useState<Map<string, CharacterDTO>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<HistorySearchMode>("chats");
  const [chatScope, setChatScope] = useState<ChatHistoryScope>("active");
  const [messageSearchResult, setMessageSearchResult] = useState<GlobalChatMessageSearchDTO | null>(null);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatDTO | null>(null);
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);

  const loadChats = async () => {
    try {
      const chatData = await api.chats.list();
      setChats(chatData);

      const allCharacterIds = new Set<string>();
      for (const chat of chatData) {
        if (chat.characterId) {
          allCharacterIds.add(chat.characterId);
        }
      }

      const uncachedIds = [...allCharacterIds].filter((id) => !characterCache.has(id));
      if (uncachedIds.length > 0) {
        try {
          const fetchedCharacters = await api.characters.batchFetch(uncachedIds);
          const fetchedIds = new Set(fetchedCharacters.map((c) => c.id));

          setCharacterCache((prev) => {
            const next = new Map(prev);
            for (const char of fetchedCharacters) {
              next.set(char.id, char);
            }
            return next;
          });

          const missingIds = uncachedIds.filter((id) => !fetchedIds.has(id));
          if (missingIds.length > 0) {
            setChats((prev) =>
              prev.map((chat) =>
                chat.characterId && missingIds.includes(chat.characterId)
                  ? { ...chat, characterId: null }
                  : chat
              )
            );
          }
        } catch {
          // Batch fetch failed, fall back to no character data
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedLoad"));
    }
  };

  useEffect(() => {
    void loadChats();
  }, [refreshKey]);

  const filteredChats = useMemo(() => {
    const scopedChats = chats.filter((chat) => {
      if (chatScope === "trash") {
        return Boolean(chat.deletedAt);
      }
      return !chat.deletedAt && chat.isArchived === (chatScope === "archived");
    });
    if (!searchQuery.trim()) {
      return scopedChats;
    }
    const q = searchQuery.trim().toLowerCase();
    return scopedChats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(q) ||
        characterCache
          .get(chat.characterId ?? "")
          ?.name.toLowerCase()
          .includes(q)
    );
  }, [chats, searchQuery, characterCache, chatScope]);

  const scopeCounts = useMemo(
    () => ({
      active: chats.filter((chat) => !chat.deletedAt && !chat.isArchived).length,
      archived: chats.filter((chat) => !chat.deletedAt && chat.isArchived).length,
      trash: chats.filter((chat) => Boolean(chat.deletedAt)).length
    }),
    [chats]
  );

  const groups = useMemo(() => {
    const map = new Map<string, CharacterGroup>();

    for (const chat of filteredChats) {
      const charId = chat.characterId ?? "unknown";
      if (!map.has(charId)) {
        const char = characterCache.get(charId);
        map.set(charId, {
          characterId: charId,
          characterName: char?.name ?? (language === "zh-CN" ? "未命名角色" : "Unnamed"),
          characterAvatar: char?.avatar ?? null,
          chats: []
        });
      }
      map.get(charId)!.chats.push(chat);
    }

    for (const group of map.values()) {
      group.chats.sort(compareChats);
    }

    return [...map.values()].sort((a, b) => {
      const pinOrder = Number(b.chats.some((chat) => chat.isPinned)) - Number(a.chats.some((chat) => chat.isPinned));
      if (pinOrder) {
        return pinOrder;
      }
      const aLatest = a.chats[0]?.updatedAt ?? "";
      const bLatest = b.chats[0]?.updatedAt ?? "";
      return bLatest.localeCompare(aLatest);
    });
  }, [filteredChats, characterCache, language]);

  useEffect(() => {
    if (open && groups.length > 0) {
      setExpandedGroups(new Set(groups.map((g) => g.characterId)));
    }
  }, [open, groups.length]);

  const toggleGroup = (characterId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(characterId)) {
        next.delete(characterId);
      } else {
        next.add(characterId);
      }
      return next;
    });
  };

  const handleSelect = useCallback(
    (id: string) => {
      if (manageMode) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        return;
      }
      if (chatScope === "trash") {
        return;
      }
      onSelectChat(id);
      setOpen(false);
    },
    [chatScope, manageMode, onSelectChat]
  );

  const handleOpen = () => {
    setSearchQuery("");
    setSearchMode("chats");
    setChatScope("active");
    setMessageSearchResult(null);
    setManageMode(false);
    setSelectedIds(new Set());
    void loadChats();
    setOpen(true);
  };

  const runMessageSearch = async () => {
    if (!searchQuery.trim()) {
      setMessageSearchResult(null);
      return;
    }
    setMessageSearchLoading(true);
    setError(null);
    try {
      setMessageSearchResult(await api.chats.globalMessageSearch(searchQuery.trim(), 30));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.historyMessageSearchFailed"));
    } finally {
      setMessageSearchLoading(false);
    }
  };

  const selectMessageSearchResult = (result: GlobalChatMessageSearchDTO["results"][number]) => {
    queueChatMessageJump({
      chatId: result.chat.id,
      messageId: result.message.id,
      index: result.index
    });
    onSelectChat(result.chat.id);
    setOpen(false);
  };

  const toggleManage = () => {
    setManageMode((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredChats.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredChats.map((c) => c.id)));
    }
  };

  const deleteChat = async () => {
    if (!pendingDeleteChat) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (chatScope === "trash") {
        await api.chats.permanentlyRemove(pendingDeleteChat.id);
      } else {
        await api.chats.remove(pendingDeleteChat.id);
      }
      setPendingDeleteChat(null);
      if (selectedChatId === pendingDeleteChat.id) {
        onSelectChat(null);
      }
      await loadChats();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t(chatScope === "trash" ? "chat.failedPermanentDelete" : "chat.failedDelete")
      );
    } finally {
      setLoading(false);
    }
  };

  const batchDelete = async () => {
    if (selectedIds.size === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setBatchDeleteConfirm(false);
    try {
      const ids = [...selectedIds];
      if (chatScope === "trash") {
        await api.chats.batchPermanentlyRemove({ ids });
      } else {
        await api.chats.batchTrash({ ids, action: "trash" });
      }
      if (selectedChatId && selectedIds.has(selectedChatId)) {
        onSelectChat(null);
      }
      setSelectedIds(new Set());
      setManageMode(false);
      await loadChats();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t(chatScope === "trash" ? "chat.failedPermanentDelete" : "chat.failedDelete")
      );
    } finally {
      setLoading(false);
    }
  };

  const batchArchive = async () => {
    if (selectedIds.size === 0 || chatScope === "trash") {
      return;
    }

    setLoading(true);
    setError(null);
    const ids = [...selectedIds];
    const isArchived = chatScope === "active";
    try {
      await api.chats.batchArchive({ ids, isArchived });
      if (isArchived && selectedChatId && selectedIds.has(selectedChatId)) {
        onSelectChat(null);
      }
      setSelectedIds(new Set());
      setManageMode(false);
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedBatchArchive"));
    } finally {
      setLoading(false);
    }
  };

  const restoreChat = async (chat: ChatDTO) => {
    setLoading(true);
    setError(null);
    try {
      await api.chats.restore(chat.id);
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRestore"));
    } finally {
      setLoading(false);
    }
  };

  const batchRestoreFromTrash = async () => {
    if (selectedIds.size === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.chats.batchTrash({ ids: [...selectedIds], action: "restore" });
      setSelectedIds(new Set());
      setManageMode(false);
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRestore"));
    } finally {
      setLoading(false);
    }
  };

  const startRename = (chat: ChatDTO) => {
    setRenamingId(chat.id);
    setRenameValue(chat.title);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const commitRename = async () => {
    if (!renamingId) {
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === chats.find((c) => c.id === renamingId)?.title) {
      setRenamingId(null);
      return;
    }
    try {
      const updated = await api.chats.update(renamingId, { title: trimmed });
      setChats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setRenamingId(null);
    }
  };

  const togglePin = async (chat: ChatDTO) => {
    setError(null);
    try {
      const updated = await api.chats.update(chat.id, { isPinned: !chat.isPinned });
      setChats((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const toggleArchive = async (chat: ChatDTO) => {
    setError(null);
    try {
      const updated = await api.chats.update(chat.id, { isArchived: !chat.isArchived });
      setChats((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      if (!chat.isArchived && selectedChatId === chat.id) {
        onSelectChat(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const exportChatTranscript = async (chat: ChatDTO) => {
    try {
      const data = await api.chats.get(chat.id);
      const date = new Date().toISOString().slice(0, 10);
      const transcript = buildChatTranscript({
        chat: data,
        characterName: chat.characterId
          ? characterCache.get(chat.characterId)?.name
          : undefined,
        language,
        format: "markdown",
        includeTimestamps: true
      });
      await saveTextFile(
        `chat-${safeChatTranscriptName(chat.title)}-${date}.md`,
        transcript,
        "text/markdown;charset=utf-8"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedExportChat"));
    }
  };

  const exportChatArchive = async (chat: ChatDTO) => {
    try {
      const archive = await api.chats.exportArchive(chat.id);
      const safeName = chat.title.replace(/[^\w一-鿿-]/g, "_").slice(0, 50);
      await saveJsonFile(`chat-archive-${safeName}-${new Date().toISOString().slice(0, 10)}.json`, archive);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to export chat archive");
    }
  };

  const importChatArchive = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const archive = JSON.parse(await readFileText(file)) as ChatArchiveDTO;
      const imported = await api.chats.importArchive({ archive });
      await loadChats();
      onSelectChat(imported.id);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to import chat archive");
    } finally {
      setLoading(false);
    }
  };

  const modalTitle = manageMode
    ? language === "zh-CN"
      ? "管理历史"
      : "Manage History"
    : t("chat.history");

  return (
    <>
      <div className="space-y-1">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-all duration-200 hover:bg-white/5 hover:text-slate-200 min-h-[32px]"
          data-testid="chat-history-trigger"
          type="button"
          onClick={handleOpen}
        >
          <History size={14} />
          <span>{t("chat.history")}</span>
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-all duration-200 hover:bg-white/5 hover:text-slate-200 min-h-[32px]"
          data-testid="chat-docs-entry"
          type="button"
          onClick={() => {
            setOpen(false);
            onOpenDocs();
          }}
        >
          <FileText size={14} />
          <span>{t("chat.docs")}</span>
        </button>
      </div>

      {open
        ? createPortal(
            <Modal title={modalTitle} onClose={() => setOpen(false)}>
              <div className="space-y-3">
                <div className="flex justify-end">
                  <button
                    className="flex min-h-[32px] items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
                    disabled={loading}
                    type="button"
                    onClick={() => archiveInputRef.current?.click()}
                  >
                    <Upload size={13} />
                    {language === "zh-CN" ? "导入聊天归档" : "Import chat archive"}
                  </button>
                  <input
                    ref={archiveInputRef}
                    className="sr-only"
                    accept="application/json,.json"
                    type="file"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void importChatArchive(file);
                    }}
                  />
                </div>
                <div
                  aria-label={t("chat.historySearchMode")}
                  className="grid grid-cols-2 rounded-lg border border-white/10 bg-ink-950/40 p-1"
                  role="group"
                >
                  {(["chats", "messages"] as const).map((mode) => (
                    <button
                      aria-pressed={searchMode === mode}
                      className={`min-h-[34px] rounded-md px-3 text-xs font-medium transition-colors ${
                        searchMode === mode
                          ? "bg-ember-500 text-ink-950"
                          : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                      }`}
                      key={mode}
                      type="button"
                      onClick={() => {
                        setSearchMode(mode);
                        setSearchQuery("");
                        setMessageSearchResult(null);
                        setManageMode(false);
                        setSelectedIds(new Set());
                      }}
                    >
                      {mode === "chats" ? t("chat.historySearchChats") : t("chat.historySearchMessages")}
                    </button>
                  ))}
                </div>
                {searchMode === "chats" ? (
                  <div
                    aria-label={t("chat.historyScope")}
                    className="grid grid-cols-3 rounded-lg border border-white/10 bg-ink-950/30 p-1"
                    role="group"
                  >
                    {(["active", "archived", "trash"] as const).map((scope) => (
                      <button
                        aria-pressed={chatScope === scope}
                        className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors ${
                          chatScope === scope
                            ? "bg-white/10 text-slate-100"
                            : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                        }`}
                        data-testid={`chat-history-scope-${scope}`}
                        key={scope}
                        type="button"
                        onClick={() => {
                          setChatScope(scope);
                          setSearchQuery("");
                          setManageMode(false);
                          setSelectedIds(new Set());
                        }}
                      >
                        {scope === "active"
                          ? t("chat.historyActive")
                          : scope === "archived"
                            ? t("chat.historyArchived")
                            : t("chat.historyTrash")} ({scopeCounts[scope]})
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                    size={16}
                  />
                  <TextInput
                    className={`pl-9 ${searchMode === "chats" && manageMode ? "pr-[180px]" : "pr-12"}`}
                    data-testid="chat-history-search"
                    placeholder={
                      searchMode === "chats"
                        ? language === "zh-CN"
                          ? "搜索历史对话..."
                          : "Search chat history..."
                        : t("chat.historyMessageSearchPlaceholder")
                    }
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      if (searchMode === "messages") {
                        setMessageSearchResult(null);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (searchMode === "messages" && event.key === "Enter") {
                        event.preventDefault();
                        void runMessageSearch();
                      }
                    }}
                  />
                  <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {searchMode === "messages" ? (
                      <button
                        aria-label={t("chat.historyMessageSearchRun")}
                        className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100 disabled:opacity-40"
                        disabled={messageSearchLoading || !searchQuery.trim()}
                        title={t("chat.historyMessageSearchRun")}
                        type="button"
                        onClick={() => void runMessageSearch()}
                      >
                        <Search size={14} />
                      </button>
                    ) : null}
                    {searchMode === "chats" && manageMode && filteredChats.length > 0 ? (
                      <>
                        <button
                          className="rounded-md px-1.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
                          data-testid="chat-history-select-all"
                          disabled={loading}
                          type="button"
                          onClick={toggleSelectAll}
                        >
                          {selectedIds.size === filteredChats.length
                            ? language === "zh-CN"
                              ? "取消全选"
                              : "Deselect"
                            : language === "zh-CN"
                              ? "全选"
                              : "All"}
                        </button>
                        {selectedIds.size > 0 ? (
                          <button
                            aria-label={
                              chatScope === "active" ? t("chat.archiveSelected") : t("chat.restoreSelected")
                            }
                            className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                              chatScope === "active"
                                ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                                : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                            }`}
                            data-testid="chat-history-batch-archive"
                            disabled={loading}
                            title={
                              chatScope === "active" ? t("chat.archiveSelected") : t("chat.restoreSelected")
                            }
                            type="button"
                            onClick={() =>
                              void (chatScope === "trash" ? batchRestoreFromTrash() : batchArchive())
                            }
                          >
                            {chatScope === "active" ? (
                              <Archive size={11} />
                            ) : chatScope === "trash" ? (
                              <RotateCcw size={11} />
                            ) : (
                              <ArchiveRestore size={11} />
                            )}
                            {selectedIds.size}
                          </button>
                        ) : null}
                        {selectedIds.size > 0 ? (
                          <button
                            aria-label={
                              chatScope === "trash"
                                ? t("chat.permanentlyDelete")
                                : t("chat.moveToTrash")
                            }
                            className="flex items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-1 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-500/25"
                            data-testid="chat-history-batch-delete"
                            disabled={loading}
                            title={
                              chatScope === "trash"
                                ? t("chat.permanentlyDelete")
                                : t("chat.moveToTrash")
                            }
                            type="button"
                            onClick={() => setBatchDeleteConfirm(true)}
                          >
                            <Trash2 size={11} />
                            {selectedIds.size}
                          </button>
                        ) : null}
                        <span className="mx-0.5 h-3.5 w-px bg-white/10" />
                      </>
                    ) : null}
                    {searchMode === "chats" && filteredChats.length > 0 ? (
                      <button
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
                        data-testid="chat-history-manage"
                        disabled={loading}
                        type="button"
                        onClick={toggleManage}
                      >
                        <Settings size={12} />
                        {manageMode
                          ? language === "zh-CN"
                            ? "退出"
                            : "Exit"
                          : language === "zh-CN"
                            ? "管理"
                            : "Manage"}
                      </button>
                    ) : null}
                  </div>
                </div>

                <ErrorNotice message={error} />

                <div className="custom-scrollbar max-h-[420px] space-y-2 overflow-y-auto">
                  {searchMode === "messages" ? (
                    !searchQuery.trim() ? (
                      <div className="py-8 text-center text-sm text-slate-500">
                        {t("chat.historyMessageSearchHelp")}
                      </div>
                    ) : messageSearchResult ? (
                      messageSearchResult.results.length ? (
                        <div className="space-y-2" data-testid="history-message-search-results">
                          {messageSearchResult.results.map((result) => {
                            const roleLabel =
                              result.message.role === "assistant"
                                ? t("chat.searchAssistant")
                                : result.message.role === "system"
                                  ? t("chat.searchSystem")
                                  : t("chat.searchUser");
                            return (
                              <button
                                className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left transition-colors hover:border-ember-400/50 hover:bg-ember-500/10"
                                data-testid="history-message-search-result"
                                key={result.message.id}
                                type="button"
                                onClick={() => selectMessageSearchResult(result)}
                              >
                                <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                                  <span className="max-w-full truncate font-semibold text-ember-200">
                                    {result.chat.title}
                                  </span>
                                  <span>{roleLabel}</span>
                                  {result.chat.isArchived ? (
                                    <span className="inline-flex items-center gap-1 text-slate-400">
                                      <Archive size={11} />
                                      {t("chat.archived")}
                                    </span>
                                  ) : null}
                                  <span>{t("chat.searchPosition", { index: result.index + 1 })}</span>
                                </div>
                                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                                  {result.snippet}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="py-8 text-center text-sm text-slate-500">
                          {t("chat.historyMessageSearchEmpty")}
                        </div>
                      )
                    ) : (
                      <div className="py-8 text-center text-sm text-slate-500">
                        {messageSearchLoading
                          ? t("chat.searching")
                          : t("chat.historyMessageSearchHelp")}
                      </div>
                    )
                  ) : groups.length === 0 ? (
                    <div className="py-8 text-center">
                      <EmptyState>
                        {searchQuery.trim()
                          ? language === "zh-CN"
                            ? "没有匹配的对话"
                            : "No matching chats"
                          : chatScope === "archived"
                            ? t("chat.noArchivedChats")
                            : chatScope === "trash"
                              ? t("chat.noTrashedChats")
                              : t("chat.noChats")}
                      </EmptyState>
                    </div>
                  ) : (
                    groups.map((group) => {
                      const isExpanded = expandedGroups.has(group.characterId);

                      return (
                        <div
                          key={group.characterId}
                          className="rounded-lg border border-white/5 bg-white/[0.02]"
                        >
                          <ChatGroupHeader
                            characterId={group.characterId}
                            characterAvatar={group.characterAvatar}
                            characterName={group.characterName}
                            chatCount={group.chats.length}
                            isExpanded={isExpanded}
                            onToggle={toggleGroup}
                          />

                          {isExpanded ? (
                            <div className="space-y-0.5 border-t border-white/5 px-1 pb-1 pt-1">
                              {group.chats.map((chat) => {
                                const isSelected = manageMode && selectedIds.has(chat.id);
                                const isCurrent = chatScope !== "trash" && selectedChatId === chat.id;

                                return (
                                  <div
                                    className={`group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-all duration-200 min-h-[36px] ${
                                      chatScope === "trash" && !manageMode ? "cursor-default" : "cursor-pointer"
                                    } ${
                                      isSelected
                                        ? "bg-ember-500/20 text-ember-100"
                                        : isCurrent
                                          ? "bg-white/5 text-ember-100"
                                          : "text-slate-400 hover:bg-white/5 hover:text-slate-200 active:bg-white/[0.08]"
                                    }`}
                                    key={chat.id}
                                    data-chat-history-row=""
                                    data-chat-id={chat.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => handleSelect(chat.id)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        handleSelect(chat.id);
                                      }
                                    }}
                                  >
                                    {manageMode ? (
                                      <span
                                        className={`grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors ${
                                          isSelected
                                            ? "border-ember-500 bg-ember-500 text-ink-950"
                                            : "border-white/20 bg-ink-900 text-transparent"
                                        }`}
                                      >
                                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                                          <path
                                            d="M2.5 6.5L4.5 8.5L9.5 3.5"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      </span>
                                    ) : chatScope === "trash" ? (
                                      <Trash2 size={13} className="shrink-0 text-rose-300/70" />
                                    ) : chat.isCheckpoint ? (
                                        <Save
                                          size={13}
                                          aria-label={t("chat.checkpoint")}
                                          className="shrink-0 text-emerald-300/80"
                                        />
                                      ) : chat.parentChatId ? (
                                        <GitBranch
                                          size={13}
                                          aria-label={language === "zh-CN" ? "聊天分支" : "Chat branch"}
                                          className="shrink-0 text-ember-300/70"
                                        />
                                      ) : (
                                        <MessageSquarePlus
                                          size={13}
                                          className="shrink-0 text-slate-600"
                                        />
                                      )}
                                    {renamingId === chat.id ? (
                                      <input
                                        ref={renameInputRef}
                                        className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-200 outline-none ring-1 ring-ember-500/50 rounded"
                                        value={renameValue}
                                        onChange={(event) => setRenameValue(event.target.value)}
                                        onBlur={() => void commitRename()}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            void commitRename();
                                          }
                                          if (event.key === "Escape") {
                                            setRenamingId(null);
                                          }
                                        }}
                                        onClick={(event) => event.stopPropagation()}
                                      />
                                    ) : (
                                      <span className="min-w-0 flex-1 truncate" data-chat-history-title="">
                                        {chat.title}
                                      </span>
                                    )}
                                    {!manageMode && chatScope !== "trash" && !chat.isArchived && renamingId !== chat.id ? (
                                      <button
                                        aria-label={chat.isPinned ? t("chat.unpin") : t("chat.pin")}
                                        aria-pressed={chat.isPinned}
                                        className={`grid h-6 w-6 shrink-0 place-items-center rounded transition-all hover:bg-white/10 active:bg-white/20 ${
                                          chat.isPinned
                                            ? "text-ember-300"
                                            : "text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:text-slate-300"
                                        }`}
                                        data-chat-action="pin"
                                        title={chat.isPinned ? t("chat.unpin") : t("chat.pin")}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void togglePin(chat);
                                        }}
                                      >
                                        <Pin fill={chat.isPinned ? "currentColor" : "none"} size={11} />
                                      </button>
                                    ) : null}
                                    {!manageMode && chatScope !== "trash" && renamingId !== chat.id ? (
                                      <button
                                        aria-label={chat.isArchived ? t("chat.unarchive") : t("chat.archive")}
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:bg-white/10 hover:text-slate-300 active:bg-white/20"
                                        data-chat-action="archive"
                                        title={chat.isArchived ? t("chat.unarchive") : t("chat.archive")}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void toggleArchive(chat);
                                        }}
                                      >
                                        {chat.isArchived ? <ArchiveRestore size={11} /> : <Archive size={11} />}
                                      </button>
                                    ) : null}
                                    {!manageMode && chatScope !== "trash" && renamingId !== chat.id ? (
                                      <button
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-white/10 hover:text-slate-300 active:bg-white/20 transition-all"
                                        title={language === "zh-CN" ? "导出聊天归档" : "Export chat archive"}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void exportChatArchive(chat);
                                        }}
                                      >
                                        <FileText size={11} />
                                      </button>
                                    ) : null}
                                    {!manageMode && chatScope !== "trash" && renamingId !== chat.id ? (
                                      <button
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-white/10 hover:text-slate-300 active:bg-white/20 transition-all"
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          startRename(chat);
                                        }}
                                      >
                                        <Pencil size={11} />
                                      </button>
                                    ) : null}
                                    {!manageMode && chatScope !== "trash" && renamingId !== chat.id ? (
                                      <button
                                        aria-label={t("chat.exportReadable")}
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-white/10 hover:text-slate-300 active:bg-white/20 transition-all"
                                        data-chat-action="export-transcript"
                                        title={t("chat.exportReadable")}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void exportChatTranscript(chat);
                                        }}
                                      >
                                        <Download size={11} />
                                      </button>
                                    ) : null}
                                    {!manageMode && chatScope === "trash" ? (
                                      <button
                                        aria-label={t("chat.restoreFromTrash")}
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 transition-all sm:opacity-0 sm:group-hover:opacity-100 hover:bg-emerald-500/15 hover:text-emerald-300 active:bg-emerald-500/25"
                                        data-chat-action="restore"
                                        disabled={loading}
                                        title={t("chat.restoreFromTrash")}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void restoreChat(chat);
                                        }}
                                      >
                                        <RotateCcw size={11} />
                                      </button>
                                    ) : null}
                                    {!manageMode && renamingId !== chat.id ? (
                                      <button
                                        aria-label={
                                          chatScope === "trash"
                                            ? t("chat.permanentlyDelete")
                                            : t("chat.moveToTrash")
                                        }
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 active:bg-rose-500/25 transition-all"
                                        data-chat-action={chatScope === "trash" ? "permanent-delete" : "trash"}
                                        title={
                                          chatScope === "trash"
                                            ? t("chat.permanentlyDelete")
                                            : t("chat.moveToTrash")
                                        }
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setPendingDeleteChat(chat);
                                        }}
                                      >
                                        <Trash2 size={11} />
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>

                {searchMode === "chats" && filteredChats.length > 0 ? (
                  <p className="text-center text-xs text-slate-500">
                    {language === "zh-CN"
                      ? `共 ${filteredChats.length} 条对话 · ${groups.length} 个角色`
                      : `${filteredChats.length} chat(s) · ${groups.length} character(s)`}
                  </p>
                ) : null}
              </div>
            </Modal>,
            document.body
          )
        : null}

      {pendingDeleteChat
        ? createPortal(
            <ConfirmDialog
              cancelLabel={t("common.cancel")}
              confirmLabel={
                chatScope === "trash" ? t("chat.permanentlyDelete") : t("chat.moveToTrash")
              }
              loading={loading}
              message={
                t(
                  chatScope === "trash"
                    ? "chat.permanentlyDeleteConfirm"
                    : "chat.moveToTrashConfirm",
                  { title: pendingDeleteChat.title }
                )
              }
              title={
                t(chatScope === "trash" ? "chat.permanentlyDeleteTitle" : "chat.moveToTrashTitle")
              }
              onCancel={() => setPendingDeleteChat(null)}
              onConfirm={() => void deleteChat()}
            />,
            document.body
          )
        : null}

      {batchDeleteConfirm
        ? createPortal(
            <ConfirmDialog
              cancelLabel={t("common.cancel")}
              confirmLabel={
                chatScope === "trash" ? t("chat.permanentlyDelete") : t("chat.moveToTrash")
              }
              loading={loading}
              message={
                language === "zh-CN"
                  ? chatScope === "trash"
                    ? `永久删除选中的 ${selectedIds.size} 条对话？消息和长期记忆将一并删除，此操作不可撤销。`
                    : `将选中的 ${selectedIds.size} 条对话移入回收站？消息和长期记忆会保留，之后可以恢复。`
                  : chatScope === "trash"
                    ? `Permanently delete ${selectedIds.size} selected chat(s)? Their messages and long-term memories will also be deleted. This cannot be undone.`
                    : `Move ${selectedIds.size} selected chat(s) to Trash? Their messages and long-term memories will be kept so you can restore them later.`
              }
              title={
                t(chatScope === "trash" ? "chat.permanentlyDeleteTitle" : "chat.moveToTrashTitle")
              }
              onCancel={() => setBatchDeleteConfirm(false)}
              onConfirm={() => void batchDelete()}
            />,
            document.body
          )
        : null}
    </>
  );
}
