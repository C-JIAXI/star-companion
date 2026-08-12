export const CHARACTER_HTML_MAX_LENGTH = 200_000;
export const CHARACTER_CSS_MAX_LENGTH = 100_000;
export const CHARACTER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const CHARACTER_AVATAR_MAX_LENGTH = 3_000_000;

export type CharacterQualitySeverity = "error" | "warning" | "suggestion";
export type CharacterQualityField =
  | "name"
  | "avatar"
  | "description"
  | "prefix"
  | "prompt"
  | "suffix"
  | "htmlCss"
  | "openingHtml"
  | "loreEntries"
  | "quickReplies";

export type CharacterQualityCode =
  | "name_required"
  | "prompt_empty"
  | "prompt_budget_large"
  | "prompt_duplicate_segment"
  | "description_matches_prompt"
  | "description_empty"
  | "lore_content_empty"
  | "lore_trigger_invalid"
  | "lore_keywords_missing"
  | "lore_keywords_overlap"
  | "quick_reply_label_empty"
  | "quick_reply_label_duplicate"
  | "quick_reply_content_empty"
  | "opening_html_meaningless"
  | "opening_html_too_large"
  | "html_css_too_large"
  | "avatar_insecure_url"
  | "avatar_invalid_url"
  | "avatar_data_type_invalid"
  | "avatar_data_too_large";

export interface CharacterQualityDraft {
  name: string;
  avatar?: string | null;
  description?: string;
  prefix?: string;
  prompt?: string;
  suffix?: string;
  htmlCss?: string;
  openingHtml?: string;
  loreEntries?: Array<{
    id?: string;
    keys?: string[];
    content?: string;
    priority?: number;
    scope?: string;
    triggerMode?: string;
    alwaysActive?: boolean;
    enabled?: boolean;
  }>;
  quickReplies?: Array<{ id?: string; label?: string; content?: string }>;
}

export interface CharacterQualityIssue {
  code: CharacterQualityCode;
  severity: CharacterQualitySeverity;
  field: CharacterQualityField;
  itemIndex?: number;
  message: { "zh-CN": string; en: string };
  action: { type: "focus"; field: CharacterQualityField; itemIndex?: number };
}

export interface CharacterPromptBudgetEstimate {
  prefixTokens: number;
  promptTokens: number;
  suffixTokens: number;
  alwaysActiveLoreTokens: number;
  totalTokens: number;
  estimated: true;
}

export interface CharacterQualityResult {
  issues: CharacterQualityIssue[];
  budget: CharacterPromptBudgetEstimate;
  protectedContentAvailable: boolean;
}

const messages: Record<CharacterQualityCode, { "zh-CN": string; en: string }> = {
  name_required: { "zh-CN": "名称不能为空。", en: "Name is required." },
  prompt_empty: {
    "zh-CN": "核心角色设定为空；角色回复可能缺少稳定方向。",
    en: "The core character prompt is empty, so replies may lack a stable direction."
  },
  prompt_budget_large: {
    "zh-CN": "角色 Prompt 估算超过 8,000 tokens，可能挤占聊天上下文。",
    en: "The character prompt is estimated above 8,000 tokens and may crowd out chat context."
  },
  prompt_duplicate_segment: {
    "zh-CN": "prefix、核心设定或 suffix 中存在完全重复的大段内容。",
    en: "A large block is duplicated across prefix, core prompt, or suffix."
  },
  description_matches_prompt: {
    "zh-CN": "简介与核心设定完全相同；可能误把展示简介填入了 Prompt。",
    en: "Description and core prompt are identical; display copy may have been pasted into the prompt."
  },
  description_empty: {
    "zh-CN": "可补充一句简介，便于在角色库中辨认。",
    en: "Consider adding a short description so the character is easier to identify in the library."
  },
  lore_content_empty: { "zh-CN": "Lore 条目内容不能为空。", en: "Lore entry content cannot be empty." },
  lore_trigger_invalid: {
    "zh-CN": "Lore 条目的作用位置或触发范围无效。",
    en: "The lore entry has an invalid placement or trigger scope."
  },
  lore_keywords_missing: {
    "zh-CN": "普通触发 Lore 没有有效关键词，因此不会被命中。",
    en: "A normally triggered lore entry has no valid keywords and cannot match."
  },
  lore_keywords_overlap: {
    "zh-CN": "Lore 条目之间存在重复或高度重叠的关键词。",
    en: "Lore entries contain duplicate or highly overlapping keywords."
  },
  quick_reply_label_empty: { "zh-CN": "快捷回复标签不能为空。", en: "Quick reply label cannot be empty." },
  quick_reply_label_duplicate: {
    "zh-CN": "快捷回复标签重复，用户难以区分。",
    en: "Quick reply labels are duplicated and hard to distinguish."
  },
  quick_reply_content_empty: { "zh-CN": "快捷回复内容不能为空。", en: "Quick reply content cannot be empty." },
  opening_html_meaningless: {
    "zh-CN": "开场展示只包含空标签或空白内容。",
    en: "Opening display contains only empty tags or whitespace."
  },
  opening_html_too_large: {
    "zh-CN": "开场 HTML 超过 200,000 字符的安全上限。",
    en: "Opening HTML exceeds the 200,000-character safety limit."
  },
  html_css_too_large: {
    "zh-CN": "角色 CSS 超过 100,000 字符的安全上限。",
    en: "Character CSS exceeds the 100,000-character safety limit."
  },
  avatar_insecure_url: {
    "zh-CN": "头像使用非 HTTPS 地址；请改用 HTTPS 或本地上传。",
    en: "Avatar uses a non-HTTPS address; use HTTPS or a local upload."
  },
  avatar_invalid_url: {
    "zh-CN": "头像必须是 HTTPS 图片地址或受支持的图片 data URL。",
    en: "Avatar must be an HTTPS image URL or a supported image data URL."
  },
  avatar_data_type_invalid: {
    "zh-CN": "头像 data URL 类型不受支持。",
    en: "The avatar data URL image type is not supported."
  },
  avatar_data_too_large: {
    "zh-CN": "头像超过 2 MB 文件上限。",
    en: "Avatar exceeds the 2 MB file limit."
  }
};

const issue = (
  code: CharacterQualityCode,
  severity: CharacterQualitySeverity,
  field: CharacterQualityField,
  itemIndex?: number
): CharacterQualityIssue => ({
  code,
  severity,
  field,
  ...(itemIndex === undefined ? {} : { itemIndex }),
  message: messages[code],
  action: { type: "focus", field, ...(itemIndex === undefined ? {} : { itemIndex }) }
});

const normalize = (value = "") => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const meaningfulParagraphs = (value = "") =>
  value
    .split(/\n\s*\n/)
    .map(normalize)
    .filter((part) => part.length >= 80);

export const estimateCharacterTokens = (value = "") => {
  const normalized = value.trim();
  if (!normalized) return 0;
  const cjk = normalized.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const remainder = normalized.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, "").length;
  return cjk + Math.ceil(remainder / 4);
};

export const estimateCharacterPromptBudget = (
  draft: CharacterQualityDraft,
  protectedContentAvailable = true
): CharacterPromptBudgetEstimate => {
  if (!protectedContentAvailable) {
    return { prefixTokens: 0, promptTokens: 0, suffixTokens: 0, alwaysActiveLoreTokens: 0, totalTokens: 0, estimated: true };
  }
  const prefixTokens = estimateCharacterTokens(draft.prefix);
  const promptTokens = estimateCharacterTokens(draft.prompt);
  const suffixTokens = estimateCharacterTokens(draft.suffix);
  const alwaysActiveLoreTokens = (draft.loreEntries ?? [])
    .filter((entry) => entry.enabled !== false && entry.alwaysActive)
    .reduce((sum, entry) => sum + estimateCharacterTokens(entry.content), 0);
  return {
    prefixTokens,
    promptTokens,
    suffixTokens,
    alwaysActiveLoreTokens,
    totalTokens: prefixTokens + promptTokens + suffixTokens + alwaysActiveLoreTokens,
    estimated: true
  };
};

const validateAvatar = (avatar: string, issues: CharacterQualityIssue[]) => {
  const value = avatar.trim();
  if (!value) return;
  if (value.length > CHARACTER_AVATAR_MAX_LENGTH) {
    issues.push(issue("avatar_data_too_large", "error", "avatar"));
    return;
  }
  if (/^data:/i.test(value)) {
    const match = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(value);
    if (!match || !/^image\/(?:png|jpe?g|webp|gif|avif)$/i.test(match[1])) {
      issues.push(issue("avatar_data_type_invalid", "error", "avatar"));
      return;
    }
    const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
    if (Math.floor((match[2].length * 3) / 4) - padding > CHARACTER_AVATAR_MAX_BYTES) {
      issues.push(issue("avatar_data_too_large", "error", "avatar"));
    }
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") issues.push(issue(url.protocol === "http:" ? "avatar_insecure_url" : "avatar_invalid_url", url.protocol === "http:" ? "warning" : "error", "avatar"));
  } catch {
    issues.push(issue("avatar_invalid_url", "error", "avatar"));
  }
};

export const checkCharacterQuality = (
  draft: CharacterQualityDraft,
  options: { protectedContentAvailable?: boolean } = {}
): CharacterQualityResult => {
  const protectedContentAvailable = options.protectedContentAvailable !== false;
  const issues: CharacterQualityIssue[] = [];
  if (!draft.name.trim()) issues.push(issue("name_required", "error", "name"));
  if (!draft.description?.trim()) issues.push(issue("description_empty", "suggestion", "description"));
  validateAvatar(draft.avatar ?? "", issues);

  if (protectedContentAvailable) {
    if (!draft.prompt?.trim()) issues.push(issue("prompt_empty", "warning", "prompt"));
    const budget = estimateCharacterPromptBudget(draft);
    if (budget.totalTokens > 8_000) issues.push(issue("prompt_budget_large", "warning", "prompt"));
    const segments = [draft.prefix ?? "", draft.prompt ?? "", draft.suffix ?? ""].map(meaningfulParagraphs);
    const seen = new Set<string>();
    let duplicate = false;
    for (const group of segments) for (const segment of group) {
      if (seen.has(segment)) duplicate = true;
      seen.add(segment);
    }
    if (duplicate) issues.push(issue("prompt_duplicate_segment", "warning", "prompt"));
    if (normalize(draft.description) && normalize(draft.description) === normalize(draft.prompt)) {
      issues.push(issue("description_matches_prompt", "warning", "description"));
    }
    const loreKeySets: Array<{ index: number; keys: Set<string> }> = [];
    for (const [index, entry] of (draft.loreEntries ?? []).entries()) {
      if (!entry.content?.trim()) issues.push(issue("lore_content_empty", "error", "loreEntries", index));
      if (!["prefix", "prompt", "suffix"].includes(entry.scope ?? "prompt") || !["user", "assistant", "both"].includes(entry.triggerMode ?? "both")) {
        issues.push(issue("lore_trigger_invalid", "error", "loreEntries", index));
      }
      const keys = new Set((entry.keys ?? []).map(normalize).filter(Boolean));
      if (entry.enabled !== false && !entry.alwaysActive && keys.size === 0) issues.push(issue("lore_keywords_missing", "warning", "loreEntries", index));
      loreKeySets.push({ index, keys });
    }
    outer: for (let left = 0; left < loreKeySets.length; left += 1) {
      for (let right = left + 1; right < loreKeySets.length; right += 1) {
        const a = loreKeySets[left].keys;
        const b = loreKeySets[right].keys;
        if (!a.size || !b.size) continue;
        const overlap = [...a].filter((key) => b.has(key)).length;
        if (overlap > 0 && (overlap === Math.min(a.size, b.size) || overlap / new Set([...a, ...b]).size >= 0.6)) {
          issues.push(issue("lore_keywords_overlap", "warning", "loreEntries", loreKeySets[right].index));
          break outer;
        }
      }
    }
    if ((draft.openingHtml?.length ?? 0) > CHARACTER_HTML_MAX_LENGTH) issues.push(issue("opening_html_too_large", "error", "openingHtml"));
    const opening = draft.openingHtml?.trim() ?? "";
    if (opening && !opening.replace(/<[^>]*>/g, "").replace(/&(?:nbsp|#160|#xA0);/gi, "").trim()) {
      issues.push(issue("opening_html_meaningless", "warning", "openingHtml"));
    }
    if ((draft.htmlCss?.length ?? 0) > CHARACTER_CSS_MAX_LENGTH) issues.push(issue("html_css_too_large", "error", "htmlCss"));
  }

  const seenLabels = new Set<string>();
  for (const [index, reply] of (draft.quickReplies ?? []).entries()) {
    const label = normalize(reply.label);
    if (!label) issues.push(issue("quick_reply_label_empty", "error", "quickReplies", index));
    else if (seenLabels.has(label)) issues.push(issue("quick_reply_label_duplicate", "warning", "quickReplies", index));
    seenLabels.add(label);
    if (!reply.content?.trim()) issues.push(issue("quick_reply_content_empty", "error", "quickReplies", index));
  }

  return { issues, budget: estimateCharacterPromptBudget(draft, protectedContentAvailable), protectedContentAvailable };
};
