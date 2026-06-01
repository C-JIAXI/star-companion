import {
  FileText,
  History,
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  Trash2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type { CharacterDTO, ChatDTO } from "../types";
import { ChatGroupHeader } from "./ChatGroupHeader";
import { ConfirmDialog, EmptyState, ErrorNotice, Modal, TextInput } from "./ui";

interface CharacterGroup {
  characterId: string;
  characterName: string;
  characterAvatar: string | null;
  chats: ChatDTO[];
}

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

  const activeChats = useMemo(() => chats.filter((chat) => chat.messageCount > 0), [chats]);

  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) {
      return activeChats;
    }
    const q = searchQuery.trim().toLowerCase();
    return activeChats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(q) ||
        characterCache
          .get(chat.characterId ?? "")
          ?.name.toLowerCase()
          .includes(q)
    );
  }, [activeChats, searchQuery, characterCache]);

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

    return [...map.values()].sort((a, b) => {
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
      onSelectChat(id);
      setOpen(false);
    },
    [manageMode, onSelectChat]
  );

  const handleOpen = () => {
    setSearchQuery("");
    setManageMode(false);
    setSelectedIds(new Set());
    void loadChats();
    setOpen(true);
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
      await api.chats.remove(pendingDeleteChat.id);
      setPendingDeleteChat(null);
      if (selectedChatId === pendingDeleteChat.id) {
        onSelectChat(null);
      }
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDelete"));
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
      await Promise.all(ids.map((id) => api.chats.remove(id)));
      if (selectedChatId && selectedIds.has(selectedChatId)) {
        onSelectChat(null);
      }
      setSelectedIds(new Set());
      setManageMode(false);
      await loadChats();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDelete"));
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
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                    size={16}
                  />
                  <TextInput
                    className={`pl-9 ${manageMode ? "pr-[180px]" : "pr-20"}`}
                    placeholder={
                      language === "zh-CN" ? "搜索历史对话..." : "Search chat history..."
                    }
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                  <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {manageMode && filteredChats.length > 0 ? (
                      <>
                        <button
                          className="rounded-md px-1.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
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
                            className="flex items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-1 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-500/25"
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
                    {filteredChats.length > 0 ? (
                      <button
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
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
                  {groups.length === 0 ? (
                    <div className="py-8 text-center">
                      <EmptyState>
                        {searchQuery.trim()
                          ? language === "zh-CN"
                            ? "没有匹配的对话"
                            : "No matching chats"
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
                                const isCurrent = selectedChatId === chat.id;

                                return (
                                  <div
                                    className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-all duration-200 min-h-[36px] ${
                                      isSelected
                                        ? "bg-ember-500/20 text-ember-100"
                                        : isCurrent
                                          ? "bg-white/5 text-ember-100"
                                          : "text-slate-400 hover:bg-white/5 hover:text-slate-200 active:bg-white/[0.08]"
                                    }`}
                                    key={chat.id}
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
                                      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                                    )}
                                    {!manageMode && renamingId !== chat.id ? (
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
                                    {!manageMode && renamingId !== chat.id ? (
                                      <button
                                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-500 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 active:bg-rose-500/25 transition-all"
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

                {filteredChats.length > 0 ? (
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
              confirmLabel={t("common.delete")}
              loading={loading}
              message={t("chat.deleteChatConfirm", { title: pendingDeleteChat.title })}
              title={t("chat.deleteChatTitle")}
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
              confirmLabel={t("common.delete")}
              loading={loading}
              message={
                language === "zh-CN"
                  ? `确定要删除选中的 ${selectedIds.size} 条对话吗？此操作不可撤销。`
                  : `Delete ${selectedIds.size} selected chat(s)? This cannot be undone.`
              }
              title={t("chat.deleteChatTitle")}
              onCancel={() => setBatchDeleteConfirm(false)}
              onConfirm={() => void batchDelete()}
            />,
            document.body
          )
        : null}
    </>
  );
}
