import { AlertTriangle, GripHorizontal, HelpCircle } from "lucide-react";
import { useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="animate-fade-in min-w-0 rounded-xl border border-white/5 bg-ink-900/80 p-4 shadow-lg shadow-black/20 backdrop-blur-sm transition-all">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "secondary" }) {
  const variants = {
    primary: "bg-ember-500 text-ink-950 hover:bg-ember-400 focus:ring-ember-500/50 shadow-md shadow-ember-500/20",
    secondary: "bg-ink-800 text-slate-200 hover:bg-ink-700 border border-white/5 focus:ring-ink-600/50",
    ghost: "bg-transparent text-slate-300 hover:bg-white/10 hover:text-slate-100 focus:ring-white/20",
    danger: "bg-rose-500/90 text-white hover:bg-rose-500 focus:ring-rose-500/50 shadow-md shadow-rose-500/20"
  };

  return (
    <button
      className={`inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ink-950 active:scale-95 disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${className}`}
      type="button"
      {...props}
    />
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="font-medium text-slate-300">{label}</span>
      {children}
    </label>
  );
}

export function HelpLabel({ label, description }: { label: ReactNode; description: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="group relative inline-flex">
        <span
          aria-label={typeof label === "string" ? `${label} help` : "Field help"}
          className="inline-grid h-4 w-4 cursor-help place-items-center rounded-full text-slate-500 outline-none transition-colors hover:text-ember-400 focus:text-ember-400"
          role="img"
          tabIndex={0}
        >
          <HelpCircle size={14} />
        </span>
        <span
          className="animate-fade-in pointer-events-none absolute left-0 top-6 z-30 hidden w-64 rounded-lg border border-white/10 bg-ink-800/95 backdrop-blur-md px-3 py-2.5 text-xs leading-relaxed text-slate-200 shadow-xl shadow-black/40 group-hover:block group-focus-within:block"
          role="tooltip"
        >
          {description}
        </span>
      </span>
    </span>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-[40px] w-full min-w-0 rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all placeholder:text-slate-500 hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50 ${className}`}
      {...props}
    />
  );
}

export function TextArea({ className = "", style, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [height, setHeight] = useState<number | null>(null);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = {
      y: event.clientY,
      height: textarea.getBoundingClientRect().height
    };
  };

  const resize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current) {
      return;
    }

    const nextHeight = Math.max(100, dragStart.current.height + event.clientY - dragStart.current.y);
    setHeight(nextHeight);
  };

  const stopResize = () => {
    dragStart.current = null;
  };

  return (
    <div className="group min-w-0 rounded-lg border border-white/10 bg-ink-950/50 transition-all hover:border-white/20 focus-within:border-ember-500 focus-within:bg-ink-950 focus-within:ring-1 focus-within:ring-ember-500/50">
      <textarea
        className={`min-h-[100px] w-full min-w-0 resize-none rounded-t-lg border-0 bg-transparent px-3 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-500 ${className}`}
        ref={textareaRef}
        style={{ ...style, ...(height ? { height } : {}) }}
        {...props}
      />
      <button
        aria-label="Resize text area"
        className="grid h-6 w-full cursor-ns-resize place-items-center rounded-b-lg border-t border-white/10 bg-white/[0.03] text-slate-600 transition hover:bg-white/[0.06] hover:text-ember-300 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ember-500/50 group-focus-within:border-ember-500/30 group-focus-within:text-slate-400"
        type="button"
        onPointerDown={startResize}
        onPointerLeave={stopResize}
        onPointerMove={resize}
        onPointerUp={stopResize}
      >
        <GripHorizontal size={16} />
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-slate-400 transition-colors hover:bg-white/[0.04]">
      {children}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div className="animate-fade-in rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-200 shadow-sm flex items-start gap-2">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-400" />
      <span>{message}</span>
    </div>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10">
      {children}
    </span>
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
    <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
      <section
        aria-labelledby="confirm-dialog-title"
        className="animate-scale-in w-full max-w-md rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50"
        role="dialog"
      >
        <div className="flex gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-400 ring-4 ring-rose-500/5">
            <AlertTriangle size={20} />
          </div>
          <div className="min-w-0 pt-1">
            <h3 className="text-lg font-semibold tracking-tight text-slate-100" id="confirm-dialog-title">
              {title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{message}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
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
