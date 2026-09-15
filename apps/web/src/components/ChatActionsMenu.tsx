import type { ReactNode } from "react";
import { useDialogFocus } from "./ui";

export function ChatActionsMenu({ children, label, onClose }: {
  children: ReactNode; label: string; onClose: () => void;
}) {
  const ref = useDialogFocus<HTMLDivElement>({ active: true, onDismiss: onClose });
  return <div ref={ref} role="menu" aria-label={label} tabIndex={-1} data-dialog-surface="true"
    className="chat-actions-menu fixed right-3 top-16 z-40 flex max-h-[calc(100dvh-5rem)] w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-1 overflow-y-auto rounded-lg border border-white/10 bg-ink-900 p-2 shadow-xl"
    onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next]?.focus();
    }}
  >{children}</div>;
}
