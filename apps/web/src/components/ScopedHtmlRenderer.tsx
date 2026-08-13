import DOMPurify from "dompurify";
import { useEffect, useRef } from "react";
import { scopeCharacterHtmlCss, scopeRestrictedCharacterHtmlCss } from "../lib/characterHtmlCss";
import { useAppStore } from "../store/useAppStore";

const RENDERABLE_HTML_PATTERN = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/i;

const BASE_SCOPED_HTML_CSS = `
:where(.rp-wrap) {
  color: var(--foreground);
  font: 400 0.875rem/var(--reading-line-height, 1.65) ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
  min-width: 0;
}

:where(.rp-wrap),
:where(.rp-wrap) *,
:where(.rp-wrap) *::before,
:where(.rp-wrap) *::after {
  box-sizing: border-box;
}

:where(.rp-wrap) > :first-child {
  margin-top: 0;
}

:where(.rp-wrap) > :last-child {
  margin-bottom: 0;
}

:where(.rp-wrap) p, :where(.rp-wrap) div, :where(.rp-wrap) section, :where(.rp-wrap) article, :where(.rp-wrap) header,
:where(.rp-wrap) footer, :where(.rp-wrap) main, :where(.rp-wrap) aside, :where(.rp-wrap) figure, :where(.rp-wrap) figcaption,
:where(.rp-wrap) ul, :where(.rp-wrap) ol, :where(.rp-wrap) li, :where(.rp-wrap) blockquote, :where(.rp-wrap) pre, :where(.rp-wrap) table,
:where(.rp-wrap) h1, :where(.rp-wrap) h2, :where(.rp-wrap) h3, :where(.rp-wrap) h4, :where(.rp-wrap) h5, :where(.rp-wrap) h6, :where(.rp-wrap) hr {
  margin: 0 0 0.8rem;
}

:where(.rp-wrap) h1, :where(.rp-wrap) h2, :where(.rp-wrap) h3, :where(.rp-wrap) h4, :where(.rp-wrap) h5, :where(.rp-wrap) h6 {
  color: var(--foreground);
  font-weight: 700;
  line-height: 1.4;
}

:where(.rp-wrap) h1 { font-size: 1.25rem; }
:where(.rp-wrap) h2 { font-size: 1.125rem; }
:where(.rp-wrap) h3 { font-size: 1rem; }

:where(.rp-wrap) p, :where(.rp-wrap) li, :where(.rp-wrap) blockquote, :where(.rp-wrap) td, :where(.rp-wrap) th, :where(.rp-wrap) small, :where(.rp-wrap) span {
  color: inherit;
  line-height: var(--reading-line-height, 1.65);
}

:where(.rp-wrap) ul, :where(.rp-wrap) ol {
  padding-left: 1.25rem;
}

:where(.rp-wrap) a {
  color: #f6ad55;
  text-decoration: underline;
  text-underline-offset: 0.16em;
}

:where(.rp-wrap) img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 0.75rem;
}

:where(.rp-wrap) code, :where(.rp-wrap) pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

:where(.rp-wrap) code {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 0.45rem;
  background: rgba(15, 23, 42, 0.72);
  padding: 0.12rem 0.35rem;
  color: #f8fafc;
  font-size: 0.92em;
}

:where(.rp-wrap) pre {
  overflow-x: auto;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 0.85rem;
  background: rgba(15, 23, 42, 0.85);
  padding: 0.8rem 0.9rem;
  white-space: pre-wrap;
  margin: 0;
}

:where(.rp-wrap) .roleplay-code-block {
  position: relative;
  margin: 0.6rem 0;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 0.85rem;
  background: rgba(15, 23, 42, 0.9);
  overflow: hidden;
}

:where(.rp-wrap) .roleplay-code-block pre {
  border: none;
  border-radius: 0;
  background: transparent;
  margin: 0;
  padding: 0.8rem 0.9rem;
}

:where(.rp-wrap) .roleplay-code-block code {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}

:where(.rp-wrap) .roleplay-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.9rem;
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  background: rgba(15, 23, 42, 0.6);
}

:where(.rp-wrap) .roleplay-code-lang-text {
  font-size: 0.7rem;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

:where(.rp-wrap) .roleplay-code-copy {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.5rem;
  border: none;
  border-radius: 0.35rem;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 0.7rem;
  transition: all 0.15s;
}

:where(.rp-wrap) .roleplay-code-copy:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
}

:where(.rp-wrap) blockquote {
  border-left: 3px solid rgba(245, 158, 11, 0.4);
  padding-left: 0.85rem;
  color: #cbd5e1;
}

:where(.rp-wrap) table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
  border-radius: 0.8rem;
}

:where(.rp-wrap) th, :where(.rp-wrap) td {
  border: 1px solid rgba(148, 163, 184, 0.14);
  padding: 0.55rem 0.7rem;
  text-align: left;
  vertical-align: top;
}

:where(.rp-wrap) th {
  background: rgba(30, 41, 59, 0.8);
  color: #f8fafc;
  font-weight: 600;
}

:where(.rp-wrap) hr {
  border: 0;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

:where(.rp-wrap) details {
  margin: 0.6rem 0;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 0.6rem;
}

:where(.rp-wrap) summary {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
  font-weight: 500;
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.5);
  list-style: none;
  user-select: none;
  transition: background 0.15s;
}

:where(.rp-wrap) summary::marker {
  display: none;
  content: "";
}

:where(.rp-wrap) summary::-webkit-details-marker {
  display: none;
}

:where(.rp-wrap) summary:not(:has(*))::before {
  content: "\\25B6";
  font-size: 0.6rem;
  color: #64748b;
  transition: transform 0.2s;
  flex-shrink: 0;
}

:where(.rp-wrap) details[open] > summary:not(:has(*))::before {
  transform: rotate(90deg);
}

:where(.rp-wrap) summary:hover {
  background: rgba(15, 23, 42, 0.7);
  color: #e2e8f0;
}

:where(.rp-wrap) details > :not(summary) {
  padding: 0 0.75rem;
}

:where(.rp-wrap) details > :not(summary):first-child {
  padding-top: 0.35rem;
}

:where(.rp-wrap) details > :not(summary):last-child {
  margin-bottom: 0;
  padding-bottom: 0.4rem;
}

:where(.rp-wrap) details .roleplay-code-block {
  margin: 0.3rem 0;
}

:where(.rp-wrap) font[size="1"] { font-size: 0.75rem; }
:where(.rp-wrap) font[size="2"] { font-size: 0.875rem; }
:where(.rp-wrap) font[size="3"] { font-size: 1rem; }
:where(.rp-wrap) font[size="4"] { font-size: 1.125rem; }
:where(.rp-wrap) font[size="5"] { font-size: 1.5rem; }
:where(.rp-wrap) font[size="6"] { font-size: 2rem; }
:where(.rp-wrap) font[size="7"] { font-size: 2.5rem; }
`;

const HTML_ALLOWED_TAGS = [
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "code",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul"
] as const;

const HTML_ALLOWED_ATTR = [
  "alt",
  "aria-hidden",
  "aria-label",
  "class",
  "color",
  "colspan",
  "face",
  "href",
  "id",
  "data-chat-action",
  "data-chat-actions",
  "data-chat-avatar",
  "data-chat-bubble",
  "data-chat-message",
  "data-chat-quick-reply",
  "data-chat-token-info",
  "open",
  "rel",
  "rowspan",
  "size",
  "src",
  "target",
  "title"
] as const;

export const containsRenderableHtml = (content: string) => RENDERABLE_HTML_PATTERN.test(content);

const sanitizeRenderableHtml = (content: string) =>
  DOMPurify.sanitize(content, {
    ALLOWED_TAGS: [...HTML_ALLOWED_TAGS],
    ALLOWED_ATTR: [...HTML_ALLOWED_ATTR],
    FORBID_TAGS: ["form", "iframe", "input", "meta", "link", "script", "style", "svg", "math"],
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpeg|jpg|webp|avif);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });

export function ScopedHtmlRenderer({
  content,
  htmlCss,
  className = ""
}: {
  content: string;
  htmlCss?: string;
  className?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const characterStyle = useAppStore((state) => state.appearancePreferences.characterStyle);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const sanitized = sanitizeRenderableHtml(content);

    const template = document.createElement("template");
    template.innerHTML = sanitized;

    for (const link of template.content.querySelectorAll("a[href]")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer noopener nofollow");
    }

    for (const image of template.content.querySelectorAll("img[src]")) {
      const source = image.getAttribute("src")?.trim() ?? "";
      if (!/^https:\/\//i.test(source) && !/^data:image\/(?:png|gif|jpeg|jpg|webp|avif);base64,/i.test(source)) {
        image.removeAttribute("src");
      }
      image.setAttribute("referrerpolicy", "no-referrer");
      image.setAttribute("loading", "lazy");
    }

    const FONT_SIZE_MAP: Record<string, string> = {
      "1": "0.75rem",
      "2": "0.875rem",
      "3": "1rem",
      "4": "1.125rem",
      "5": "1.5rem",
      "6": "2rem",
      "7": "2.5rem"
    };

    for (const font of template.content.querySelectorAll("font")) {
      const color = font.getAttribute("color");
      const size = font.getAttribute("size");
      const face = font.getAttribute("face");
      if (color) font.style.color = color;
      if (size && FONT_SIZE_MAP[size]) font.style.fontSize = FONT_SIZE_MAP[size];
      if (face) font.style.fontFamily = face;
    }

    const textWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (parent && (parent.tagName === "PRE" || parent.tagName === "CODE")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes: Text[] = [];
    while (textWalker.nextNode()) {
      textNodes.push(textWalker.currentNode as Text);
    }
    for (const node of textNodes) {
      const text = node.textContent;
      if (text === null) continue;
      if (text.trim() === "") {
        node.remove();
      } else if (/\n{2,}/.test(text)) {
        node.textContent = text.replace(/\n{2,}/g, "\n");
      }
    }

    wrapper.replaceChildren();

    const styleEl = document.createElement("style");
    const customCss = characterStyle === "off"
      ? ""
      : characterStyle === "restricted"
        ? scopeRestrictedCharacterHtmlCss(htmlCss ?? "")
        : scopeCharacterHtmlCss(htmlCss ?? "");
    styleEl.textContent = `${BASE_SCOPED_HTML_CSS}\n${customCss}`;
    wrapper.appendChild(styleEl);

    const root = document.createElement("div");
    root.className = "rp-wrap";
    root.appendChild(template.content.cloneNode(true));
    wrapper.appendChild(root);

    const handleCopyClick = (event: Event) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("roleplay-code-copy")) return;
      const codeBlock = target.closest(".roleplay-code-block");
      if (!codeBlock) return;
      const code = codeBlock.querySelector("pre code");
      if (!code) return;
      void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
        target.textContent = "Copied!";
        setTimeout(() => {
          target.textContent = "Copy";
        }, 1500);
      });
    };

    wrapper.addEventListener("click", handleCopyClick);
    return () => {
      wrapper.removeEventListener("click", handleCopyClick);
    };
  }, [characterStyle, content, htmlCss]);

  return <div ref={wrapperRef} className={`min-w-0 max-w-full ${className}`} />;
}
