import {
  AlertTriangle,
  Bookmark,
  Bug,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  ListTree,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
  Volume2,
  VolumeX,
  WandSparkles
} from "lucide-react";
import { Marked } from "marked";
import { memo, useCallback, useMemo } from "react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { usePlaceholderSrc } from "../placeholderImages";
import type { MessageDTO, TokenUsageDTO } from "../types";
import { ScopedHtmlRenderer, containsRenderableHtml } from "./ScopedHtmlRenderer";
import { ChatImageGallery } from "./ChatImageGallery";

type TokenUsageFormatter = (usage: TokenUsageDTO | null) => string;

const FLUSH_INTERVAL_MS = 40;

const MARKDOWN_PATTERN = /(?:^|\n)```/;

function renderMarkdown(content: string): string {
  const renderer = {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang || "";
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    <p
      className={`whitespace-pre-wrap leading-relaxed ${align === "right" ? "text-right" : "text-left"}`}
    >
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
      data-chat-avatar=""
      data-testid="message-avatar"
      className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border ${
        align === "right"
          ? "order-2 border-ember-300/35 bg-ink-950/20"
          : "order-1 border-white/10 bg-ink-800"
      } ${className}`}
      title={name}
    >
      <img alt="" className="h-full w-full object-cover" src={src} />
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
      <button
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full transition-colors hover:bg-white/20 active:bg-white/30"
        data-chat-action="variant-prev"
        type="button"
        onClick={onPrev}
      >
        <ChevronLeft size={13} />
      </button>
      <span className="font-medium">
        {currentIndex + 1}/{total}
      </span>
      <button
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-full transition-colors hover:bg-white/20 active:bg-white/30"
        data-chat-action="variant-next"
        type="button"
        onClick={onNext}
      >
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

function TokenInfo({
  usage,
  metadata,
  formatter
}: {
  usage: TokenUsageDTO | null;
  metadata: MessageDTO["generationMetadata"];
  formatter: TokenUsageFormatter;
}) {
  return (
    <p className="text-xs font-medium text-slate-500" data-chat-token-info="" title={metadata ? `${metadata.providerId}/${metadata.modelId} · ${metadata.estimatedCostMicros == null ? "Cost unknown" : `Estimated $${(metadata.estimatedCostMicros / 1_000_000).toFixed(4)}`}` : undefined}>
      {formatter(usage)}{metadata ? ` · ${metadata.modelId} · ${metadata.estimatedCostMicros == null ? "cost unknown" : `est. $${(metadata.estimatedCostMicros / 1_000_000).toFixed(4)}`}${metadata.usedFallback ? " · fallback" : ""}${metadata.incomplete ? " · incomplete" : ""}` : " · historical generation data unavailable"}
    </p>
  );
}

function ContextInfo({
  loreCount,
  memoryCount,
  promptTokens,
  onClick
}: {
  loreCount: number;
  memoryCount: number;
  promptTokens?: number;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const hasContext = loreCount > 0 || memoryCount > 0;
  const label = promptTokens
    ? t("chat.contextUsedWithPrompt", {
        tokens: promptTokens.toLocaleString(),
        lore: loreCount,
        memory: memoryCount
      })
    : hasContext
      ? t("chat.contextUsed", { lore: loreCount, memory: memoryCount })
      : t("chat.contextEmpty");

  return (
    <button
      className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 text-xs font-medium text-ink-500 transition-colors hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-ink-300"
      data-chat-context-summary=""
      type="button"
      onClick={onClick}
      title={t("debug.open")}
    >
      <ListTree size={13} />
      {label}
    </button>
  );
}

function MessageTimestamp({
  createdAt,
  language
}: {
  createdAt: string;
  language: "zh-CN" | "en";
}) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatted = new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

  return (
    <time
      className="text-xs font-medium text-current opacity-55"
      data-chat-message-timestamp=""
      dateTime={date.toISOString()}
    >
      {formatted}
    </time>
  );
}

export function SystemNotification({ content }: { content: string }) {
  return (
    <div className="flex justify-center" data-chat-message="system">
      <div
        className="shrink-0 rounded-full bg-white/5 px-4 py-1.5 text-xs text-slate-500 select-none"
        data-chat-bubble=""
      >
        {content}
      </div>
    </div>
  );
}

export function UserMessageBubble({
  message,
  userName,
  userAvatar,
  showAvatar,
  showTimestamp,
  onCopy,
  onToggleBookmark,
  onToggleContext,
  onBranch,
  onCheckpoint,
  onEdit,
  onDelete,
  onResend
}: {
  message: MessageDTO;
  userName?: string;
  userAvatar?: string;
  showAvatar: boolean;
  showTimestamp: boolean;
  onCopy: () => void;
  onToggleBookmark: () => void;
  onToggleContext: () => void;
  onBranch: () => void;
  onCheckpoint: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onResend: () => void;
}) {
  const { language, t } = useI18n();
  const branchTitle = language === "zh-CN" ? "从这里创建分支" : "Branch from here";
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);

  return (
    <div
      className={`flex items-start justify-start ${showAvatar ? "gap-3" : "gap-0"} ${
        message.contextIncluded !== false ? "" : "opacity-60"
      }`}
      data-context-included={message.contextIncluded !== false ? "true" : "false"}
      data-chat-message="user"
    >
      <AvatarSlot
        align="left"
        avatar={userAvatar}
        name={userName || "You"}
        showAvatar={showAvatar}
      />
      <article
        className={`order-1 relative ${bubbleWidthClassName} rounded-lg rounded-bl-sm border border-ember-300/20 bg-ember-500 p-3 text-sm text-ink-950 sm:p-4`}
        data-chat-bubble=""
      >
        {userName ? (
          <p className="mb-1.5 text-xs font-semibold text-ink-950/65" data-chat-user-name="">
            {userName}
          </p>
        ) : null}
        <ChatImageGallery attachments={message.attachments ?? []} language={language} />
        {message.content.trim() ? <MessageBody align="left" content={message.content} renderHtml={false} /> : <span className="sr-only">{language === "zh-CN" ? "图片消息" : "Image message"}</span>}
        {message.contextIncluded === false ? (
          <div
            className="mt-3 inline-flex items-center gap-1.5 rounded border border-ink-950/15 px-2 py-1 text-xs font-medium text-ink-950/75"
            data-testid="message-context-excluded"
          >
            <EyeOff size={12} />
            {t("chat.contextExcludedBadge")}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-start gap-0.5 text-xs" data-chat-actions="">
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="resend"
            type="button"
            onClick={onResend}
            title={t("chat.resend")}
          >
            <RotateCcw size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="copy"
            type="button"
            onClick={onCopy}
            title={t("common.copy")}
          >
            <Copy size={14} />
          </button>
          <button
            aria-pressed={message.isBookmarked}
            className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium active:opacity-70 ${
              message.isBookmarked ? "text-ink-950" : "text-ink-900/70"
            }`}
            data-chat-action="bookmark"
            type="button"
            onClick={onToggleBookmark}
            title={message.isBookmarked ? t("chat.unbookmarkMessage") : t("chat.bookmarkMessage")}
          >
            <Bookmark fill={message.isBookmarked ? "currentColor" : "none"} size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="context-toggle"
            type="button"
            onClick={onToggleContext}
            title={message.contextIncluded ? t("chat.excludeFromContext") : t("chat.includeInContext")}
          >
            {message.contextIncluded ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="branch"
            type="button"
            onClick={onBranch}
            aria-label={branchTitle}
            title={branchTitle}
          >
            <GitBranch size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="checkpoint"
            type="button"
            onClick={onCheckpoint}
            title={t("chat.saveCheckpoint")}
          >
            <Save size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="edit"
            type="button"
            onClick={onEdit}
            title={t("common.edit")}
          >
            <Pencil size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-ink-900/70 active:opacity-70"
            data-chat-action="delete"
            type="button"
            onClick={onDelete}
            title={t("common.delete")}
          >
            <Trash2 size={14} />
          </button>
          {showTimestamp ? <MessageTimestamp createdAt={message.createdAt} language={language} /> : null}
        </div>
      </article>
    </div>
  );
}

export const AssistantMessageBubble = memo(function AssistantMessageBubble({
  message,
  avatar,
  showAvatar,
  showTimestamp,
  htmlCss,
  tokenUsageFormatter,
  onCopy,
  onSpeak,
  onToggleBookmark,
  onBranch,
  onCheckpoint,
  onToggleContext,
  onContinue,
  onRegenerate,
  onRegenerateWithGuidance,
  onEdit,
  onDelete,
  onVariantPrev,
  onVariantNext,
  onDebug,
  disableRegenerate,
  disableSpeech,
  speechAvailable,
  speechPlaying,
  canContinue,
  disableContinue
}: {
  message: MessageDTO;
  avatar?: string | null;
  showAvatar: boolean;
  showTimestamp: boolean;
  htmlCss?: string;
  tokenUsageFormatter: TokenUsageFormatter;
  onCopy: () => void;
  onSpeak: () => void;
  onToggleBookmark: () => void;
  onBranch: () => void;
  onCheckpoint: () => void;
  onToggleContext: () => void;
  onContinue: () => void;
  onRegenerate: () => void;
  onRegenerateWithGuidance: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onVariantPrev: () => void;
  onVariantNext: () => void;
  onDebug: (message: MessageDTO) => void;
  disableRegenerate: boolean;
  disableSpeech: boolean;
  speechAvailable: boolean;
  speechPlaying: boolean;
  canContinue: boolean;
  disableContinue: boolean;
}) {
  const { language, t } = useI18n();
  const branchTitle = language === "zh-CN" ? "从这里创建分支" : "Branch from here";
  const bubbleWidthClassName = getBubbleWidthClassName(showAvatar);
  const handleDebug = useCallback(() => onDebug(message), [onDebug, message]);
  const loreCount = message.loreMatches.length;
  const memoryCount = message.memoryMatches.length;

  return (
    <div
      className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"} ${
        message.contextIncluded !== false ? "" : "opacity-60"
      }`}
      data-context-included={message.contextIncluded !== false ? "true" : "false"}
      data-chat-message="assistant"
    >
      <article
        className={`order-1 relative self-start ${bubbleWidthClassName} overflow-hidden rounded-lg rounded-br-sm border border-white/[0.08] bg-ink-800 p-3 text-sm text-ink-50 sm:p-4`}
        data-chat-bubble=""
      >
        <MessageBody content={message.content} htmlCss={htmlCss} />
        <div className="mt-3 border-t border-white/5 pt-2">
          <div className="flex min-w-0 flex-col gap-2 text-xs">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <TokenInfo usage={message.tokenUsage} metadata={message.generationMetadata} formatter={tokenUsageFormatter} />
                {showTimestamp ? <MessageTimestamp createdAt={message.createdAt} language={language} /> : null}
                {message.contextIncluded === false ? (
                  <span
                    className="inline-flex items-center gap-1 text-amber-300/90"
                    data-testid="message-context-excluded"
                  >
                    <EyeOff size={12} />
                    {t("chat.contextExcludedBadge")}
                  </span>
                ) : null}
              </div>
              <ContextInfo
                loreCount={loreCount}
                memoryCount={memoryCount}
                promptTokens={message.promptBreakdown?.promptTokens}
                onClick={handleDebug}
              />
            </div>
            <div
              className="flex w-full min-w-0 flex-wrap items-center justify-end gap-0.5 sm:w-auto"
              data-chat-actions=""
            >
              {message.variants.length > 1 ? (
                <VariantSwitcher
                  currentIndex={message.activeVariantIndex}
                  total={message.variants.length}
                  onPrev={onVariantPrev}
                  onNext={onVariantNext}
                />
              ) : null}
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="copy"
                type="button"
                onClick={onCopy}
                title={t("common.copy")}
              >
                <Copy size={14} />
              </button>
              <button
                aria-pressed={speechPlaying}
                className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium hover:text-slate-200 disabled:opacity-40 active:text-slate-100 ${
                  speechPlaying
                    ? "text-ember-300"
                    : speechAvailable
                      ? "text-slate-400"
                      : "text-amber-300/80"
                }`}
                data-chat-action="voice-speak-message"
                disabled={disableSpeech}
                type="button"
                onClick={onSpeak}
                title={
                  speechPlaying
                    ? t("chat.voiceStopPlayback")
                    : speechAvailable
                      ? t("chat.voiceSpeakMessage")
                      : t("chat.voiceSpeakSetup")
                }
                aria-label={
                  speechPlaying
                    ? t("chat.voiceStopPlayback")
                    : speechAvailable
                      ? t("chat.voiceSpeakMessage")
                      : t("chat.voiceSpeakSetup")
                }
              >
                {speechPlaying ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
              <button
                aria-pressed={message.isBookmarked}
                className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium hover:text-slate-200 active:text-slate-100 ${
                  message.isBookmarked ? "text-ember-300" : "text-slate-400"
                }`}
                data-chat-action="bookmark"
                type="button"
                onClick={onToggleBookmark}
                title={message.isBookmarked ? t("chat.unbookmarkMessage") : t("chat.bookmarkMessage")}
              >
                <Bookmark fill={message.isBookmarked ? "currentColor" : "none"} size={14} />
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="context-toggle"
                type="button"
                onClick={onToggleContext}
                title={message.contextIncluded ? t("chat.excludeFromContext") : t("chat.includeInContext")}
              >
                {message.contextIncluded ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="branch"
                type="button"
                onClick={onBranch}
                aria-label={branchTitle}
                title={branchTitle}
              >
                <GitBranch size={14} />
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="checkpoint"
                type="button"
                onClick={onCheckpoint}
                title={t("chat.saveCheckpoint")}
              >
                <Save size={14} />
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40 active:text-slate-100"
                data-chat-action="regenerate"
                type="button"
                disabled={disableRegenerate}
                onClick={onRegenerate}
                title={t("chat.regenerate")}
              >
                <RotateCcw size={14} />
              </button>
              <button
                aria-label={t("chat.guidedRegenerate")}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40 active:text-slate-100"
                data-chat-action="guided-regenerate"
                type="button"
                disabled={disableRegenerate}
                onClick={onRegenerateWithGuidance}
                title={t("chat.guidedRegenerate")}
              >
                <WandSparkles size={14} />
              </button>
              {canContinue ? (
                <button
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 disabled:opacity-40 active:text-slate-100"
                  data-chat-action="continue"
                  type="button"
                  disabled={disableContinue}
                  onClick={onContinue}
                  title={t("chat.continue")}
                >
                  <ChevronsRight size={14} />
                </button>
              ) : null}
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="debug"
                type="button"
                onClick={handleDebug}
                title={t("debug.open")}
              >
                <Bug size={14} />
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 active:text-slate-100"
                data-chat-action="edit"
                type="button"
                onClick={onEdit}
                title={t("common.edit")}
              >
                <Pencil size={14} />
              </button>
              <button
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-400 hover:text-rose-300 active:text-rose-200"
                data-chat-action="delete"
                type="button"
                onClick={onDelete}
                title={t("common.delete")}
              >
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
  content,
  contextSummary
}: {
  characterAvatar?: string | null;
  showAvatar: boolean;
  htmlCss?: string;
  content: string;
  contextSummary?: {
    loreCount: number;
    memoryCount: number;
  };
}) {
  const { t } = useI18n();
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
    <div
      className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}
      data-chat-message="streaming"
    >
      <article
        className={`order-1 self-start ${bubbleWidthClassName} animate-fade-in overflow-hidden rounded-lg rounded-br-sm border border-ember-400/25 bg-ink-800 p-3 text-sm text-ink-50 sm:p-4`}
        data-chat-bubble=""
      >
        {displayedContent ? (
          <MessageBody content={displayedContent} htmlCss={htmlCss} />
        ) : (
          <div className="flex items-center gap-1 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:0ms]"></span>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:150ms]"></span>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:300ms]"></span>
          </div>
        )}
        {contextSummary ? (
          <p className="mt-3 border-t border-white/5 pt-2 text-xs font-medium text-slate-500">
            {t("chat.contextDuringGeneration", {
              lore: contextSummary.loreCount,
              memory: contextSummary.memoryCount
            })}
          </p>
        ) : null}
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
    <div
      className={`flex items-start justify-end ${showAvatar ? "gap-3" : "gap-0"}`}
      data-chat-message="error"
    >
      <article
        className={`order-1 self-start ${bubbleWidthClassName} animate-fade-in overflow-hidden rounded-lg rounded-br-sm border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200 sm:p-4`}
        data-chat-bubble=""
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-400" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-rose-300">{t("chat.generationFailed")}</p>
            <p className="mt-1 break-words text-xs text-rose-300/80">{error}</p>
          </div>
        </div>
        <div
          className="mt-3 flex items-center gap-0.5 border-t border-rose-500/15 pt-2 text-xs"
          data-chat-actions=""
        >
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-300 hover:text-rose-100 active:text-rose-50"
            data-chat-action="retry"
            type="button"
            onClick={onRetry}
            title={t("chat.retry")}
          >
            <RotateCcw size={14} />
          </button>
          <button
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center whitespace-nowrap font-medium text-rose-300/60 hover:text-rose-200 active:text-rose-100"
            data-chat-action="dismiss"
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
