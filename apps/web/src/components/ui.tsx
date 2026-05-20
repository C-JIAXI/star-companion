import { HelpCircle } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-ink-900 p-4 shadow-xl shadow-black/20">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const variants = {
    primary: "bg-ember-500 text-ink-950 hover:bg-ember-400",
    ghost: "bg-white/5 text-slate-200 hover:bg-white/10",
    danger: "bg-rose-500/90 text-white hover:bg-rose-500"
  };

  return (
    <button
      className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      type="button"
      {...props}
    />
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className="text-slate-300">{label}</span>
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
          className="inline-grid h-4 w-4 cursor-help place-items-center rounded-full text-slate-500 outline-none transition hover:text-ember-300 focus:text-ember-300"
          role="img"
          tabIndex={0}
        >
          <HelpCircle size={14} />
        </span>
        <span
          className="pointer-events-none absolute left-0 top-5 z-30 hidden w-64 rounded-md border border-white/10 bg-ink-950 px-3 py-2 text-xs leading-5 text-slate-200 shadow-xl shadow-black/30 group-hover:block group-focus-within:block"
          role="tooltip"
        >
          {description}
        </span>
      </span>
    </span>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="min-h-10 w-full min-w-0 rounded-md border border-white/10 bg-ink-950 px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-ember-500"
      {...props}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className="min-h-24 w-full min-w-0 rounded-md border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-ember-500"
      {...props}
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-white/15 p-4 text-sm text-slate-400">
      {children}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return <div className="rounded-md border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">{message}</div>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded bg-white/10 px-2 py-1 text-xs text-slate-300">{children}</span>;
}
