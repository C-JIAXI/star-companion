import { MoreHorizontal } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./ui";

function ToolsPopover({ anchor, children, id, label, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  id: string;
  label: string;
  onClose: () => void;
}) {
  const surface = useDialogFocus<HTMLDivElement>({ active: true, onDismiss: onClose });
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 240 });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const left = viewport?.offsetLeft ?? 0;
      const menuHeight = Math.min(surface.current?.scrollHeight ?? 180, height - 24);
      setPosition({
        left: Math.max(left + 12, Math.min(rect.left, left + width - 276)),
        top: Math.max(top + 12, Math.min(rect.top - menuHeight - 8, top + height - menuHeight - 12)),
        maxHeight: Math.max(44, height - 24)
      });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !surface.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside);
    };
  }, [anchor, onClose, surface]);

  return createPortal(<div ref={surface} id={id} role="menu" aria-label={label} tabIndex={-1}
    data-dialog-surface="true" className="composer-tools-popover" style={position}
    onClick={(event) => {
      if ((event.target as Element).closest('button:not([disabled])')) onClose();
    }}
    onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[next]?.focus();
    }}
  >{children}</div>, document.body);
}

export function ComposerToolsMenu({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <button ref={anchor} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} data-testid="composer-tools-trigger"
      className="composer-more-button grid h-11 w-11 place-items-center rounded-xl text-ink-300"
      onClick={() => setOpen((value) => !value)}><MoreHorizontal size={19} /></button>
    {open ? <ToolsPopover anchor={anchor} id={id} label={label} onClose={() => setOpen(false)}>{children}</ToolsPopover> : null}
  </>;
}
