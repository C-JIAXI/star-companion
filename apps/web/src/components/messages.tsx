import { AlertTriangle, Bug, ChevronLeft, ChevronRight, CircleX, Copy, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Marked } from "marked";
import { memo, useCallback, useMemo } from "react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePlaceholderSrc } from "../placeholderImages";
import type { MessageDTO, TokenUsageDTO } from "../types";
import { ScopedHtmlRenderer, containsRenderableHtml } from "./ScopedHtmlRenderer";

type TokenUsageFormatter = (usage: TokenUsageDTO | null) => string;

type TriggeredLorebook = {
  id: string;
  name: string;
  keys: Set<string>;
  count: number;
};

const FLUSH_INTERVAL_MS = 40;

const MARKDOWN_PATTERN = /(?:^|\n)```/;

function renderMarkdown(content: string): string {
  const renderer = {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang || "";
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div class="roleplay-code-block"><div class="roleplay-code-header"><span class="roleplay-code-lang-text">${language}</span><button class="roleplay-code-copy" aria-label="Copy code">Copy</button></div><pre><code class="language-${language}">${escaped}</code></pre></div>`;
    }
  };

  const instance = new Marked({ renderer, breaks: true });
  return instance.parse(content) as string;
}

function MessageBody({
  content,
  htmlCss,
  align = "left",
  renderHtml = true
}: {
  content: string;
  htmlCss?: string;
  align?: "left" | "right";
  renderHtml?: boolean;
}) {
  const hasMarkdown = MARKDOWN_PATTERN.test(content);
  const hasHtml = renderHtml && containsRenderableHtml(content);

  const renderedContent = useMemo(() => {
    if (hasMarkdown) {
      return renderMarkdown(content);
    }
    return null;
  }, [content, hasMarkdown]);

  if (renderedContent !== null) {
    return <ScopedHtmlRenderer content={renderedContent} htmlCss={htmlCss} />;
  }

  if (hasHtml) {
    return <ScopedHtmlRenderer content={content} htmlCss={htmlCss} />;
  }

  return (
    <p className={`whitespace-pre-wrap leading-relaxed ${align === "right" ? "text-right" : "text-left"}`}>
      {content}
    </p>
  );
}

function Avatar({
  avatar,
  name,
  align = "left",
  className = ""
}: {
  avatar?: string | null;
  name?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const src = usePlaceholderSrc(avatar, name);
  return (
    <div
      data-testid="message-avatar"
      className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border shadow-md ${
        align === "right"
          ? "order-2 border-ember-300/40 bg-ink-950/20 shadow-ember-500/10"
          : "order-1 border-white/10 bg-ink-800 shadow-black/20"
      } ${className}`}
      title={name}
    >
      <img
        alt=""
        className="h-full w-full object-cover"
        src={src}
      />
    </div>
  );
}

function AvatarSlot({
  showAvatar,
  avatar,
  name,
  align = "left",
  className = ""
}: {
  showAvatar: boolean;
  avatar?: string | null;
  name?: string;
  align?: "left" | "right";
  className?: string;
}) {
  if (!showAvatar) {
    return null;
  }

  return <Avatar avatar={avatar} name={name} align={align} className={className} />;
}

const getBubbleWidthClassName = (showAvatar: boolean) =>
  showAvatar ? "max-w-[calc(100%-3.25rem)]" : "max-w-full";

function VariantSwitcher({
  currentIndex,
  total,
  onPrev,
  onNext
}: {
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink-950/40 px-2 py-0.5 text-xs">
      <button className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full transition-colors hover:bg-white/20 active:bg-white/30" type="button" onClick={onPrev}>
        <ChevronLeft size={13} />
      </button>
      <span className="font-medium">{currentIndex + 1}/{total}</span>
      <button className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full transition-colors hover:bg-white/20 active:bg-white/30" type="button" onClick={onNext}>
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

function TokenInfo({
  usage,
  formatter,
  lorebooks
}: {
  usage: TokenUsageDTO | null;
  formatter: TokenUsageFormatter;
  lorebooks?: TriggeredLorebook[];
}) {
  const { t } = useI18n();

  return (
    <>
      <p className="text-xs font-medium text-slate-500">
        {formatter(usage)}
      </p>
      {lorebooks && lorebooks.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500">{t("chat.triggeredLore")}</span>
          {lorebooks.map((book) => (
            <span
              className="inline-flex max-w-full items-center rounded-full border border-ember-500/20 bg-ember-500/10 px-2 py-0.5 text-xs font-medium text-ember-200"
              key={book.id}
            >
              <span className="truncate">{book.name}</span>
              {book.count > 1 ? <span className="ml-1 text-ember-200/70">x{book.count}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function SystemNotification({ content }: { content: string }) {
  return (
    <div className="flex justify-center">
      <div className="shrink-0 rounded-full bg-white/5 px-4 py-1.5 text-xs text-slate-500 select-none">
        {content}
      </div>
    </div>
  );
}

export function UserMessageBubble({
  message,
  showAvatar,
  onCopy,
  onEdit,
  onDelete,
  onResend
}: {
  message: MessageDTO;
  showAvatar: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onResend: () => void;
}) {
  const { t } = useI18n();
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  return (
    <div className={`flex items-start justify-start ${showAvatar ? "gap-3" : "gap-0"}`}>
      <AvatarSlot align="left" name="You" showAvatar={showAvatar} />
      <article className={`order-1 relative ${bubbleWidthClassName} rounded-2xl rounded-bl-sm bg-gradient-to-br from-ember-400 to-ember-500 p-3 sm:p-4 text-sm text-ink-950 shadow-sm`}>
        <MessageBody align="left" content={message.content} renderHtml={false} />
        <div className="mt-3 flex items-center justify-start gap-0.5 text-xs">
          <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70" type="button" onClick={onResend} title={t("chat.resend")}>
            <RotateCcw size={14} />
          </button>
          <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70" type="button" onClick={onCopy} title={t("common.copy")}>
            <Copy size={14} />
          </button>
          <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70" type="button" onClick={onEdit} title={t("common.edit")}>
            <Pencil size={14} />
          </button>
          <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70" type="button" onClick={onDelete} title={t("common.delete")}>
            <Trash2 size={14} />
          </button>
        </div>
      </article>
    </div>
  );
}

export const AssistantMessageBubble = memo(function AssistantMessageBubble({
  message,
  avatar,
  showAvatar,
  htmlCss,
  tokenUsageFormatter,
  triggeredLorebooks,
  onCopy,
  onRegenerate,
  onEdit,
  onDelete,
  onVariantPrev,
  onVariantNext,
  onDebug,
  disableRegenerate
}: {
  message: MessageDTO;
  avatar?: string | null;
  showAvatar: boolean;
  htmlCss?: string;
  tokenUsageFormatter: TokenUsageFormatter;
  triggeredLorebooks: TriggeredLorebook[];
  onCopy: () => void;
  onRegenerate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onVariantPrev: () => void;
  onVariantNext: () => void;
  onDebug: (message: MessageDTO) => void;
  disableRegenerate: boolean;
}) {
  const { t } = useI18n();
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);
  const handleDebug = useCallback(() => onDebug(message), [onDebug, message]);

  return (
    <div className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}>
      <article className={`order-1 relative self-start ${bubbleWidthClassName} overflow-hidden rounded-2xl rounded-br-sm border border-white/5 bg-ink-800/80 p-3 sm:p-4 text-sm text-slate-100 shadow-sm backdrop-blur-sm`}>
        <MessageBody content={message.content} htmlCss={htmlCss} />
        <div className="mt-3 border-t border-white/5 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-1 sm:gap-1.5 text-xs">
            <TokenInfo usage={message.tokenUsage} formatter={tokenUsageFormatter} lorebooks={triggeredLorebooks} />
            <div className="flex shrink-0 flex-wrap items-center gap-0.5">
              {message.variants.length > 1 ? (
                <VariantSwitcher
                  currentIndex={message.activeVariantIndex}
                  total={message.variants.length}
                  onPrev={onVariantPrev}
                  onNext={onVariantNext}
                />
              ) : null}
              <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100" type="button" onClick={onCopy} title={t("common.copy")}>
                <Copy size={14} />
              </button>
              <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40 active:text-slate-100" type="button" disabled={disableRegenerate} onClick={onRegenerate} title={t("chat.regenerate")}>
                <RotateCcw size={14} />
              </button>
              <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100" type="button" onClick={handleDebug} title={t("debug.open")}>
                <Bug size={14} />
              </button>
              <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100" type="button" onClick={onEdit} title={t("common.edit")}>
                <Pencil size={14} />
              </button>
              <button className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-400 hover:text-rose-300 active:text-rose-200" type="button" onClick={onDelete} title={t("common.delete")}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      </article>
      <AvatarSlot avatar={avatar} className="order-2" showAvatar={showAvatar} />
    </div>
  );
});

export function StreamingBubble({
  characterAvatar,
  showAvatar,
  htmlCss,
  content
}: {
  characterAvatar?: string | null;
  showAvatar: boolean;
  htmlCss?: string;
  content: string;
}) {
  const [displayedContent, setDisplayedContent] = useState("");
  const bufferRef = useRef("");
  const displayedLengthRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  useEffect(() => {
    if (content.length > displayedLengthRef.current) {
      bufferRef.current += content.slice(displayedLengthRef.current);
      displayedLengthRef.current = content.length;
    }
  }, [content]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (bufferRef.current) {
        setDisplayedContent((prev) => prev + bufferRef.current);
        bufferRef.current = "";
      }
    }, FLUSH_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  return (
    <div className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}>
      <article className={`order-1 self-start ${bubbleWidthClassName} animate-fade-in overflow-hidden rounded-2xl rounded-br-sm border border-ember-500/20 bg-ink-800/80 p-3 sm:p-4 text-sm text-slate-100 shadow-md backdrop-blur-sm`}>
        {displayedContent ? (
          <MessageBody content={displayedContent} htmlCss={htmlCss} />
        ) : (
          <div className="flex items-center gap-1 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:0ms]"></span>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:150ms]"></span>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:300ms]"></span>
          </div>
        )}
      </article>
      <AvatarSlot avatar={characterAvatar} className="order-2" showAvatar={showAvatar} />
    </div>
  );
}

export function ErrorBubble({
  characterAvatar,
  showAvatar,
  error,
  onRetry,
  onDismiss
}: {
  characterAvatar?: string | null;
  showAvatar: boolean;
  error: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  return (
    <div className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}>
      <article className={`order-1 self-start ${bubbleWidthClassName} animate-fade-in overflow-hidden rounded-2xl rounded-br-sm border border-rose-500/30 bg-rose-950/30 p-3 sm:p-4 text-sm text-rose-200 shadow-md backdrop-blur-sm`}>
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-400" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-rose-300">{t("chat.generationFailed")}</p>
            <p className="mt-1 break-words text-xs text-rose-300/80">{error}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-0.5 border-t border-rose-500/15 pt-2 text-xs">
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-300 hover:text-rose-100 active:text-rose-50"
            type="button"
            onClick={onRetry}
            title={t("chat.retry")}
          >
            <RotateCcw size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-300/60 hover:text-rose-200 active:text-rose-100"
            type="button"
            onClick={onDismiss}
            title={t("common.cancel")}
          >
            <CircleX size={14} />
          </button>
        </div>
      </article>
      <AvatarSlot avatar={characterAvatar} className="order-2" showAvatar={showAvatar} />
    </div>
  );
}
