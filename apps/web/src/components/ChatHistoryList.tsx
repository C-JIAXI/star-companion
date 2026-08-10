import {
  Archive,
  ArchiveRestore,
  Download,
  FileText,
  Folder,
  GitBranch,
  History,
  MessageSquarePlus,
  MoreHorizontal,
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
import { usePlaceholderSrc } from "../placeholderImages";
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

const formatChatActivity = (value: string, language: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const locale = language === "zh-CN" ? "zh-CN" : "en";
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startOfDate - startOfToday) / 86_400_000);
  if (dayDifference >= -6 && dayDifference < 0) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(dayDifference, "day");
  }

  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric"
  }).format(date);
};

function RecentChatItem({
  chat,
  character,
  current,
  language,
  onSelect
}: {
  chat: ChatDTO;
  character: CharacterDTO | undefined;
  current: boolean;
  language: string;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const avatar = usePlaceholderSrc(character?.avatar, chat.characterId ?? chat.id);
  const activity = formatChatActivity(chat.lastMessagePreview?.createdAt ?? chat.updatedAt, language);

  return (
    <button
      aria-current={current ? "page" : undefined}
      className={`group flex min-h-[52px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
        current
          ? "bg-ember-500/[0.1] text-ember-100 shadow-[inset_2px_0_0_rgba(69,203,178,0.9)]"
          : "text-ink-300 hover:bg-white/[0.045] hover:text-ink-100"
      }`}
      data-chat-id={chat.id}
      data-testid="chat-recent-item"
      type="button"
      onClick={onSelect}
    >
      <span className="relative shrink-0">
        <img
          alt=""
          className="h-8 w-8 rounded-md object-cover ring-1 ring-white/10"
          loading="lazy"
          src={avatar}
        />
        {chat.isPinned ? (
          <Pin
            aria-hidden="true"
            className="absolute -right-1 -top-1 rounded bg-ink-800 p-0.5 text-amber-300"
            fill="currentColor"
            size={12}
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{chat.title}</span>
          <time
            className="shrink-0 text-[10px] tabular-nums text-ink-600"
            dateTime={chat.lastMessagePreview?.createdAt ?? chat.updatedAt}
          >
            {activity}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-ink-500">
          {chat.lastMessagePreview?.content ??
            character?.name ??
            t("chat.historyNoMessages")}
        </span>
      </span>
    </button>
  );
}

export function ChatHistoryList({
  selectedChatId,
  onSelectChat,
  onOpenDocs,
  refreshKey,
  globalSearchRequest = 0
}: {
  selectedChatId: string | null;
  onSelectChat: (id: string | null) => void;
  onOpenDocs: () => void;
  refreshKey: number;
  globalSearchRequest?: number;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [characterCache, setCharacterCache] = useState<Map<string, CharacterDTO>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<HistorySearchMode>("chats");
  const [openedFromGlobalSearch, setOpenedFromGlobalSearch] = useState(false);
  const [chatScope, setChatScope] = useState<ChatHistoryScope>("active");
  const [folderFilter, setFolderFilter] = useState("all");
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
  const [actionMenuChatId, setActionMenuChatId] = useState<string | null>(null);
  const [folderEditingChat, setFolderEditingChat] = useState<ChatDTO | null>(null);
  const [folderEditingIds, setFolderEditingIds] = useState<string[] | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [folderRenameFrom, setFolderRenameFrom] = useState<string | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchOnOpenRef = useRef(false);

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
    const folderFilteredChats =
      folderFilter === "all"
        ? scopedChats
        : folderFilter === "unfiled"
          ? scopedChats.filter((chat) => !chat.folder)
          : scopedChats.filter((chat) => chat.folder === folderFilter);
    if (!searchQuery.trim()) {
      return folderFilteredChats;
    }
    const q = searchQuery.trim().toLowerCase();
    return folderFilteredChats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(q) ||
        characterCache
          .get(chat.characterId ?? "")
          ?.name.toLowerCase()
          .includes(q)
    );
  }, [chats, searchQuery, characterCache, chatScope, folderFilter]);

  const folderOptions = useMemo(() => {
    const folders = new Set(
      chats
        .filter((chat) =>
          chatScope === "trash"
            ? Boolean(chat.deletedAt)
            : !chat.deletedAt && chat.isArchived === (chatScope === "archived")
        )
        .map((chat) => chat.folder)
        .filter(Boolean)
    );
    return [...folders].sort((a, b) => a.localeCompare(b, language === "zh-CN" ? "zh-CN" : "en"));
  }, [chats, chatScope, language]);

  const scopeCounts = useMemo(
    () => ({
      active: chats.filter((chat) => !chat.deletedAt && !chat.isArchived).length,
      archived: chats.filter((chat) => !chat.deletedAt && chat.isArchived).length,
      trash: chats.filter((chat) => Boolean(chat.deletedAt)).length
    }),
    [chats]
  );
  const activeChats = useMemo(
    () => chats.filter((chat) => !chat.deletedAt && !chat.isArchived).sort(compareChats),
    [chats]
  );
  const recentChats = useMemo(() => {
    const pinned = activeChats.filter((chat) => chat.isPinned);
    const unpinned = activeChats.filter((chat) => !chat.isPinned);
    const pinnedLimit = unpinned.length > 0 ? 3 : 6;
    const selectedPinned = pinned.slice(0, pinnedLimit);
    return [...selectedPinned, ...unpinned.slice(0, 6 - selectedPinned.length)];
  }, [activeChats]);

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
      setActionMenuChatId(null);
      setOpen(false);
    },
    [chatScope, manageMode, onSelectChat]
  );

  const handleOpen = (mode: HistorySearchMode = "chats", focusSearch = false) => {
    setSearchQuery("");
    setSearchMode(mode);
    setChatScope("active");
    setFolderFilter("all");
    setMessageSearchResult(null);
    setManageMode(false);
    setSelectedIds(new Set());
    setActionMenuChatId(null);
    setOpenedFromGlobalSearch(mode === "messages" && focusSearch);
    focusSearchOnOpenRef.current = focusSearch;
    void loadChats();
    setOpen(true);
  };

  useEffect(() => {
    if (
      globalSearchRequest <= 0 ||
      !historyTriggerRef.current ||
      historyTriggerRef.current.offsetParent === null
    ) {
      return;
    }

    handleOpen("messages", true);
  }, [globalSearchRequest]);

  useEffect(() => {
    if (!open || !focusSearchOnOpenRef.current) {
      return;
    }

    focusSearchOnOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

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
    setActionMenuChatId(null);
    setOpen(false);
  };

  const toggleManage = () => {
    setManageMode((prev) => !prev);
    setSelectedIds(new Set());
    setActionMenuChatId(null);
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
      setChats((prev) =>
        prev.map((chat) =>
          chat.id === updated.id
            ? { ...chat, ...updated, lastMessagePreview: chat.lastMessagePreview }
            : chat
        )
      );
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
      setChats((current) =>
        current.map((entry) =>
          entry.id === updated.id
            ? { ...entry, ...updated, lastMessagePreview: entry.lastMessagePreview }
            : entry
        )
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const toggleArchive = async (chat: ChatDTO) => {
    setError(null);
    try {
      const updated = await api.chats.update(chat.id, { isArchived: !chat.isArchived });
      setChats((current) =>
        current.map((entry) =>
          entry.id === updated.id
            ? { ...entry, ...updated, lastMessagePreview: entry.lastMessagePreview }
            : entry
        )
      );
      if (!chat.isArchived && selectedChatId === chat.id) {
        onSelectChat(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const startFolderEdit = (chat: ChatDTO) => {
    setFolderEditingChat(chat);
    setFolderDraft(chat.folder);
  };

  const saveFolder = async () => {
    if (!folderEditingChat) {
      return;
    }

    const folder = folderDraft.trim();
    setLoading(true);
    setError(null);
    try {
      const updated = await api.chats.update(folderEditingChat.id, { folder });
      setChats((current) =>
        current.map((chat) =>
          chat.id === updated.id
            ? { ...chat, ...updated, lastMessagePreview: chat.lastMessagePreview }
            : chat
        )
      );
      setFolderEditingChat(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setLoading(false);
    }
  };

  const startBatchFolderEdit = () => {
    if (selectedIds.size === 0) {
      return;
    }
    setFolderDraft("");
    setFolderEditingIds([...selectedIds]);
  };

  const saveBatchFolder = async () => {
    if (!folderEditingIds?.length) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.chats.batchFolder({ ids: folderEditingIds, folder: folderDraft.trim() });
      setFolderEditingIds(null);
      setSelectedIds(new Set());
      setManageMode(false);
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setLoading(false);
    }
  };

  const startFolderRename = (folder: string) => {
    setFolderRenameFrom(folder);
    setFolderRenameDraft(folder);
  };

  const saveFolderRename = async () => {
    if (!folderRenameFrom) {
      return;
    }

    const destination = folderRenameDraft.trim();
    if (destination === folderRenameFrom) {
      setFolderRenameFrom(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.chats.renameFolder({ from: folderRenameFrom, to: destination });
      setFolderRenameFrom(null);
      setFolderRenameDraft("");
      setFolderFilter(destination || "unfiled");
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setLoading(false);
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

  const modalTitle = openedFromGlobalSearch
    ? t("chat.globalSearch")
    : manageMode
      ? language === "zh-CN"
        ? "管理历史"
        : "Manage History"
      : t("chat.history");

  return (
    <>
      <div className="space-y-1">
        <button
          ref={historyTriggerRef}
          aria-keyshortcuts="Control+K Meta+K"
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-ink-300 transition-colors hover:bg-white/[0.045] hover:text-ink-100"
          data-testid="chat-history-trigger"
          title={t("chat.globalSearch")}
          type="button"
          onClick={() => handleOpen()}
        >
          <History size={14} />
          <span>{t("chat.history")}</span>
        </button>
        <button
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-ink-300 transition-colors hover:bg-white/[0.045] hover:text-ink-100"
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

      {recentChats.length > 0 ? (
        <div className="mt-4 border-t border-white/[0.08] pt-3" data-testid="chat-recent-list">
          <div className="mb-1.5 flex items-center justify-between gap-2 px-2.5">
            <p className="text-[11px] font-semibold uppercase text-ink-500">
              {t("chat.recentChats")}
            </p>
            <span className="text-[10px] tabular-nums text-ink-600">{activeChats.length}</span>
          </div>
          <div className="space-y-0.5">
            {recentChats.map((chat) => (
              <RecentChatItem
                chat={chat}
                character={
                  chat.characterId ? characterCache.get(chat.characterId) : undefined
                }
                current={selectedChatId === chat.id}
                key={chat.id}
                language={language}
                onSelect={() => {
                  onSelectChat(chat.id);
                  setActionMenuChatId(null);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          {activeChats.length > recentChats.length ? (
            <button
              className="mt-1 flex min-h-8 w-full items-center justify-center rounded-md px-2 text-[11px] font-medium text-ink-500 transition-colors hover:bg-white/[0.045] hover:text-ink-200"
              data-testid="chat-recent-view-all"
              type="button"
              onClick={() => handleOpen()}
            >
              {t("chat.viewAllHistory", { count: activeChats.length - recentChats.length })}
            </button>
          ) : null}
        </div>
      ) : null}

      {open
        ? createPortal(
            <Modal
              title={modalTitle}
              onClose={() => {
                setActionMenuChatId(null);
                setOpen(false);
              }}
            >
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
                  className="grid grid-cols-2 rounded-md border border-white/[0.08] bg-ink-950/60 p-1"
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
                  <>
                    <div
                      aria-label={t("chat.historyScope")}
                      className="grid grid-cols-3 rounded-md border border-white/[0.08] bg-ink-950/45 p-1"
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
                          setFolderFilter("all");
                          setSearchQuery("");
                          setManageMode(false);
                          setSelectedIds(new Set());
                          setActionMenuChatId(null);
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
                    <div className="flex min-w-0 items-center gap-1.5">
                      <label className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-white/[0.08] bg-ink-950/35 px-2.5 text-xs text-slate-400">
                        <Folder size={13} className="shrink-0 text-slate-500" />
                        <span className="shrink-0">{language === "zh-CN" ? "文件夹" : "Folder"}</span>
                        <select
                          aria-label={language === "zh-CN" ? "筛选聊天文件夹" : "Filter chat folders"}
                          className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none"
                          data-testid="chat-history-folder-filter"
                          value={folderFilter}
                          onChange={(event) => {
                            setFolderFilter(event.target.value);
                            setManageMode(false);
                            setSelectedIds(new Set());
                            setActionMenuChatId(null);
                          }}
                        >
                          <option value="all">{language === "zh-CN" ? "全部文件夹" : "All folders"}</option>
                          <option value="unfiled">{language === "zh-CN" ? "未分类" : "Unfiled"}</option>
                          {folderOptions.map((folder) => (
                            <option key={folder} value={folder}>
                              {folder}
                            </option>
                          ))}
                        </select>
                      </label>
                      {folderFilter !== "all" && folderFilter !== "unfiled" ? (
                        <button
                          aria-label={language === "zh-CN" ? "管理当前文件夹" : "Manage current folder"}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-ink-950/35 text-slate-400 transition-colors hover:border-ember-400/35 hover:text-ember-200"
                          data-testid="chat-history-rename-folder"
                          title={language === "zh-CN" ? "管理当前文件夹" : "Manage current folder"}
                          type="button"
                          onClick={() => startFolderRename(folderFilter)}
                        >
                          <Pencil aria-hidden="true" size={14} />
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                    size={16}
                  />
                  <TextInput
                    ref={searchInputRef}
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
                            aria-label={language === "zh-CN" ? "移动选中聊天到文件夹" : "Move selected chats to folder"}
                            className="flex items-center gap-1 rounded-md bg-sky-500/15 px-1.5 py-1 text-xs font-medium text-sky-200 transition-colors hover:bg-sky-500/25"
                            data-testid="chat-history-batch-folder"
                            disabled={loading}
                            title={language === "zh-CN" ? "移动到文件夹" : "Move to folder"}
                            type="button"
                            onClick={startBatchFolderEdit}
                          >
                            <Folder size={11} />
                            {selectedIds.size}
                          </button>
                        ) : null}
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
                                className="w-full rounded-md border border-white/[0.08] bg-ink-800/70 p-3 text-left transition-colors hover:border-ember-400/45 hover:bg-ember-500/[0.08]"
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
                          className="overflow-hidden rounded-md border border-white/[0.08] bg-ink-950/35"
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
                            <div className="space-y-0.5 border-t border-white/[0.06] px-1 pb-1 pt-1">
                              {group.chats.map((chat) => {
                                const isSelected = manageMode && selectedIds.has(chat.id);
                                const isCurrent = chatScope !== "trash" && selectedChatId === chat.id;

                                return (
                                  <div
                                    className={`group flex min-h-[54px] flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                                      chatScope === "trash" && !manageMode ? "cursor-default" : "cursor-pointer"
                                    } ${
                                      isSelected
                                        ? "bg-ember-500/15 text-ember-100"
                                        : isCurrent
                                          ? "bg-ember-500/[0.08] text-ember-100 shadow-[inset_2px_0_0_rgba(69,203,178,0.9)]"
                                          : "text-slate-400 hover:bg-white/[0.045] hover:text-slate-200 active:bg-white/[0.07]"
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
                                    <div className="min-w-0 flex-1 py-0.5">
                                      {renamingId === chat.id ? (
                                        <input
                                          ref={renameInputRef}
                                          className="w-full min-w-0 rounded bg-transparent px-1 py-0.5 text-sm text-slate-200 outline-none ring-1 ring-ember-500/50"
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
                                        <>
                                          <div className="flex min-w-0 items-center gap-2">
                                            <span
                                              className="min-w-0 flex-1 truncate font-medium text-slate-200"
                                              data-chat-history-title=""
                                            >
                                              {chat.title}
                                            </span>
                                            <time
                                              className="shrink-0 text-[11px] tabular-nums text-slate-600"
                                              data-testid="chat-history-activity"
                                              dateTime={
                                                chat.lastMessagePreview?.createdAt ?? chat.updatedAt
                                              }
                                            >
                                              {formatChatActivity(
                                                chat.lastMessagePreview?.createdAt ?? chat.updatedAt,
                                                language
                                              )}
                                            </time>
                                          </div>
                                          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4 text-slate-500">
                                            <span
                                              className="min-w-0 flex-1 truncate"
                                              data-testid="chat-history-preview"
                                            >
                                              {chat.lastMessagePreview
                                                ? `${t(
                                                    chat.lastMessagePreview.role === "assistant"
                                                      ? "chat.searchAssistant"
                                                      : "chat.searchUser"
                                                  )}: ${chat.lastMessagePreview.content}`
                                                : t("chat.historyNoMessages")}
                                            </span>
                                            <span className="shrink-0 tabular-nums">
                                              {t("chat.historyMessageCount", {
                                                count: chat.messageCount
                                              })}
                                            </span>
                                            {chat.folder ? (
                                              <span className="inline-flex min-w-0 shrink items-center gap-1 truncate text-slate-400">
                                                <Folder size={10} />
                                                <span className="truncate">{chat.folder}</span>
                                              </span>
                                            ) : null}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                    {!manageMode && renamingId !== chat.id ? (
                                      <button
                                        aria-expanded={actionMenuChatId === chat.id}
                                        aria-label={t("chat.moreActions")}
                                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors ${
                                          actionMenuChatId === chat.id
                                            ? "bg-white/[0.08] text-ember-200"
                                            : "text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
                                        }`}
                                        data-testid="chat-history-row-actions"
                                        title={t("chat.moreActions")}
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setActionMenuChatId((current) =>
                                            current === chat.id ? null : chat.id
                                          );
                                        }}
                                      >
                                        <MoreHorizontal size={15} />
                                      </button>
                                    ) : null}
                                    {actionMenuChatId === chat.id &&
                                    !manageMode &&
                                    renamingId !== chat.id ? (
                                      <div
                                        className="ml-5 grid basis-full grid-cols-2 gap-1 border-t border-white/[0.06] pt-1.5 sm:grid-cols-3"
                                        data-testid="chat-history-action-menu"
                                        onClick={(event) => event.stopPropagation()}
                                      >
                                        {chatScope !== "trash" && !chat.isArchived ? (
                                          <button
                                            aria-pressed={chat.isPinned}
                                            className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                            data-chat-action="pin"
                                            type="button"
                                            onClick={() => {
                                              setActionMenuChatId(null);
                                              void togglePin(chat);
                                            }}
                                          >
                                            <Pin
                                              fill={chat.isPinned ? "currentColor" : "none"}
                                              size={13}
                                            />
                                            <span className="truncate">
                                              {chat.isPinned ? t("chat.unpin") : t("chat.pin")}
                                            </span>
                                          </button>
                                        ) : null}
                                        {chatScope !== "trash" ? (
                                          <>
                                            <button
                                              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                              data-chat-action="archive"
                                              type="button"
                                              onClick={() => {
                                                setActionMenuChatId(null);
                                                void toggleArchive(chat);
                                              }}
                                            >
                                              {chat.isArchived ? (
                                                <ArchiveRestore size={13} />
                                              ) : (
                                                <Archive size={13} />
                                              )}
                                              <span className="truncate">
                                                {chat.isArchived
                                                  ? t("chat.unarchive")
                                                  : t("chat.archive")}
                                              </span>
                                            </button>
                                            <button
                                              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                              data-chat-action="folder"
                                              type="button"
                                              onClick={() => {
                                                setActionMenuChatId(null);
                                                startFolderEdit(chat);
                                              }}
                                            >
                                              <Folder size={13} />
                                              <span className="truncate">
                                                {chat.folder
                                                  ? language === "zh-CN"
                                                    ? "整理文件夹"
                                                    : "Organize folder"
                                                  : language === "zh-CN"
                                                    ? "加入文件夹"
                                                    : "Add to folder"}
                                              </span>
                                            </button>
                                            <button
                                              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                              data-chat-action="export-archive"
                                              type="button"
                                              onClick={() => {
                                                setActionMenuChatId(null);
                                                void exportChatArchive(chat);
                                              }}
                                            >
                                              <FileText size={13} />
                                              <span className="truncate">
                                                {t("chat.exportArchive")}
                                              </span>
                                            </button>
                                            <button
                                              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                              data-chat-action="rename"
                                              type="button"
                                              onClick={() => {
                                                setActionMenuChatId(null);
                                                startRename(chat);
                                              }}
                                            >
                                              <Pencil size={13} />
                                              <span className="truncate">{t("common.edit")}</span>
                                            </button>
                                            <button
                                              className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                                              data-chat-action="export-transcript"
                                              type="button"
                                              onClick={() => {
                                                setActionMenuChatId(null);
                                                void exportChatTranscript(chat);
                                              }}
                                            >
                                              <Download size={13} />
                                              <span className="truncate">
                                                {t("chat.exportMarkdownAction")}
                                              </span>
                                            </button>
                                          </>
                                        ) : (
                                          <button
                                            className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
                                            data-chat-action="restore"
                                            disabled={loading}
                                            type="button"
                                            onClick={() => {
                                              setActionMenuChatId(null);
                                              void restoreChat(chat);
                                            }}
                                          >
                                            <RotateCcw size={13} />
                                            <span className="truncate">
                                              {t("chat.restoreFromTrash")}
                                            </span>
                                          </button>
                                        )}
                                        <button
                                          className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-rose-300 transition-colors hover:bg-rose-500/10"
                                          data-chat-action={
                                            chatScope === "trash" ? "permanent-delete" : "trash"
                                          }
                                          type="button"
                                          onClick={() => {
                                            setActionMenuChatId(null);
                                            setPendingDeleteChat(chat);
                                          }}
                                        >
                                          <Trash2 size={13} />
                                          <span className="truncate">
                                            {chatScope === "trash"
                                              ? t("chat.permanentlyDelete")
                                              : t("chat.moveToTrash")}
                                          </span>
                                        </button>
                                      </div>
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

      {folderEditingChat
        ? createPortal(
            <Modal
              title={language === "zh-CN" ? "整理聊天文件夹" : "Organize Chat Folder"}
              onClose={() => setFolderEditingChat(null)}
            >
              <div className="space-y-4">
                <p className="text-sm leading-6 text-slate-400">
                  {language === "zh-CN"
                    ? "为这条对话输入文件夹名称；留空即可移回未分类。"
                    : "Enter a folder name for this chat. Leave it empty to move the chat back to Unfiled."}
                </p>
                <TextInput
                  aria-label={language === "zh-CN" ? "聊天文件夹名称" : "Chat folder name"}
                  autoFocus
                  maxLength={80}
                  placeholder={language === "zh-CN" ? "例如：主线剧情" : "For example: Main story"}
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveFolder();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <button
                    className="min-h-9 rounded-md px-3 text-sm font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                    type="button"
                    onClick={() => setFolderEditingChat(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="min-h-9 rounded-md bg-ember-500 px-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-ember-400 disabled:opacity-50"
                    disabled={loading}
                    type="button"
                    onClick={() => void saveFolder()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            </Modal>,
            document.body
          )
        : null}

      {folderEditingIds
        ? createPortal(
            <Modal
              title={language === "zh-CN" ? "批量整理聊天文件夹" : "Organize Selected Chats"}
              onClose={() => setFolderEditingIds(null)}
            >
              <div className="space-y-4">
                <p className="text-sm leading-6 text-slate-400">
                  {language === "zh-CN"
                    ? `将选中的 ${folderEditingIds.length} 条对话移动到同一文件夹；留空即可移回未分类。`
                    : `Move ${folderEditingIds.length} selected chat(s) to one folder. Leave it empty to move them back to Unfiled.`}
                </p>
                <TextInput
                  aria-label={language === "zh-CN" ? "目标聊天文件夹名称" : "Destination chat folder name"}
                  autoFocus
                  maxLength={80}
                  placeholder={language === "zh-CN" ? "例如：主线剧情" : "For example: Main story"}
                  value={folderDraft}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveBatchFolder();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <button
                    className="min-h-9 rounded-md px-3 text-sm font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                    type="button"
                    onClick={() => setFolderEditingIds(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="min-h-9 rounded-md bg-ember-500 px-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-ember-400 disabled:opacity-50"
                    disabled={loading}
                    type="button"
                    onClick={() => void saveBatchFolder()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            </Modal>,
            document.body
          )
        : null}

      {folderRenameFrom
        ? createPortal(
            <Modal
              title={language === "zh-CN" ? "重命名聊天文件夹" : "Rename Chat Folder"}
              onClose={() => setFolderRenameFrom(null)}
            >
              <div className="space-y-4">
                <p className="text-sm leading-6 text-slate-400">
                  {language === "zh-CN"
                    ? `将“${folderRenameFrom}”中的所有对话（含归档和回收站）移动到新名称；留空即可全部移回未分类。`
                    : `Move every chat in “${folderRenameFrom}”, including archived and trashed chats, to the new name. Leave it empty to move them all to Unfiled.`}
                </p>
                <TextInput
                  aria-label={language === "zh-CN" ? "新的聊天文件夹名称" : "New chat folder name"}
                  autoFocus
                  maxLength={80}
                  value={folderRenameDraft}
                  onChange={(event) => setFolderRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveFolderRename();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <button
                    className="min-h-9 rounded-md px-3 text-sm font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
                    type="button"
                    onClick={() => setFolderRenameFrom(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="min-h-9 rounded-md bg-ember-500 px-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-ember-400 disabled:opacity-50"
                    disabled={loading}
                    type="button"
                    onClick={() => void saveFolderRename()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            </Modal>,
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
