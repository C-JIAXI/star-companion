import { AlertTriangle, CheckCircle, HelpCircle, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes
} from "react";

export function Panel({
  title,
  action,
  children,
  className = ""
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`animate-fade-in h-full min-w-0 overflow-hidden rounded-xl border border-white/5 bg-ink-900/80 p-2 sm:p-4 shadow-lg shadow-black/20 backdrop-blur-sm transition-all ${className}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
        <h3 className="min-w-0 text-sm font-semibold tracking-wide text-slate-100">{title}</h3>
        {action ? <div className="flex min-w-0 shrink items-center gap-1">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "secondary";
}) {
  const variants = {
    primary:
      "bg-ember-500 text-ink-950 hover:bg-ember-400 focus:ring-ember-500/50 shadow-md shadow-ember-500/20",
    secondary:
      "bg-ink-800 text-slate-200 hover:bg-ink-700 border border-white/5 focus:ring-ink-600/50",
    ghost:
      "bg-transparent text-slate-300 hover:bg-white/10 hover:text-slate-100 focus:ring-white/20",
    danger:
      "bg-rose-500/90 text-white hover:bg-rose-500 focus:ring-rose-500/50 shadow-md shadow-rose-500/20"
  };

  return (
    <button
      className={`inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ink-950 active:scale-95 disabled:pointer-events-none disabled:opacity-50 sm:min-h-[44px] ${variants[variant]} ${className}`}
      type="button"
      {...props}
    />
  );
}

export function Field({
  label,
  labelClassName = "",
  children,
  container = "label"
}: {
  label: ReactNode;
  labelClassName?: string;
  children: ReactNode;
  container?: "label" | "div";
}) {
  const Container = container;

  return (
    <Container className="grid min-w-0 gap-1.5 text-sm">
      <span className={`font-medium text-slate-300 ${labelClassName}`}>{label}</span>
      {children}
    </Container>
  );
}

export function HelpLabel({ label, description }: { label: ReactNode; description: ReactNode }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | null>(null);

  const updateTooltipPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      setTooltipStyle(null);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const horizontalPadding = 16;
    const verticalGap = 8;
    const tooltipWidth = Math.min(256, window.innerWidth - horizontalPadding * 2);
    const estimatedTooltipHeight = 96;
    const spaceBelow = window.innerHeight - rect.bottom - horizontalPadding;
    const placeAbove =
      spaceBelow < estimatedTooltipHeight && rect.top > estimatedTooltipHeight + verticalGap;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - tooltipWidth / 2, horizontalPadding),
      window.innerWidth - tooltipWidth - horizontalPadding
    );

    setTooltipStyle({
      left,
      top: placeAbove ? rect.top - verticalGap : rect.bottom + verticalGap,
      width: tooltipWidth,
      transform: placeAbove ? "translateY(-100%)" : undefined
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    updateTooltipPosition();
    const handleViewportChange = () => updateTooltipPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updateTooltipPosition]);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="relative inline-flex">
        <span
          ref={triggerRef}
          aria-label={typeof label === "string" ? `${label} help` : "Field help"}
          className="inline-grid h-4 w-4 cursor-help place-items-center rounded-full text-slate-500 outline-none transition-colors hover:text-ember-400 focus:text-ember-400"
          role="img"
          tabIndex={0}
          onBlur={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <HelpCircle size={14} />
        </span>
      </span>
      {open && tooltipStyle && typeof document !== "undefined"
        ? createPortal(
            <span
              className="animate-fade-in pointer-events-none fixed z-[80] rounded-lg border border-white/10 bg-ink-800/95 px-3 py-2.5 text-xs leading-relaxed text-slate-200 shadow-xl shadow-black/40 backdrop-blur-md"
              role="tooltip"
              style={tooltipStyle}
            >
              {description}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-[40px] w-full min-w-0 rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all placeholder:text-slate-500 hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50 sm:min-h-[44px] ${className}`}
      {...props}
    />
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", style, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`custom-scrollbar h-[320px] w-full min-w-0 resize-none overflow-y-auto rounded-lg border border-white/10 bg-ink-950/50 px-3 py-2.5 text-sm leading-normal text-slate-100 outline-none transition-all placeholder:text-slate-500 hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50 ${className}`}
        style={style}
        {...props}
      />
    );
  }
);

TextArea.displayName = "TextArea";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-slate-400 transition-colors hover:bg-white/[0.04]">
      {children}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string | null }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 2400);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (!mounted || !message || !visible) {
    return null;
  }

  return createPortal(
    <div
      aria-live="assertive"
      className="animate-fade-in pointer-events-none fixed right-4 top-4 z-[70] flex min-h-[44px] w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-xl border border-rose-500/25 bg-ink-900/95 px-4 py-3 text-sm font-medium text-slate-100 shadow-2xl shadow-black/40 backdrop-blur-md sm:w-auto sm:min-w-[300px]"
      role="alert"
    >
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-400" />
      <span className="leading-5">{message}</span>
    </div>,
    document.body
  );
}

export function SuccessNotice({ message }: { message: string | null }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!message) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 2400);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (!mounted || !message || !visible) {
    return null;
  }

  return createPortal(
    <div
      aria-live="polite"
      className="animate-fade-in pointer-events-none fixed right-4 top-4 z-[70] flex min-h-[44px] w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-xl border border-emerald-500/25 bg-ink-900/95 px-4 py-3 text-sm font-medium text-slate-100 shadow-2xl shadow-black/40 backdrop-blur-md sm:w-auto sm:min-w-[300px]"
      role="status"
    >
      <CheckCircle size={18} className="mt-0.5 shrink-0 text-emerald-400" />
      <span className="leading-5">{message}</span>
    </div>,
    document.body
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10">
      {children}
    </span>
  );
}

export function Drawer({
  open,
  onClose,
  children,
  title
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
}) {
  return createPortal(
    <div
      className={`fixed inset-0 z-40 transition-all duration-300 lg:hidden ${
        open ? "" : "pointer-events-none"
      }`}
    >
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-y-0 left-0 z-10 flex w-[80vw] max-w-[320px] flex-col border-r border-white/10 bg-ink-900 shadow-2xl shadow-black/70 transition-transform duration-300 ease-out will-change-transform safe-area-top safe-area-bottom ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {title ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
            <h3 className="min-w-0 truncate text-sm font-semibold tracking-wide text-slate-100">
              {title}
            </h3>
            <button
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-all duration-200 hover:bg-white/10 hover:text-slate-200 active:scale-90 sm:h-9 sm:w-9"
              type="button"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function Modal({
  title,
  children,
  onClose
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-3 backdrop-blur-md transition-[opacity,backdrop-filter] duration-300 will-change-[opacity] sm:p-5"
      onClick={onClose}
    >
      <section
        className="animate-modal-enter flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-900 shadow-2xl shadow-black/70 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)]"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5 sm:px-6 sm:py-4">
          <h3 className="min-w-0 truncate text-base font-semibold tracking-tight text-slate-100">
            {title}
          </h3>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-all duration-200 hover:bg-white/10 hover:text-slate-200 active:scale-90 sm:h-9 sm:w-9"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
          {children}
        </div>
      </section>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  loading = false,
  variant = "danger",
  onCancel,
  onConfirm
}: {
  title: ReactNode;
  message: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  loading?: boolean;
  variant?: "primary" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-3 backdrop-blur-md transition-[opacity,backdrop-filter] duration-300 will-change-[opacity] sm:p-5">
      <section
        aria-labelledby="confirm-dialog-title"
        className="animate-modal-enter flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-900 shadow-2xl shadow-black/70 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)]"
        role="dialog"
      >
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5 sm:px-6 sm:pb-5 sm:pt-6">
        <div className="flex gap-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-400 ring-4 ring-rose-500/5 sm:h-12 sm:w-12">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 pt-0.5 sm:pt-1">
            <h3
              className="text-base font-semibold tracking-tight text-slate-100 sm:text-lg"
              id="confirm-dialog-title"
            >
              {title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{message}</p>
          </div>
        </div>
        </div>

        <div className="flex shrink-0 flex-col sm:flex-row sm:flex-wrap sm:justify-end gap-3 border-t border-white/[0.06] px-5 py-4 sm:px-6">
          <Button disabled={loading} variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button disabled={loading} variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
