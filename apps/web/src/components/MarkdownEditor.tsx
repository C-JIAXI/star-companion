import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { MarkdownEditorProps } from "./MarkdownEditorInner";

const MarkdownEditorInner = lazy(() => import("./MarkdownEditorInner"));

export function MarkdownEditor(props: MarkdownEditorProps) {
  const { t } = useI18n();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  const editorNode = useMemo(
    () => (
      <Suspense
        fallback={
          <div className={`rounded-xl border border-white/10 bg-ink-950/35 ${props.className ?? ""}`}>
            <div
              className="grid place-items-center px-4 text-sm text-slate-500"
              style={{ height: props.height ?? 180 }}
            >
              {t("markdown.loading")}
            </div>
          </div>
        }
      >
        <MarkdownEditorInner
          {...props}
          className={isFullscreen ? "h-full" : props.className}
          height={isFullscreen ? "calc(100% - 37px)" : props.height}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => setIsFullscreen((current) => !current)}
        />
      </Suspense>
    ),
    [isFullscreen, props, t]
  );

  if (!isFullscreen) {
    return editorNode;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] bg-black/70 p-3 backdrop-blur-sm sm:p-5"
      onClick={() => setIsFullscreen(false)}
    >
      <div className="mx-auto h-full max-w-[1800px]" onClick={(event) => event.stopPropagation()}>
        {editorNode}
      </div>
    </div>,
    document.body
  );
}
