export const sanitizeCharacterHtmlCss = (css: string) =>
  css
    .replace(/<\/?style[^>]*>/gi, "")
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)\s*(?:javascript:|data:text\/html)/gi, "url($1about:blank");

const splitSelectorList = (selectors: string) => {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let index = 0; index < selectors.length; index += 1) {
    const char = selectors[index];
    const previous = selectors[index - 1];

    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
};

const ROOT_SELECTOR_PATTERN = /^(?:(?:html|body|:root)\b\s*)+/i;
const CHAT_UI_SELECTOR_PATTERN =
  /(?:^|[\s>+~,(])(?:#chat-(?:page-root|panel|title|settings-trigger|message-viewport|message-list|pagination|scroll-bottom|quick-replies|quick-replies-toggle|composer|message-input|primary-action|empty-state|opening-frame)\b|\[data-chat-(?:message|bubble|avatar|actions|action|token-info|quick-reply)\b)/i;
const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

const scopeSelector = (selector: string, scope: string) => {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.startsWith(scope)) {
    return trimmed;
  }

  const rootMapped = trimmed.replace(ROOT_SELECTOR_PATTERN, "").trim();
  if (rootMapped !== trimmed) {
    if (!rootMapped) {
      return scope;
    }

    if (/^[>+~]/.test(rootMapped)) {
      return `${scope} ${rootMapped}`;
    }

    return `${scope} ${rootMapped}`;
  }

  return `${scope} ${trimmed}`;
};

const targetsChatUiSelector = (selector: string) => CHAT_UI_SELECTOR_PATTERN.test(selector);

const findMatchingBrace = (css: string, openIndex: number) => {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    const previous = css[index - 1];

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
};

const scopeCssRules = (
  css: string,
  scope: string,
  shouldKeepSelector: (selector: string) => boolean = () => true,
  transformBody: (body: string) => string = (body) => body,
  restrictedAtRules = false
): string => {
  let output = "";
  let cursor = 0;

  while (cursor < css.length) {
    const openIndex = css.indexOf("{", cursor);
    if (openIndex === -1) {
      output += css.slice(cursor);
      break;
    }

    const closeIndex = findMatchingBrace(css, openIndex);
    if (closeIndex === -1) {
      output += css.slice(cursor);
      break;
    }

    const prelude = css.slice(cursor, openIndex);
    const body = css.slice(openIndex + 1, closeIndex);
    const trimmedPrelude = prelude.trim();
    const comparablePrelude = trimmedPrelude.replace(CSS_COMMENT_PATTERN, "").trim();
    const leading = prelude.slice(0, prelude.indexOf(trimmedPrelude));

    if (comparablePrelude.startsWith("@")) {
      if (/^@(media|supports|container|layer)\b/i.test(comparablePrelude)) {
        const scopedBody = scopeCssRules(body, scope, shouldKeepSelector, transformBody, restrictedAtRules);
        if (scopedBody.trim()) {
          output += `${leading}${trimmedPrelude} {${scopedBody}}`;
        }
      } else {
        if (!restrictedAtRules) output += `${prelude}{${body}}`;
      }
    } else {
      const scopedSelectors = splitSelectorList(trimmedPrelude)
        .filter(shouldKeepSelector)
        .map((selector) => scopeSelector(selector, scope))
        .join(", ");
      if (scopedSelectors) {
        const transformedBody = transformBody(body);
        if (transformedBody.trim()) output += `${leading}${scopedSelectors} {${transformedBody}}`;
      }
    }

    cursor = closeIndex + 1;
  }

  return output;
};

const restrictDeclarations = (body: string) => body
  .split(";")
  .map((declaration) => declaration.trim())
  .filter(Boolean)
  .filter((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 1) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/, "");
    if (["animation", "animation-name", "transition", "z-index", "pointer-events"].includes(property)) return false;
    if (property === "display" && value === "none") return false;
    if (property === "visibility" && value === "hidden") return false;
    if (property === "opacity" && Number(value) < 0.4) return false;
    if (property === "position" && (value === "fixed" || value === "sticky")) return false;
    if (property === "outline" && /^(?:0|none)/.test(value)) return false;
    if ((property === "overflow" || property === "overflow-x" || property === "overflow-y") && /^(?:hidden|clip)/.test(value)) return false;
    if (property === "font-size") {
      const match = value.match(/^([\d.]+)(px|rem|em)$/);
      if (match && ((match[2] === "px" && Number(match[1]) < 12) || (match[2] !== "px" && Number(match[1]) < 0.75))) return false;
    }
    return true;
  })
  .join("; ");

export const scopeCharacterHtmlCss = (css: string, scope = ":where(.rp-wrap)") => {
  const sanitized = sanitizeCharacterHtmlCss(css).trim();
  if (!sanitized) {
    return "";
  }

  return scopeCssRules(sanitized, scope);
};

export const scopeCharacterChatUiCss = (css: string, scope = "#chat-page-root") => {
  const sanitized = sanitizeCharacterHtmlCss(css).trim();
  if (!sanitized) {
    return "";
  }

  return scopeCssRules(sanitized, scope, targetsChatUiSelector);
};

export const scopeRestrictedCharacterHtmlCss = (css: string, scope = ":where(.rp-wrap)") => {
  const sanitized = sanitizeCharacterHtmlCss(css).trim();
  return sanitized ? scopeCssRules(sanitized, scope, () => true, restrictDeclarations, true) : "";
};

export const scopeRestrictedCharacterChatUiCss = (css: string, scope = "#chat-page-root") => {
  const sanitized = sanitizeCharacterHtmlCss(css).trim();
  return sanitized ? scopeCssRules(sanitized, scope, targetsChatUiSelector, restrictDeclarations, true) : "";
};
