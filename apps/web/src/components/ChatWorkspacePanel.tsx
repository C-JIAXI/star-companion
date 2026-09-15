import type { ReactNode } from "react";

/** Chat-only shell: other product pages retain the common card-style Panel. */
export function ChatWorkspacePanel({ title, action, children, className = "" }: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`chat-workspace-central ${className}`}>
      <header className="chat-workspace-header" data-testid="chat-workspace-header">
        <div className="min-w-0 flex-1 text-sm font-semibold text-ink-50">{title}</div>
        {action ? <div className="min-w-0 shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
