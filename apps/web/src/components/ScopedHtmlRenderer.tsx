import DOMPurify from "dompurify";
import { useEffect, useRef } from "react";

const RENDERABLE_HTML_PATTERN = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/i;

const BASE_SCOPED_HTML_CSS = `
  :host {
    all: initial;
    display: block;
    color: #e2e8f0;
    font: 400 0.875rem/1.75 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  .roleplay-html-root {
    color: inherit;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .roleplay-html-root > :first-child {
    margin-top: 0;
  }

  .roleplay-html-root > :last-child {
    margin-bottom: 0;
  }

  p, div, section, article, header, footer, main, aside, figure, figcaption,
  ul, ol, li, blockquote, pre, table, h1, h2, h3, h4, h5, h6, hr {
    margin: 0 0 0.8rem;
  }

  h1, h2, h3, h4, h5, h6 {
    color: #f8fafc;
    font-weight: 700;
    line-height: 1.4;
  }

  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.125rem; }
  h3 { font-size: 1rem; }

  p, li, blockquote, td, th, small, span {
    color: inherit;
    line-height: 1.75;
  }

  ul, ol {
    padding-left: 1.25rem;
  }

  a {
    color: #f6ad55;
    text-decoration: underline;
    text-underline-offset: 0.16em;
  }

  img {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: 0.75rem;
  }

  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  code {
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 0.45rem;
    background: rgba(15, 23, 42, 0.72);
    padding: 0.12rem 0.35rem;
    color: #f8fafc;
    font-size: 0.92em;
  }

  pre {
    overflow-x: auto;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 0.85rem;
    background: rgba(15, 23, 42, 0.85);
    padding: 0.8rem 0.9rem;
    white-space: pre-wrap;
  }

  blockquote {
    border-left: 3px solid rgba(245, 158, 11, 0.4);
    padding-left: 0.85rem;
    color: #cbd5e1;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    overflow: hidden;
    border-radius: 0.8rem;
  }

  th, td {
    border: 1px solid rgba(148, 163, 184, 0.14);
    padding: 0.55rem 0.7rem;
    text-align: left;
    vertical-align: top;
  }

  th {
    background: rgba(30, 41, 59, 0.8);
    color: #f8fafc;
    font-weight: 600;
  }

  hr {
    border: 0;
    border-top: 1px solid rgba(148, 163, 184, 0.16);
  }
`;

const HTML_ALLOWED_TAGS = [
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
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
  "colspan",
  "href",
  "id",
  "rel",
  "rowspan",
  "src",
  "target",
  "title"
] as const;

export const containsRenderableHtml = (content: string) => RENDERABLE_HTML_PATTERN.test(content);

const sanitizeCharacterHtmlCss = (css: string) =>
  css
    .replace(/<\/?style[^>]*>/gi, "")
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)\s*(?:javascript:|data:text\/html)/gi, "url($1about:blank");

const sanitizeRenderableHtml = (content: string) =>
  DOMPurify.sanitize(content, {
    ALLOWED_TAGS: [...HTML_ALLOWED_TAGS],
    ALLOWED_ATTR: [...HTML_ALLOWED_ATTR],
    FORBID_TAGS: ["form", "iframe", "input", "button", "meta", "link", "script", "style", "svg", "math"],
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
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const template = document.createElement("template");
    template.innerHTML = sanitizeRenderableHtml(content);

    for (const link of template.content.querySelectorAll("a[href]")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noreferrer noopener nofollow");
    }

    shadowRoot.replaceChildren();

    const styleElement = document.createElement("style");
    styleElement.textContent = `${BASE_SCOPED_HTML_CSS}\n${sanitizeCharacterHtmlCss(htmlCss ?? "")}`;
    shadowRoot.appendChild(styleElement);

    const wrapper = document.createElement("div");
    wrapper.className = "roleplay-html-root";
    wrapper.appendChild(template.content.cloneNode(true));
    shadowRoot.appendChild(wrapper);
  }, [content, htmlCss]);

  return <div ref={hostRef} className={`min-w-0 overflow-hidden [transform:translateZ(0)] ${className}`} />;
}
