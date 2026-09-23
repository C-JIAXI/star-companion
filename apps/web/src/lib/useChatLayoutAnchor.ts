import { useEffect, type RefObject } from "react";

type Anchor = { id: string; offset: number };

/** Layout-only compensation. Pagination and explicit jumps keep their own rules. */
export function useChatLayoutAnchor(
  viewportRef: RefObject<HTMLDivElement | null>,
  chatId: string | undefined,
  paginationAnchor: RefObject<Anchor | null>
) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let anchor: Anchor | null = null;
    let pinnedToBottom = false;
    let restoring = false;
    let frame = 0;
    const geometry = () => `${viewport.clientWidth}:${viewport.clientHeight}:${viewport.scrollHeight}:${getComputedStyle(document.documentElement).fontSize}:${getComputedStyle(viewport).lineHeight}`;
    let previousGeometry = geometry();
    const messages = () => Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]"));
    const capture = () => {
      pinnedToBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      const top = viewport.getBoundingClientRect().top;
      const message = messages().find((element) => element.getBoundingClientRect().bottom > top + 1);
      anchor = message ? { id: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top } : null;
      previousGeometry = geometry();
    };
    const restore = () => {
      if (paginationAnchor.current) { capture(); return; }
      if (pinnedToBottom) {
        const behavior = viewport.style.scrollBehavior;
        viewport.style.scrollBehavior = "auto";
        viewport.scrollTop = viewport.scrollHeight;
        viewport.style.scrollBehavior = behavior;
        capture();
        return;
      }
      if (!anchor) { capture(); return; }
      const message = messages().find((element) => element.dataset.messageId === anchor!.id);
      if (!message) { capture(); return; }
      restoring = true;
      const behavior = viewport.style.scrollBehavior;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollTop += message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
      viewport.style.scrollBehavior = behavior;
      previousGeometry = geometry();
      restoring = false;
    };
    const onScroll = () => {
      if (restoring) return;
      if (geometry() !== previousGeometry) restore();
      else capture();
    };
    const onResize = () => {
      if (geometry() !== previousGeometry) restore();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(viewport);
    const messageList = viewport.querySelector("#chat-message-list");
    if (messageList) observer.observe(messageList);
    const appearanceObserver = new MutationObserver(() => {
      // Attribute changes can alter line spacing without changing viewport bounds.
      restore();
    });
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-font-size", "data-line-height", "data-chat-width", "data-message-spacing"] });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    frame = requestAnimationFrame(capture);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); appearanceObserver.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [chatId, paginationAnchor, viewportRef]);
}
