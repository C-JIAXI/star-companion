import {
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
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
    <div className="grid gap-4 lg:grid-cols-[300px_1fr_300px]">
      <Panel title={t("chat.chats")} action={<Button variant="ghost" onClick={() => void loadBase()}><RefreshCw size={16} />{t("common.refresh")}</Button>}>
        <div className="space-y-3">
          <ErrorNotice message={error} />
          {chats.length === 0 ? (
            <EmptyState>{t("chat.noChats")}</EmptyState>
          ) : (
            chats.map((chat) => (
              <button
                className={`w-full rounded-md border p-3 text-left text-sm transition ${
                  selectedChatId === chat.id
                    ? "border-ember-500 bg-ember-500/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
                key={chat.id}
                type="button"
                onClick={() => setSelectedChatId(chat.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-100">{chat.title}</p>
                    <p className="mt-1 text-xs text-slate-400">{getModeLabel(chat.mode)} · {t("chat.boundCharacters", { count: chat.characterIds.length })}</p>
                  </div>
                  <Button className="min-h-8 px-2" variant="ghost" onClick={(event) => { event.stopPropagation(); setPendingDeleteChat(chat); }}>
                    <Trash2 size={14} />
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
          <div className="flex min-h-[520px] flex-col">
            <div className="flex flex-wrap gap-2 pb-3">
              <Badge>{getModeLabel(activeChat.mode)}</Badge>
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
            </div>

            {matchedLoreEntries.length > 0 ? (
              <div className="mb-3 rounded-md border border-ember-500/30 bg-ember-500/10 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ember-100">{t("chat.loreMatches")}</p>
                  <Badge>{matchedLoreEntries.length}</Badge>
                </div>
                <div className="space-y-2">
                  {matchedLoreEntries.map((entry) => (
                    <article className="rounded-md bg-ink-950/80 p-2 text-xs text-slate-300" key={entry.id}>
                      <div className="mb-1 flex flex-wrap gap-1">
                        {entry.keys.map((key) => (
                          <Badge key={key}>{key}</Badge>
                        ))}
                        <Badge>{t("common.priority")} {entry.priority}</Badge>
                      </div>
                      <p className="line-clamp-2 whitespace-pre-wrap">{entry.content}</p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex-1 space-y-3 overflow-y-auto rounded-md bg-ink-950 p-3">
              {activeChat.messages.length === 0 ? (
                <EmptyState>{t("chat.noMessages")}</EmptyState>
              ) : (
                activeChat.messages.map((message) => (
                  <article
                    className={`rounded-md p-3 text-sm ${
                      message.role === "user" ? "ml-auto max-w-[85%] bg-ember-500 text-ink-950" : "mr-auto max-w-[85%] bg-white/10 text-slate-100"
                    }`}
                    key={message.id}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold opacity-80">
                        {message.characterId ? characterMap.get(message.characterId)?.name : message.role}
                      </span>
                      <span className="flex flex-wrap justify-end gap-1">
                        {message.role === "assistant" && message.variants.length > 1 ? (
                          <span className="mr-1 inline-flex items-center gap-1 text-xs opacity-80">
                            <button className="rounded bg-white/10 p-0.5" type="button" onClick={() => void switchVariant(message, -1)}><ChevronLeft size={13} /></button>
                            {message.activeVariantIndex + 1}/{message.variants.length}
                            <button className="rounded bg-white/10 p-0.5" type="button" onClick={() => void switchVariant(message, 1)}><ChevronRight size={13} /></button>
                          </span>
                        ) : null}
                        <button className="inline-flex items-center gap-1 text-xs underline opacity-80" type="button" onClick={() => void copyMessage(message)}><Copy size={12} />{t("common.copy")}</button>
                        {message.role === "assistant" ? (
                          <button disabled={Boolean(activeRequestId)} className="inline-flex items-center gap-1 text-xs underline opacity-80 disabled:opacity-40" type="button" onClick={() => void regenerateMessage(message)}><RotateCcw size={12} />{t("chat.regenerate")}</button>
                        ) : null}
                        <button className="text-xs underline opacity-80" type="button" onClick={() => startEditingMessage(message)}>{t("common.edit")}</button>
                        <button className="text-xs underline opacity-80" type="button" onClick={() => setPendingDeleteMessage(message)}>{t("common.delete")}</button>
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    {message.role === "assistant" ? (
                      <p className="mt-3 border-t border-white/10 pt-2 text-xs text-slate-400">
                        {formatTokenUsage(message.tokenUsage)}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
              {streamingContent ? (
                <article className="mr-auto max-w-[85%] rounded-md bg-white/10 p-3 text-sm text-slate-100">
                  <div className="mb-2 text-xs font-semibold opacity-80">
                    {streamingCharacterId
                      ? t("chat.streamingAs", {
                          name: characterMap.get(streamingCharacterId)?.name ?? t("common.unknown")
                        })
                      : t("chat.streaming")}
                  </div>
                  <p className="whitespace-pre-wrap">{streamingContent}</p>
                </article>
              ) : null}
            </div>

            <div className="mt-3 flex gap-2">
              <TextInput
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
                <Button variant="danger" onClick={stopGeneration}><StopCircle size={16} />{t("chat.stop")}</Button>
              ) : (
                <Button disabled={loading || !draft.trim()} onClick={() => void sendMessage()}><Send size={16} />{t("chat.send")}</Button>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title={t("chat.createChat")} action={<MessageSquarePlus size={18} className="text-ember-400" />}>
        <div className="space-y-3">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label={t("chat.mode")}>
            <select className="min-h-10 rounded-md border border-white/10 bg-ink-950 px-3 text-sm" value={mode} onChange={(event) => setMode(event.target.value as ChatMode)}>
              <option value="single">{t("chat.mode.single")}</option>
              <option value="group">{t("chat.mode.group")}</option>
            </select>
          </Field>
          <div className="space-y-2">
            <p className="text-sm text-slate-300">{t("nav.characters")}</p>
            {characters.length === 0 ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : (
              characters.map((character) => (
                <label className="flex cursor-pointer items-center gap-2 rounded-md bg-white/5 px-3 py-2 text-sm" key={character.id}>
                  <input checked={characterIds.includes(character.id)} type="checkbox" onChange={() => toggleCharacter(character.id)} />
                  {character.name}
                </label>
              ))
            )}
          </div>
          <Button disabled={loading || !title.trim()} onClick={() => void createChat()}><MessageSquarePlus size={16} />{t("chat.createChat")}</Button>
        </div>
      </Panel>
    </div>
    {editingMessage ? (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
        <section
          aria-labelledby="edit-message-title"
          className="w-full max-w-2xl rounded-lg border border-white/10 bg-ink-900 p-4 shadow-2xl shadow-black/40"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-100" id="edit-message-title">
                {t("chat.editMessageTitle")}
              </h3>
              <p className="mt-1 text-xs text-slate-400">{t("chat.editMessageHelp")}</p>
            </div>
            <button
              aria-label={t("common.cancel")}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/5 text-slate-300 hover:bg-white/10"
              type="button"
              onClick={cancelEditingMessage}
            >
              <X size={16} />
            </button>
          </div>

          <TextArea
            autoFocus
            className="mt-4 min-h-48"
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

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button disabled={loading} variant="ghost" onClick={cancelEditingMessage}>
              <X size={16} />
              {t("common.cancel")}
            </Button>
            <Button disabled={loading} onClick={() => void saveEditedMessage()}>
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
