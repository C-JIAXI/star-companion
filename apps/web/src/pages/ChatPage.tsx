import {
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  StopCircle,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type {
  CharacterDTO,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  LoreEntryDTO,
  MessageDTO,
  TokenUsageDTO
} from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Panel, TextArea, TextInput } from "../components/ui";

export function ChatPage() {
  const { t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<ChatMode>("single");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
  const [matchedLoreEntries, setMatchedLoreEntries] = useState<LoreEntryDTO[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDTO | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatDTO | null>(null);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  const characterMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const getModeLabel = (chatMode: ChatMode) =>
    chatMode === "group" ? t("chat.mode.group") : t("chat.mode.single");

  const formatTokenUsage = (usage: TokenUsageDTO | null) => {
    if (!usage) {
      return t("chat.tokensUnavailable");
    }

    const detail = t("chat.tokensUsage", {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens
    });

    return usage.estimated ? `${detail} · ${t("chat.tokensEstimated")}` : detail;
  };

  const loadBase = async () => {
    const [characterData, chatData] = await Promise.all([api.characters.list(), api.chats.list()]);
    setCharacters(characterData);
    setChats(chatData);
    if (!selectedChatId && chatData[0]) {
      setSelectedChatId(chatData[0].id);
    }
  };

  const loadChat = async (id: string | null) => {
    if (!id) {
      setActiveChat(null);
      return;
    }
    setActiveChat(await api.chats.get(id));
  };

  useEffect(() => {
    void loadBase().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoad"))
    );
  }, [t]);

  useEffect(() => {
    void loadChat(selectedChatId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoadChat"))
    );
  }, [selectedChatId, t]);

  useEffect(
    () => () => {
      socketRef.current?.close();
    },
    []
  );

  const toggleCharacter = (id: string) => {
    setCharacterIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const createChat = async () => {
    setLoading(true);
    setError(null);
    setMatchedLoreEntries([]);
    try {
      const chat = await api.chats.create({
        title: title.trim(),
        mode,
        characterIds
      });
      setTitle("");
      setCharacterIds([]);
      setSelectedChatId(chat.id);
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedCreate"));
    } finally {
      setLoading(false);
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
      setSelectedChatId(null);
      setActiveChat(null);
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const upsertMessage = (message: MessageDTO) => {
    setActiveChat((current) => {
      if (!current || current.id !== message.chatId) {
        return current;
      }

      if (current.messages.some((item) => item.id === message.id)) {
        return {
          ...current,
          messages: current.messages.map((item) => (item.id === message.id ? message : item))
        };
      }

      return {
        ...current,
        messages: [...current.messages, message]
      };
    });
  };

  const getSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN) {
        resolve(existing);
        return;
      }

      existing?.close();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error(t("chat.websocketFailed")));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as GenerationServerMessage;

        if (message.type === "ready") {
          return;
        }

        if (message.type === "user_message") {
          upsertMessage(message.message);
          return;
        }

        if (message.type === "token") {
          setStreamingContent((current) => current + message.content);
          return;
        }

        if (message.type === "generation_character_started") {
          setStreamingCharacterId(message.characterId);
          setStreamingContent("");
          return;
        }

        if (message.type === "lore_matches") {
          setMatchedLoreEntries(message.entries);
          return;
        }

        if (message.type === "assistant_message") {
          upsertMessage(message.message);
          setStreamingContent("");
          setStreamingCharacterId(null);
          return;
        }

        if (message.type === "generation_done" || message.type === "generation_stopped") {
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
          setStreamingCharacterId(null);
          void loadChat(selectedChatId);
          void loadBase();
          return;
        }

        if (message.type === "error") {
          setError(message.error);
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
          setStreamingCharacterId(null);
        }
      };
    });

  const sendMessage = async () => {
    if (!activeChat || !draft.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setMatchedLoreEntries([]);
    try {
      const socket = await getSocket();
      const requestId = crypto.randomUUID();
      const payload: GenerationClientMessage = {
        type: "generate",
        requestId,
        chatId: activeChat.id,
        content: draft.trim()
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      setDraft("");
      socket.send(JSON.stringify(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
    } finally {
      // Loading ends when the WebSocket sends generation_done, generation_stopped, or error.
    }
  };

  const stopGeneration = () => {
    if (!activeRequestId || socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload: GenerationClientMessage = {
      type: "stop",
      requestId: activeRequestId
    };
    socketRef.current.send(JSON.stringify(payload));
  };

  const regenerateMessage = async (message: MessageDTO) => {
    if (message.role !== "assistant") {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const socket = await getSocket();
      const requestId = crypto.randomUUID();
      const payload: GenerationClientMessage = {
        type: "regenerate",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(message.characterId);
      socket.send(JSON.stringify(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRegenerate"));
      setLoading(false);
      setActiveRequestId(null);
    }
  };

  const copyMessage = async (message: MessageDTO) => {
    await navigator.clipboard.writeText(message.content);
  };

  const switchVariant = async (message: MessageDTO, direction: -1 | 1) => {
    if (message.variants.length <= 1) {
      return;
    }

    const nextIndex =
      (message.activeVariantIndex + direction + message.variants.length) % message.variants.length;
    const content = message.variants[nextIndex] ?? message.content;
    const updated = await api.messages.update(message.id, {
      content,
      activeVariantIndex: nextIndex
    });
    upsertMessage(updated);
  };

  const startEditingMessage = (message: MessageDTO) => {
    setEditingMessage(message);
    setEditDraft(message.content);
  };

  const cancelEditingMessage = () => {
    setEditingMessage(null);
    setEditDraft("");
  };

  const saveEditedMessage = async () => {
    if (!editingMessage) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const updated = await api.messages.update(editingMessage.id, { content: editDraft });
      upsertMessage(updated);
      cancelEditingMessage();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedEdit"));
    } finally {
      setLoading(false);
    }
  };

  const deleteMessage = async () => {
    if (!pendingDeleteMessage) {
      return;
    }

    await api.messages.remove(pendingDeleteMessage.id);
    await loadChat(pendingDeleteMessage.chatId);
    setPendingDeleteMessage(null);
  };

  return (
    <>
    <div className="grid min-w-0 gap-6 lg:h-[calc(100vh-112px)] lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)_300px]">
      <Panel
        title={t("chat.chats")}
        action={
          <Button variant="secondary" onClick={() => void loadBase()} className="!min-h-[32px] !h-8 !px-3 text-xs">
            <RefreshCw size={14} />
            {t("common.refresh")}
          </Button>
        }
      >
        <div className="h-[calc(100%-40px)] space-y-2 overflow-y-auto pr-1">
          <ErrorNotice message={error} />
          {chats.length === 0 ? (
            <EmptyState>{t("chat.noChats")}</EmptyState>
          ) : (
            chats.map((chat) => (
              <button
                className={`group w-full rounded-lg border p-3 text-left text-sm transition-all duration-200 ${
                  selectedChatId === chat.id
                    ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                    : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10"
                }`}
                key={chat.id}
                type="button"
                onClick={() => setSelectedChatId(chat.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate font-medium transition-colors ${selectedChatId === chat.id ? 'text-ember-100' : 'text-slate-100 group-hover:text-white'}`}>{chat.title}</p>
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${chat.mode === 'group' ? 'bg-indigo-400' : 'bg-emerald-400'}`}></span>
                      {getModeLabel(chat.mode)} <span className="opacity-50">·</span> {t("chat.boundCharacters", { count: chat.characterIds.length })}
                    </p>
                  </div>
                  <Button className="!h-8 !min-h-8 !w-8 !p-0 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" onClick={(event) => { event.stopPropagation(); setPendingDeleteChat(chat); }}>
                    <Trash2 size={14} className="text-rose-400" />
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </Panel>

      <Panel title={activeChat?.title ?? t("chat.messageStream")}>
        {!activeChat ? (
          <EmptyState>{t("chat.selectOrCreate")}</EmptyState>
        ) : (
          <div className="flex h-[calc(100%-40px)] min-h-0 flex-col">
            <div className="mb-4 flex shrink-0 flex-wrap gap-2 border-b border-white/5 pb-4">
              <Badge>{getModeLabel(activeChat.mode)}</Badge>
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
            </div>

            {matchedLoreEntries.length > 0 ? (
              <div className="mb-4 shrink-0 animate-fade-in rounded-xl border border-ember-500/20 bg-ember-500/5 p-4 shadow-inner">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ember-200 flex items-center gap-2">
                    <Sparkles size={14} />
                    {t("chat.loreMatches")}
                  </p>
                  <Badge>{matchedLoreEntries.length}</Badge>
                </div>
                <div className="space-y-2.5">
                  {matchedLoreEntries.map((entry) => (
                    <article className="rounded-lg bg-ink-950/50 p-3 text-xs text-slate-300" key={entry.id}>
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {entry.keys.map((key) => (
                          <Badge key={key}>{key}</Badge>
                        ))}
                        <Badge>{t("common.priority")} {entry.priority}</Badge>
                      </div>
                      <p className="line-clamp-2 leading-relaxed whitespace-pre-wrap opacity-90">{entry.content}</p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-white/5 bg-ink-950/30 p-4">
              {activeChat.messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <EmptyState>{t("chat.noMessages")}</EmptyState>
                </div>
              ) : (
                activeChat.messages.map((message) => (
                  <article
                    className={`group relative rounded-2xl p-4 text-sm shadow-sm transition-all hover:shadow-md ${
                      message.role === "user" 
                        ? "ml-auto max-w-[85%] bg-gradient-to-br from-ember-400 to-ember-500 text-ink-950 rounded-br-sm" 
                        : "mr-auto max-w-[85%] bg-ink-800/80 border border-white/5 text-slate-100 rounded-bl-sm backdrop-blur-sm"
                    }`}
                    key={message.id}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className={`text-xs font-bold tracking-wide ${message.role === "user" ? "text-ink-900/70" : "text-ember-400"}`}>
                        {message.characterId ? characterMap.get(message.characterId)?.name : message.role === "user" ? "You" : message.role}
                      </span>
                      <span className="flex flex-wrap justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        {message.role === "assistant" && message.variants.length > 1 ? (
                          <span className="mr-2 inline-flex items-center gap-1.5 text-xs bg-ink-950/40 rounded-full px-2 py-0.5">
                            <button className="rounded-full hover:bg-white/20 p-0.5 transition-colors" type="button" onClick={() => void switchVariant(message, -1)}><ChevronLeft size={13} /></button>
                            <span className="font-medium">{message.activeVariantIndex + 1}/{message.variants.length}</span>
                            <button className="rounded-full hover:bg-white/20 p-0.5 transition-colors" type="button" onClick={() => void switchVariant(message, 1)}><ChevronRight size={13} /></button>
                          </span>
                        ) : null}
                        <button className={`inline-flex items-center gap-1 text-xs font-medium hover:underline ${message.role === "user" ? "text-ink-900/70" : "text-slate-400 hover:text-slate-200"}`} type="button" onClick={() => void copyMessage(message)}><Copy size={12} />{t("common.copy")}</button>
                        {message.role === "assistant" ? (
                          <button disabled={Boolean(activeRequestId)} className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200 hover:underline disabled:opacity-40" type="button" onClick={() => void regenerateMessage(message)}><RotateCcw size={12} />{t("chat.regenerate")}</button>
                        ) : null}
                        <button className={`text-xs font-medium hover:underline ${message.role === "user" ? "text-ink-900/70" : "text-slate-400 hover:text-slate-200"}`} type="button" onClick={() => startEditingMessage(message)}>{t("common.edit")}</button>
                        <button className={`text-xs font-medium hover:underline ${message.role === "user" ? "text-ink-900/70" : "text-rose-400 hover:text-rose-300"}`} type="button" onClick={() => setPendingDeleteMessage(message)}>{t("common.delete")}</button>
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                    {message.role === "assistant" ? (
                      <p className="mt-3 border-t border-white/5 pt-2 text-[11px] text-slate-500 font-medium">
                        {formatTokenUsage(message.tokenUsage)}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
              {streamingContent ? (
                <article className="mr-auto max-w-[85%] rounded-2xl rounded-bl-sm border border-ember-500/20 bg-ink-800/80 p-4 text-sm text-slate-100 shadow-md animate-fade-in backdrop-blur-sm">
                  <div className="mb-2 text-xs font-bold tracking-wide text-ember-400 flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ember-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-ember-500"></span>
                    </span>
                    {streamingCharacterId
                      ? t("chat.streamingAs", {
                          name: characterMap.get(streamingCharacterId)?.name ?? t("common.unknown")
                        })
                      : t("chat.streaming")}
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{streamingContent}</p>
                </article>
              ) : null}
            </div>

            <div className="mt-3 grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-white/5 bg-ink-950/40 p-1.5 backdrop-blur-sm">
              <TextInput
                className="min-w-0 border-0 bg-transparent focus:bg-transparent focus:ring-0"
                placeholder={t("chat.writeMessage")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void sendMessage();
                  }
                }}
              />
              {activeRequestId ? (
                <Button className="!min-h-[38px]" variant="danger" onClick={stopGeneration}><StopCircle size={16} />{t("chat.stop")}</Button>
              ) : (
                <Button className="!min-h-[38px]" disabled={loading || !draft.trim()} onClick={() => void sendMessage()}><Send size={16} />{t("chat.send")}</Button>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title={t("chat.createChat")}
        action={<MessageSquarePlus size={16} className="text-slate-400" />}
      >
        <div className="space-y-3">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label={t("chat.mode")}>
            <select className="min-h-[40px] w-full rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50" value={mode} onChange={(event) => setMode(event.target.value as ChatMode)}>
              <option value="single">{t("chat.mode.single")}</option>
              <option value="group">{t("chat.mode.group")}</option>
            </select>
          </Field>
          <div className="space-y-2.5">
            <p className="text-sm font-medium text-slate-300">{t("nav.characters")}</p>
            {characters.length === 0 ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                {characters.map((character) => (
                  <label className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-all duration-200 hover:bg-white/10 ${characterIds.includes(character.id) ? 'border-ember-500/30 bg-ember-500/5' : 'border-white/5 bg-white/5'}`} key={character.id}>
                    <input checked={characterIds.includes(character.id)} type="checkbox" onChange={() => toggleCharacter(character.id)} className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
                    <span className={characterIds.includes(character.id) ? 'font-medium text-ember-100' : 'text-slate-200'}>{character.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button disabled={loading || !title.trim()} onClick={() => void createChat()} className="w-full">
            <MessageSquarePlus size={16} />
            {t("chat.createChat")}
          </Button>
        </div>
      </Panel>
    </div>
    {editingMessage ? (
      <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
        <section
          aria-labelledby="edit-message-title"
          className="animate-scale-in w-full max-w-2xl rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-slate-100" id="edit-message-title">
                {t("chat.editMessageTitle")}
              </h3>
              <p className="mt-1 text-sm text-slate-400">{t("chat.editMessageHelp")}</p>
            </div>
            <button
              aria-label={t("common.cancel")}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
              type="button"
              onClick={cancelEditingMessage}
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-6">
            <TextArea
              autoFocus
              className="min-h-[200px] text-base leading-relaxed"
              placeholder={t("chat.editMessagePlaceholder")}
              value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelEditingMessage();
              }

              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void saveEditedMessage();
              }
            }}
          />
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading} variant="ghost" onClick={cancelEditingMessage}>
              <X size={16} />
              {t("common.cancel")}
            </Button>
            <Button disabled={loading || !editDraft.trim()} onClick={() => void saveEditedMessage()}>
              <Check size={16} />
              {t("chat.saveEdit")}
            </Button>
          </div>
        </section>
      </div>
    ) : null}
    {pendingDeleteChat ? (
      <ConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        loading={loading}
        message={t("chat.deleteChatConfirm", { title: pendingDeleteChat.title })}
        title={t("chat.deleteChatTitle")}
        onCancel={() => setPendingDeleteChat(null)}
        onConfirm={() => void deleteChat()}
      />
    ) : null}
    {pendingDeleteMessage ? (
      <ConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        loading={loading}
        message={t("chat.deleteMessageConfirm")}
        title={t("chat.deleteMessageTitle")}
        onCancel={() => setPendingDeleteMessage(null)}
        onConfirm={() => void deleteMessage()}
      />
    ) : null}
    </>
  );
}
