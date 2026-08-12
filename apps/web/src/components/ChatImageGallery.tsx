import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MessageAttachmentDTO } from "../types";

export function ChatImageGallery({ attachments, language }: { attachments: MessageAttachmentDTO[]; language: "zh-CN" | "en" }) {
  const [selected, setSelected] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (selected === null) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "ArrowLeft") setSelected((value) => value === null ? null : (value - 1 + attachments.length) % attachments.length);
      if (event.key === "ArrowRight") setSelected((value) => value === null ? null : (value + 1) % attachments.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = prior; window.removeEventListener("keydown", onKeyDown); };
  }, [selected, attachments.length]);
  if (!attachments.length) return null;
  const label = language === "zh-CN" ? "图片消息" : "Image message";
  return <>
    <div className={`mb-2 grid gap-1.5 ${attachments.length === 1 ? "grid-cols-1" : "grid-cols-2"}`} data-testid="message-image-gallery">
      {attachments.map((attachment, index) => <button className="relative min-h-20 overflow-hidden rounded-md bg-black/15 focus:outline-none focus:ring-2 focus:ring-white" key={attachment.id} type="button" aria-label={`${label} ${index + 1}/${attachments.length}`} onClick={() => setSelected(index)}>
        <img alt={`${label} ${index + 1}`} className="max-h-72 w-full object-contain" loading="lazy" src={attachment.url} onError={(event) => { event.currentTarget.alt = language === "zh-CN" ? "图片加载失败" : "Image failed to load"; }} />
      </button>)}
    </div>
    {selected !== null ? <div aria-label={language === "zh-CN" ? "图片查看器" : "Image viewer"} aria-modal="true" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4" role="dialog">
      <button ref={closeRef} className="absolute right-4 top-4 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "关闭大图" : "Close image"} onClick={() => setSelected(null)}><X /></button>
      {attachments.length > 1 ? <button className="absolute left-3 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "上一张" : "Previous image"} onClick={() => setSelected((selected - 1 + attachments.length) % attachments.length)}><ChevronLeft /></button> : null}
      <img alt={`${label} ${selected + 1}`} className="max-h-[90vh] max-w-[90vw] object-contain" src={attachments[selected]!.url} />
      {attachments.length > 1 ? <button className="absolute right-3 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "下一张" : "Next image"} onClick={() => setSelected((selected + 1) % attachments.length)}><ChevronRight /></button> : null}
    </div> : null}
  </>;
}
