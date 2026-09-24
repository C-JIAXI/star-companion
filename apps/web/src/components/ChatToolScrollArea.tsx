import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function ChatToolScrollArea({ children, className = "", contentRef, hidden = false }: {
  children?: ReactNode;
  className?: string;
  contentRef?: (element: HTMLDivElement | null) => void;
  hidden?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState({ top: 0, height: 0 });
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    contentRef?.(element);
  }, [contentRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { clientHeight, scrollHeight, scrollTop } = element;
        if (clientHeight <= 0 || scrollHeight <= clientHeight + 1) {
          setThumb({ top: 0, height: 0 });
          return;
        }
        const height = Math.max(28, clientHeight * clientHeight / scrollHeight);
        const top = scrollTop / (scrollHeight - clientHeight) * (clientHeight - height);
        setThumb({ top, height });
      });
    };
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    const observeChildren = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(element);
      for (const child of element.children) resizeObserver.observe(child);
      update();
    };
    const mutationObserver = new MutationObserver(observeChildren);
    mutationObserver.observe(element, { childList: true, subtree: true, attributes: true, characterData: true });
    observeChildren();
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", update);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  return <div className={`${hidden ? "hidden" : ""} chat-tool-scroll-frame relative min-h-0 flex-1`}>
    <div ref={setScrollRef} className={`chat-tool-scroll h-full overflow-y-auto pr-3 ${className}`}>
      {children}
    </div>
    {thumb.height > 0 ? <span aria-hidden="true" className="chat-tool-scroll-indicator" data-testid="chat-tool-scroll-indicator"
      style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }} /> : null}
  </div>;
}
