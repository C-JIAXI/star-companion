import { useEffect, useState, type ReactNode } from "react";
import { useDialogFocus } from "./ui";

/** Measures the workspace, so sidebar collapse and browser zoom affect docking. */
export function ChatToolSurface({ children, label, onClose, testId }: {
  children: ReactNode;
  label: string;
  onClose: () => void;
  testId?: string;
}) {
  const [docked, setDocked] = useState(() =>
    (document.getElementById("chat-panel")?.getBoundingClientRect().width ?? 0) >= 980);
  useEffect(() => {
    const workspace = document.getElementById("chat-panel");
    if (!workspace) return;
    const update = () => setDocked(workspace.getBoundingClientRect().width >= 980);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  const surfaceRef = useDialogFocus<HTMLElement>({ active: !docked, onDismiss: onClose });
  return <>
    {!docked ? <button type="button" className="fixed inset-0 z-40 bg-black/45"
      aria-label={label} tabIndex={-1} onClick={onClose} /> : null}
    <aside ref={surfaceRef} tabIndex={-1} aria-label={label}
      role={docked ? "complementary" : "dialog"} aria-modal={docked ? undefined : true}
      data-dialog-surface={docked ? undefined : "true"}
      data-testid={testId} data-chat-tool-layout={docked ? "docked" : "drawer"}
      className={docked
        ? "chat-tool-surface flex h-full w-[340px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-white/10 bg-ink-900 p-3"
        : "chat-tool-surface fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] min-w-0 flex-col overflow-hidden border-l border-white/10 bg-ink-900 p-3 safe-area-top safe-area-bottom"}
      onKeyDown={(event) => {
        if (docked && event.key === "Escape") { event.preventDefault(); onClose(); }
      }}
    >{children}</aside>
  </>;
}
