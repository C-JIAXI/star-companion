import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveApiUrl } from "../lib/appBackend";
import type { MessageAttachmentDTO } from "../types";

export function ChatImageGallery({ attachments, language }: { attachments: MessageAttachmentDTO[]; language: "zh-CN" | "en" }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected === null) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "ArrowLeft") setSelected((value) => value === null ? null : (value - 1 + attachments.length) % attachments.length);
      if (event.key === "ArrowRight") setSelected((value) => value === null ? null : (value + 1) % attachments.length);
      if (event.key === "Tab" && dialogRef.current) {
        const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']"));
        if (!controls.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = prior; window.removeEventListener("keydown", onKeyDown); openerRef.current?.focus(); };
  }, [selected, attachments.length]);
  if (!attachments.length) return null;
  const label = language === "zh-CN" ? "图片消息" : "Image message";
  const failedLabel = language === "zh-CN" ? "图片不可用" : "Image unavailable";
  return <>
    <div className={`mb-2 grid gap-1.5 ${attachments.length === 1 ? "grid-cols-1" : "grid-cols-2"}`} data-testid="message-image-gallery">
      {attachments.map((attachment, index) => <button className="relative min-h-20 overflow-hidden rounded-md bg-black/15 focus:outline-none focus:ring-2 focus:ring-white" key={attachment.id} type="button" aria-label={`${label} ${index + 1}/${attachments.length}`} onClick={(event) => { openerRef.current = event.currentTarget; setSelected(index); }}>
        {failed.has(attachment.id) ? <span className="grid min-h-24 place-items-center px-3 text-xs font-medium">{failedLabel}</span> : <img alt={`${label} ${index + 1}`} className="max-h-72 w-full object-contain" loading="lazy" src={resolveApiUrl(attachment.url)} onError={() => setFailed((value) => new Set(value).add(attachment.id))} />}
      </button>)}
    </div>
    {selected !== null ? <div ref={dialogRef} aria-label={language === "zh-CN" ? "图片查看器" : "Image viewer"} aria-modal="true" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4" role="dialog">
      <button ref={closeRef} className="absolute right-4 top-4 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "关闭大图" : "Close image"} onClick={() => setSelected(null)}><X /></button>
      {attachments.length > 1 ? <button className="absolute left-3 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "上一张" : "Previous image"} onClick={() => setSelected((selected - 1 + attachments.length) % attachments.length)}><ChevronLeft /></button> : null}
      {failed.has(attachments[selected]!.id) ? <p className="text-sm text-white" role="status">{failedLabel}</p> : <img alt={`${label} ${selected + 1}`} className="max-h-[90vh] max-w-[90vw] object-contain" src={resolveApiUrl(attachments[selected]!.url)} onError={() => setFailed((value) => new Set(value).add(attachments[selected]!.id))} />}
      {attachments.length > 1 ? <button className="absolute right-3 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/60 text-white" type="button" aria-label={language === "zh-CN" ? "下一张" : "Next image"} onClick={() => setSelected((selected + 1) % attachments.length)}><ChevronRight /></button> : null}
    </div> : null}
  </>;
}
