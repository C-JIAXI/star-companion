import { GripVertical } from "lucide-react";
import { useRef, useState } from "react";

/** Pointer capture supports mouse, pen and touch without dragging editable content. */
export function LoreReorderHandle({ id, ids, language, onMove, onTarget, onDragging, kind = "lore" }: {
  id: string;
  ids: string[];
  language: string;
  onMove: (id: string, targetId: string) => void;
  onTarget: (id: string | null) => void;
  onDragging: (id: string | null) => void;
  kind?: "lore" | "regex";
}) {
  const drag = useRef<{ pointer: number; x: number; y: number; target: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const zh = language === "zh-CN";
  const index = ids.indexOf(id);
  const announce = (position: number) => setAnnouncement(zh ? `位置 ${position + 1}，共 ${ids.length} 条` : `Position ${position + 1} of ${ids.length}`);
  const clear = () => { drag.current = null; onTarget(null); onDragging(null); };
  return <>
    <button type="button" data-testid={`${kind}-reorder-handle`}
      aria-label={zh ? `调整${kind === "lore" ? " Lore" : "正则脚本"} ${index + 1} 的顺序` : `Reorder ${kind === "lore" ? "lore" : "regex script"} ${index + 1}`}
      title={zh ? "拖动排序，或用上下方向键调整" : "Drag to reorder, or use Up/Down arrows"}
      className="grid h-11 w-11 shrink-0 touch-none place-items-center rounded-lg text-ink-400 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ember-500 cursor-grab active:cursor-grabbing"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, target: null };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId || Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
        onDragging(id);
        const list = event.currentTarget.closest(`[data-${kind}-list]`);
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(`[data-${kind}-order-id]`);
        current.target = row && list?.contains(row) ? row.getAttribute(`data-${kind}-order-id`) : null;
        onTarget(current.target !== id ? current.target : null);
        // Scroll the editor, not the page, when dragging at its visible edges.
        let parent = list?.parentElement;
        while (parent) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
            const rect = parent.getBoundingClientRect();
            if (event.clientY < rect.top + 48) parent.scrollTop -= 20;
            else if (event.clientY > rect.bottom - 48) parent.scrollTop += 20;
            break;
          }
          parent = parent.parentElement;
        }
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (current?.pointer === event.pointerId && current.target && current.target !== id) {
          onMove(id, current.target);
          announce(ids.indexOf(current.target));
        }
        clear();
      }}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); clear(); return; }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault(); event.stopPropagation();
        const target = index + (event.key === "ArrowUp" ? -1 : 1);
        if (ids[target]) { onMove(id, ids[target]); announce(target); }
      }}
    ><GripVertical size={18} /></button>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </>;
}
