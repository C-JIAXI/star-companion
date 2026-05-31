export const sanitizeCharacterHtmlCss = (css: string) =>
  css
    .replace(/<\/?style[^>]*>/gi, "")
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)\s*(?:javascript:|data:text\/html)/gi, "url($1about:blank");
