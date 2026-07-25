import {
  Archive,
  ChevronRight,
  CornerUpLeft,
  GitBranch,
  MessageSquareText,
  RefreshCw,
  Save
} from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../i18n";
import type { ChatDTO, ChatWithMessagesDTO } from "../types";
import { Button } from "./ui";

const compactMessage = (content: string) => {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

export function ChatStoryNavigator({
  activeChat,
  chats,
  loading,
  error,
  onNavigate,
  onReturnToParent,
  onRetry
}: {
  activeChat: ChatWithMessagesDTO;
  chats: ChatDTO[];
  loading: boolean;
  error: string | null;
  onNavigate: (chatId: string) => void;
  onReturnToParent: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const { path, children } = useMemo(() => {
    const availableChats = chats.filter((chat) => !chat.deletedAt);
    const chatsById = new Map(availableChats.map((chat) => [chat.id, chat]));
    chatsById.set(activeChat.id, activeChat);

    const ancestors: ChatDTO[] = [];
    const visited = new Set<string>([activeChat.id]);
    let cursor: ChatDTO = activeChat;

    while (cursor.parentChatId && !visited.has(cursor.parentChatId)) {
      const parent = chatsById.get(cursor.parentChatId);
      if (!parent) {
        break;
      }
      ancestors.unshift(parent);
      visited.add(parent.id);
      cursor = parent;
    }

    return {
      path: [...ancestors, activeChat],
      children: availableChats
        .filter((chat) => chat.parentChatId === activeChat.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    };
  }, [activeChat, chats]);

  const messageIndexes = useMemo(
    () => new Map(activeChat.messages.map((message, index) => [message.id, index])),
    [activeChat.messages]
  );
  const messagesById = useMemo(
    () => new Map(activeChat.messages.map((message) => [message.id, message])),
    [activeChat.messages]
  );

  if (loading) {
    return (
      <div
        className="flex min-h-44 items-center justify-center gap-3 text-sm text-slate-400"
        data-testid="chat-story-loading"
      >
        <RefreshCw className="animate-spin text-ember-300" size={17} />
        {t("chat.storyLoading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center gap-4 text-center">
        <p className="max-w-sm text-sm leading-6 text-rose-300">{error}</p>
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw size={15} />
          {t("common.refresh")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="chat-story-navigator">
      <p className="text-sm leading-6 text-slate-400">{t("chat.storyPathsHelp")}</p>

      <section aria-labelledby="chat-story-path-heading">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4
            className="text-xs font-semibold uppercase text-slate-500"
            id="chat-story-path-heading"
          >
            {t("chat.storyPath")}
          </h4>
          <span className="text-xs text-slate-600">{path.length}</span>
        </div>
        <div className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
          {path.map((chat, index) => {
            const isCurrent = chat.id === activeChat.id;
            const isImmediateParent = chat.id === activeChat.parentChatId;
            const Icon = chat.isCheckpoint ? Save : chat.parentChatId ? GitBranch : MessageSquareText;

            return (
              <div className="flex items-center gap-2" key={chat.id}>
                <button
                  className={`flex min-h-12 min-w-0 flex-1 items-center gap-3 px-1 py-2 text-left transition-colors ${
                    isCurrent
                      ? "cursor-default text-ember-100"
                      : "text-slate-300 hover:text-white"
                  }`}
                  data-chat-id={chat.id}
                  data-testid="chat-story-path-node"
                  disabled={isCurrent}
                  type="button"
                  onClick={() => {
                    if (isImmediateParent) {
                      onReturnToParent();
                    } else {
                      onNavigate(chat.id);
                    }
                  }}
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                      isCurrent
                        ? "bg-ember-500/15 text-ember-300"
                        : "bg-white/[0.04] text-slate-500"
                    }`}
                  >
                    <Icon size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{chat.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span>
                        {chat.isCheckpoint
                          ? t("chat.checkpoint")
                          : chat.parentChatId
                            ? t("chat.storyBranch")
                            : t("chat.storyRoot")}
                      </span>
                      {isCurrent ? <span className="text-ember-300">{t("chat.storyCurrent")}</span> : null}
                      {chat.isArchived ? (
                        <span className="inline-flex items-center gap-1 text-slate-500">
                          <Archive size={11} />
                          {t("chat.storyArchived")}
                        </span>
                      ) : null}
                      {isImmediateParent ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300/80">
                          <CornerUpLeft size={11} />
                          {t("chat.storyReturnToSource")}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                {index < path.length - 1 ? (
                  <ChevronRight className="shrink-0 text-slate-700" size={14} />
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="chat-story-children-heading">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4
            className="text-xs font-semibold uppercase text-slate-500"
            id="chat-story-children-heading"
          >
            {t("chat.storyChildren")}
          </h4>
          <span className="text-xs text-slate-600">{children.length}</span>
        </div>

        {children.length === 0 ? (
          <div className="border-y border-dashed border-white/[0.08] py-7 text-center text-sm text-slate-500">
            {t("chat.storyNoChildren")}
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
            {children.map((chat) => {
              const sourceIndex =
                chat.branchSourceMessageId === null
                  ? undefined
                  : messageIndexes.get(chat.branchSourceMessageId);
              const sourceMessage =
                chat.branchSourceMessageId === null
                  ? undefined
                  : messagesById.get(chat.branchSourceMessageId);
              const Icon = chat.isCheckpoint ? Save : GitBranch;

              return (
                <button
                  className="flex min-h-14 w-full items-center gap-3 px-1 py-2.5 text-left text-slate-300 transition-colors hover:text-white"
                  data-chat-id={chat.id}
                  data-testid="chat-story-child"
                  key={chat.id}
                  type="button"
                  onClick={() => onNavigate(chat.id)}
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                      chat.isCheckpoint
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "bg-ember-500/10 text-ember-300"
                    }`}
                  >
                    <Icon size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{chat.title}</span>
                      {chat.isArchived ? <Archive className="shrink-0 text-slate-600" size={12} /> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {sourceIndex === undefined
                        ? t("chat.storySourceUnknown")
                        : `${t("chat.storyFromMessage", { index: sourceIndex + 1 })}${
                            sourceMessage?.content
                              ? ` · ${compactMessage(sourceMessage.content)}`
                              : ""
                          }`}
                    </span>
                  </span>
                  <ChevronRight className="shrink-0 text-slate-700" size={14} />
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
