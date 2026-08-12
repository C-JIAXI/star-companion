import { AlertTriangle, CheckCircle, HelpCircle, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes
} from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const isVisibleDialog = (element: HTMLElement) =>
  element.getAttribute("aria-hidden") !== "true" &&
  !element.closest('[aria-hidden="true"]') &&
  element.getClientRects().length > 0;

const getTopmostDialog = () => {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[data-dialog-surface="true"]')
  ).filter(isVisibleDialog);
  return dialogs.at(-1) ?? null;
};

const getFocusableElements = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0
  );

function useDialogFocus<T extends HTMLElement>({
  active,
  onDismiss,
  initialFocusSelector
}: {
  active: boolean;
  onDismiss: () => void;
  initialFocusSelector?: string;
}) {
  const surfaceRef = useRef<T>(null);
  const dismissRef = useRef(onDismiss);
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) {
      return;
    }

    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activeElement && !surfaceRef.current?.contains(activeElement)) {
      previousFocusRef.current = activeElement;
    }
    const focusInside = () => {
      const surface = surfaceRef.current;
      if (!surface || surface.contains(document.activeElement)) {
        return;
      }

      const preferred = initialFocusSelector
        ? surface.querySelector<HTMLElement>(initialFocusSelector)
        : null;
      const target =
        (preferred && !preferred.hasAttribute("disabled") ? preferred : null) ??
        getFocusableElements(surface)[0] ??
        surface;
      target.focus({ preventScroll: true });
    };
    focusInside();
    const frame = window.requestAnimationFrame(focusInside);

    const handleKeyDown = (event: KeyboardEvent) => {
      const surface = surfaceRef.current;
      if (!surface || getTopmostDialog() !== surface) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(surface);
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !surface.contains(activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === last || !surface.contains(activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [active, initialFocusSelector]);

  return surfaceRef;
}

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
      className={`animate-fade-in h-full min-w-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-900 p-3 sm:p-4 transition-colors ${className}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
        <h3 className="min-w-0 text-sm font-semibold text-ink-50">{title}</h3>
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
      "border border-ember-400/20 bg-ember-500 text-ink-950 hover:bg-ember-400 focus:ring-ember-400/40",
    secondary:
      "border border-white/[0.09] bg-ink-800 text-ink-100 hover:border-white/[0.14] hover:bg-ink-700 focus:ring-white/15",
    ghost:
      "border border-transparent bg-transparent text-ink-300 hover:bg-white/[0.06] hover:text-ink-50 focus:ring-white/15",
    danger:
      "border border-rose-400/20 bg-rose-600 text-white hover:bg-rose-500 focus:ring-rose-500/40"
  };

  return (
    <button
      className={`inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ink-950 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 sm:min-h-10 ${variants[variant]} ${className}`}
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
      <span className={`font-medium text-ink-200 ${labelClassName}`}>{label}</span>
      {children}
    </Container>
  );
}

export function HelpLabel({ label, description, descriptionId }: { label: ReactNode; description: ReactNode; descriptionId?: string }) {
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
          aria-describedby={descriptionId}
          aria-label={typeof label === "string" ? `${label} help` : "Field help"}
          className="inline-grid h-4 w-4 cursor-help place-items-center rounded-full text-ink-500 outline-none transition-colors hover:text-ember-300 focus:text-ember-300"
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
      {descriptionId ? <span id={descriptionId} className="sr-only">{description}</span> : null}
      {open && tooltipStyle && typeof document !== "undefined"
        ? createPortal(
            <span
              className="animate-fade-in pointer-events-none fixed z-[80] rounded-md border border-white/[0.1] bg-ink-800 px-3 py-2.5 text-xs leading-relaxed text-ink-100 shadow-xl shadow-black/45"
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

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`min-h-[44px] w-full min-w-0 rounded-md border border-white/[0.1] bg-ink-950/70 px-3 text-sm text-ink-50 outline-none transition-colors placeholder:text-ink-500 hover:border-white/[0.16] focus:border-ember-400 focus:bg-ink-950 focus:ring-1 focus:ring-ember-400/30 sm:min-h-10 ${className}`}
      {...props}
    />
  )
);

TextInput.displayName = "TextInput";

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", style, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`custom-scrollbar h-[320px] w-full min-w-0 resize-none overflow-y-auto rounded-md border border-white/[0.1] bg-ink-950/70 px-3 py-2.5 text-sm leading-normal text-ink-50 outline-none transition-colors placeholder:text-ink-500 hover:border-white/[0.16] focus:border-ember-400 focus:bg-ink-950 focus:ring-1 focus:ring-ember-400/30 ${className}`}
        style={style}
        {...props}
      />
    );
  }
);

TextArea.displayName = "TextArea";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[148px] w-full flex-col items-center justify-center rounded-lg border border-dashed border-white/[0.1] bg-ink-950/30 p-6 text-center text-sm text-ink-300">
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
      className="animate-fade-in pointer-events-none fixed right-4 top-4 z-[70] flex min-h-[44px] w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-lg border border-rose-500/30 bg-ink-800 px-4 py-3 text-sm font-medium text-ink-50 shadow-2xl shadow-black/45 sm:w-auto sm:min-w-[300px]"
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
      className="animate-fade-in pointer-events-none fixed right-4 top-4 z-[70] flex min-h-[44px] w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-lg border border-emerald-500/30 bg-ink-800 px-4 py-3 text-sm font-medium text-ink-50 shadow-2xl shadow-black/45 sm:w-auto sm:min-w-[300px]"
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
    <span className="inline-flex items-center rounded-full border border-white/[0.1] bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-ink-300">
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
  const titleId = useId();
  const surfaceRef = useDialogFocus<HTMLDivElement>({
    active: open,
    onDismiss: onClose,
    initialFocusSelector: "[data-dialog-close='true']"
  });

  return createPortal(
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-40 transition-all duration-300 lg:hidden ${
        open ? "" : "pointer-events-none"
      }`}
      inert={!open ? true : undefined}
    >
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        ref={surfaceRef}
        aria-labelledby={title ? titleId : undefined}
        aria-modal={open ? true : undefined}
        className={`absolute inset-y-0 left-0 z-10 flex w-[84vw] max-w-[340px] flex-col border-r border-white/[0.1] bg-ink-900 shadow-2xl shadow-black/70 transition-transform duration-300 ease-out will-change-transform safe-area-top safe-area-bottom ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        data-dialog-surface="true"
        role="dialog"
        tabIndex={-1}
      >
        {title ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
            <h3 className="min-w-0 truncate text-sm font-semibold text-ink-50" id={titleId}>
              {title}
            </h3>
            <button
              aria-label="Close"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
              data-dialog-close="true"
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
  onClose,
  panelClassName = "",
  bodyClassName = ""
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  panelClassName?: string;
  bodyClassName?: string;
}) {
  const titleId = useId();
  const surfaceRef = useDialogFocus<HTMLElement>({
    active: true,
    onDismiss: onClose,
    initialFocusSelector: "[data-dialog-close='true']"
  });

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/75 p-3 backdrop-blur-sm sm:p-5"
      onClick={onClose}
    >
      <section
        ref={surfaceRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`animate-modal-enter flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-ink-900 shadow-2xl shadow-black/70 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)] ${panelClassName}`}
        data-dialog-surface="true"
        role="dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3.5 sm:px-6 sm:py-4">
          <h3 className="min-w-0 truncate text-base font-semibold text-ink-50" id={titleId}>
            {title}
          </h3>
          <button
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
            data-dialog-close="true"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div
          className={`custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6 ${bodyClassName}`}
        >
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
  secondaryLabel,
  loading = false,
  variant = "danger",
  onCancel,
  onSecondary,
  onConfirm
}: {
  title: ReactNode;
  message: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  secondaryLabel?: ReactNode;
  loading?: boolean;
  variant?: "primary" | "danger";
  onCancel: () => void;
  onSecondary?: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const surfaceRef = useDialogFocus<HTMLElement>({
    active: true,
    onDismiss: () => {
      if (!loading) {
        onCancel();
      }
    },
    initialFocusSelector: "[data-dialog-cancel='true']"
  });

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  return (
    <div className="animate-fade-in fixed inset-0 z-[70] grid place-items-center bg-black/75 p-3 backdrop-blur-sm sm:p-5">
      <section
        ref={surfaceRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="animate-modal-enter flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-ink-900 shadow-2xl shadow-black/70 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)]"
        data-dialog-surface="true"
        role="dialog"
        tabIndex={-1}
      >
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-5 sm:px-6 sm:pb-5 sm:pt-6">
        <div className="flex gap-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-rose-500/15 text-rose-400 sm:h-11 sm:w-11">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 pt-0.5 sm:pt-1">
            <h3
              className="text-base font-semibold text-ink-50 sm:text-lg"
              id={titleId}
            >
              {title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-300">{message}</p>
          </div>
        </div>
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-white/[0.08] px-5 py-4 sm:flex-row sm:flex-wrap sm:justify-end sm:px-6">
          <Button
            data-dialog-cancel="true"
            disabled={loading}
            variant="ghost"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button disabled={loading} variant="primary" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          ) : null}
          <Button disabled={loading} variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
