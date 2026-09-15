import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep existing editor state in ChatPage; place its view in the shared tool host. */
export function ChatToolContent({ host, children }: { host: HTMLElement | null; children: ReactNode }) {
  return host ? createPortal(children, host) : null;
}
