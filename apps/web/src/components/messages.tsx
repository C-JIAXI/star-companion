import { ChevronLeft, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
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
  if (renderHtml && containsRenderableHtml(content)) {
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
  return (
    <div
      data-testid="message-avatar"
      className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border text-xs font-bold shadow-md ${
        align === "right"
          ? "order-2 border-ember-300/40 bg-ink-950/20 text-ink-950 shadow-ember-500/10"
          : "order-1 border-white/10 bg-ink-800 text-ember-100 shadow-black/20"
      } ${className}`}
      title={name}
    >
      {avatar ? (
        <img alt="" className="h-full w-full object-cover" src={avatar} />
      ) : (
        <span className="truncate px-1">{name?.slice(0, 2) ?? "??"}</span>
      )}
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
  showAvatar ? "max-w-[calc(100%-3.25rem)] sm:max-w-[85%]" : "max-w-[85%]";

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
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink-950/40 px-2 py-0.5 text-[11px] sm:text-xs">
      <button className="rounded-full p-0.5 transition-colors hover:bg-white/20" type="button" onClick={onPrev}>
        <ChevronLeft size={13} />
      </button>
      <span className="font-medium">{currentIndex + 1}/{total}</span>
      <button className="rounded-full p-0.5 transition-colors hover:bg-white/20" type="button" onClick={onNext}>
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
    <div className="mt-3 border-t border-white/5 pt-2">
      <p className="text-[11px] font-medium text-slate-500">
        {formatter(usage)}
      </p>
      {lorebooks && lorebooks.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-slate-500">{t("chat.triggeredLore")}</span>
          {lorebooks.map((book) => (
            <span
              className="inline-flex max-w-full items-center rounded-full border border-ember-500/20 bg-ember-500/10 px-2 py-0.5 text-[11px] font-medium text-ember-200"
              key={book.id}
            >
              <span className="truncate">{book.name}</span>
              {book.count > 1 ? <span className="ml-1 text-ember-200/70">x{book.count}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
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
  onDelete
}: {
  message: MessageDTO;
  showAvatar: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  return (
    <div className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}>
      <article className={`order-1 relative ${bubbleWidthClassName} rounded-2xl rounded-br-sm bg-gradient-to-br from-ember-400 to-ember-500 p-4 text-sm text-ink-950 shadow-sm`}>
        <div className="mb-3 flex items-center justify-end gap-1.5 text-[11px] opacity-100 sm:mb-2 sm:text-xs">
          <button className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-ink-900/70 hover:underline" type="button" onClick={onCopy}>
            <Copy size={12} />{t("common.copy")}
          </button>
          <button className="whitespace-nowrap font-medium text-ink-900/70 hover:underline" type="button" onClick={onEdit}>
            {t("common.edit")}
          </button>
          <button className="whitespace-nowrap font-medium text-ink-900/70 hover:underline" type="button" onClick={onDelete}>
            {t("common.delete")}
          </button>
        </div>
        <MessageBody align="right" content={message.content} renderHtml={false} />
      </article>
      <AvatarSlot align="right" className="order-2" name="You" showAvatar={showAvatar} />
    </div>
  );
}

export function AssistantMessageBubble({
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
  disableRegenerate: boolean;
}) {
  const { t } = useI18n();
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  return (
    <div className={`flex items-start justify-start ${showAvatar ? "gap-3" : "gap-0"}`}>
      <AvatarSlot avatar={avatar} showAvatar={showAvatar} />
      <article className={`order-1 relative ${bubbleWidthClassName} rounded-2xl rounded-bl-sm border border-white/5 bg-ink-800/80 p-4 text-sm text-slate-100 shadow-sm backdrop-blur-sm`}>
        <div className="mb-3 flex flex-wrap items-center justify-start gap-1.5 text-[11px] opacity-100 sm:mb-2 sm:text-xs">
          {message.variants.length > 1 ? (
            <VariantSwitcher
              currentIndex={message.activeVariantIndex}
              total={message.variants.length}
              onPrev={onVariantPrev}
              onNext={onVariantNext}
            />
          ) : null}
          <button className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 hover:underline" type="button" onClick={onCopy}>
            <Copy size={12} />{t("common.copy")}
          </button>
          <button className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 hover:underline disabled:opacity-40" type="button" disabled={disableRegenerate} onClick={onRegenerate}>
            <RotateCcw size={12} />{t("chat.regenerate")}
          </button>
          <button className="whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 hover:underline" type="button" onClick={onEdit}>
            {t("common.edit")}
          </button>
          <button className="whitespace-nowrap font-medium text-rose-400 hover:text-rose-300 hover:underline" type="button" onClick={onDelete}>
            {t("common.delete")}
          </button>
        </div>
        <MessageBody content={message.content} htmlCss={htmlCss} />
        <TokenInfo usage={message.tokenUsage} formatter={tokenUsageFormatter} lorebooks={triggeredLorebooks} />
      </article>
    </div>
  );
}

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
    <div className={`flex items-start justify-start ${showAvatar ? "gap-3" : "gap-0"}`}>
      <AvatarSlot avatar={characterAvatar} showAvatar={showAvatar} />
      <article className={`order-1 ${bubbleWidthClassName} animate-fade-in rounded-2xl rounded-bl-sm border border-ember-500/20 bg-ink-800/80 p-4 text-sm text-slate-100 shadow-md backdrop-blur-sm`}>
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
    </div>
  );
}
