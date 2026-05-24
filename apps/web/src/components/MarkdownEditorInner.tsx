import MDEditor from "@uiw/react-md-editor";
import * as commandsEn from "@uiw/react-md-editor/commands";
import * as commandsZh from "@uiw/react-md-editor/commands-cn";
import type { Statistics } from "@uiw/react-md-editor";
import type { ICommand } from "@uiw/react-md-editor/commands";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useI18n } from "../i18n";
import "./markdown-editor.css";

export type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  height?: number | string;
  className?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export default function MarkdownEditorInner({
  value,
  onChange,
  placeholder,
  height = 180,
  className = "",
  isFullscreen = false,
  onToggleFullscreen
}: MarkdownEditorProps) {
  const { t, language } = useI18n();
  const [stats, setStats] = useState<Pick<Statistics, "length" | "lineCount">>({
    length: value.length,
    lineCount: value ? value.split("\n").length : 0
  });

  const commandSet = useMemo(
    () => (language === "zh-CN" ? commandsZh : commandsEn),
    [language]
  );

  const fullscreenCommand = useMemo<ICommand>(
    () => ({
      name: "roleplay-fullscreen",
      keyCommand: "roleplay-fullscreen",
      buttonProps: {
        "aria-label": isFullscreen ? t("markdown.exitFullscreen") : t("markdown.enterFullscreen"),
        title: isFullscreen ? t("markdown.exitFullscreen") : t("markdown.enterFullscreen")
      },
      icon: isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />,
      execute: () => {
        onToggleFullscreen?.();
      }
    }),
    [isFullscreen, onToggleFullscreen, t]
  );

  const extraCommands = useMemo(
    () => [
      ...commandSet.getExtraCommands().filter((command) => command.keyCommand !== "fullscreen"),
      fullscreenCommand
    ],
    [commandSet, fullscreenCommand]
  );

  return (
    <div className={`flex min-h-0 flex-col rounded-xl border border-white/10 bg-ink-950/35 ${className}`}>
      <MDEditor
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        onStatistics={(nextStats) => setStats({ length: nextStats.length, lineCount: nextStats.lineCount })}
        commands={commandSet.getCommands()}
        extraCommands={extraCommands}
        preview="live"
        height={height}
        visibleDragbar={false}
        hideToolbar={false}
        enableScroll
        tabSize={2}
        data-color-mode="dark"
        className="roleplay-md-editor"
        textareaProps={{
          placeholder,
          spellCheck: false
        }}
        previewOptions={{
          className: "roleplay-md-preview"
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 px-3 py-2 text-[11px] text-slate-500">
        <div className="flex items-center gap-3">
          <span>{t("markdown.characters")}: {stats.length}</span>
          <span>{t("markdown.lines")}: {stats.lineCount}</span>
        </div>
        <span>{t("markdown.shortcutsHint")}</span>
      </div>
    </div>
  );
}
