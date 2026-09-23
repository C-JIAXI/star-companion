import { useEffect, useLayoutEffect, useRef } from "react";

/** Animate only committed reorders; typing, expanding and scrolling never trigger FLIP. */
export function useLoreOrderAnimation(order: string, kind: "lore" | "regex" = "lore") {
  const listRef = useRef<HTMLDivElement>(null);
  const before = useRef<Map<string, number> | null>(null);
  const animations = useRef<Animation[]>([]);
  const cancel = () => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
  };
  const capture = () => {
    before.current = new Map(Array.from(listRef.current?.querySelectorAll<HTMLElement>(`[data-${kind}-order-id]`) ?? [])
      .map((row) => [row.getAttribute(`data-${kind}-order-id`)!, row.getBoundingClientRect().top]));
    cancel();
  };
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (!previous || document.documentElement.dataset.motion === "reduced") return;
    for (const row of listRef.current?.querySelectorAll<HTMLElement>(`[data-${kind}-order-id]`) ?? []) {
      const top = previous.get(row.getAttribute(`data-${kind}-order-id`)!);
      if (top === undefined) continue;
      const delta = top - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      animations.current.push(row.animate([
        { transform: `translateY(${delta}px)` },
        { transform: "translateY(0)" }
      ], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" }));
    }
  }, [order, kind]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (document.documentElement.dataset.motion === "reduced") cancel();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => { observer.disconnect(); cancel(); };
  }, []);
  return { listRef, capture };
}
