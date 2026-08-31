import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type E2ECharacter = {
  id: string;
  name: string;
  cardId?: string;
  description?: string;
  prompt?: string;
  tags?: string[];
};

type E2EChat = {
  id: string;
  title: string;
  characterId?: string;
  parentChatId?: string | null;
  messageCount?: number;
  lastMessagePreview?: {
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  } | null;
};

type E2EChatDetails = E2EChat & {
  userPersona: string;
  userAvatar?: string;
};

type E2EProviderModel = {
  id: string;
  label: string;
  model: string;
  contextWindow?: number;
  capabilities?: Array<
    "text_generation" |
    "text_embedding" |
    "audio_transcription" |
    "text_to_speech" |
    "image_generation" |
    "vision_input"
  >;
};

type E2EProviderProfile = {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  key?: string;
  models: E2EProviderModel[];
};

type SettingsPutPayload = {
  activeProvider?: string;
  apiBaseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  language?: string;
  providers?: E2EProviderProfile[];
  activeProviderId?: string;
  activeModelId?: string;
  apiKey?: string;
  moduleModelPreferences?: Record<string, { providerId: string; modelId: string }>;
  userPersonaPresets?: Array<{
    id: string;
    name: string;
    avatar: string;
    config: { displayName: string; prefix: string; prompt: string; suffix: string };
    createdAt: string;
    updatedAt: string;
  }>;
  userProfileSummary?: string;
  appearancePreferences?: Record<string, unknown>;
};

type ApiDataResponse<T> = {
  data?: T;
};

const readinessFixture = (overrides: Record<string, unknown> = {}) => ({
  serverReachable: true,
  appLocked: false,
  hasCharacter: false,
  hasAvailableCharacter: false,
  hasChat: false,
  hasProvider: false,
  hasApiKey: false,
  hasActiveModel: false,
  chatModuleAssigned: false,
  chatModelSupportsText: false,
  visionAvailable: false,
  budgetAllowsChat: true,
  configurationValid: false,
  ready: false,
  overallStatus: "needs_configuration",
  connectionStatus: {
    status: "untested", mode: null, testId: null, providerKind: null,
    providerId: null, modelId: null, checkedAt: null, errorCode: null,
    diagnosticId: null, summary: null, retryable: false,
    suggestedAction: "test_connection", mayIncurCost: false
  },
  nextRecommendedAction: "create_character",
  issues: [],
  characterCount: 0,
  chatCount: 0,
  computedAt: new Date().toISOString(),
  ...overrides
});

const importBackupViaApi = async (request: APIRequestContext, data: Record<string, unknown>) => {
  const previewResponse = await request.post("/api/backups/preview", { data });
  expect(previewResponse.ok()).toBeTruthy();
  const preview = (await previewResponse.json()) as ApiDataResponse<{
    previewId: string;
    canExecute: boolean;
    conflicts: Array<{ key: string }>;
  }>;
  expect(preview.data?.canExecute).toBeTruthy();
  return request.post("/api/backups/import", {
    data: {
      ...data,
      previewId: preview.data?.previewId,
      conflictResolutions: (preview.data?.conflicts ?? []).map((conflict) => ({
        key: conflict.key,
        action: "use_incoming"
      }))
    }
  });
};

const e2ePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=";

const permanentlyDeleteChatViaApi = async (
  request: APIRequestContext,
  chatId: string,
  visited = new Set<string>()
) => {
  if (visited.has(chatId)) {
    return;
  }
  visited.add(chatId);

  const listResponse = await request.get("/api/chats");
  if (listResponse.ok()) {
    const chats = ((await listResponse.json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    for (const child of chats.filter((chat) => chat.parentChatId === chatId)) {
      await permanentlyDeleteChatViaApi(request, child.id, visited);
    }
  }

  await request.delete(`/api/chats/${chatId}`);
  await request.delete(`/api/chats/${chatId}/permanent`);
};

const openChatHistoryAndSelect = async (page: Page, title: string) => {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1024) {
    await page.getByRole("button", { name: /Toggle navigation/ }).click();
  }

  await page.getByRole("button", { name: /历史|History/ }).click();
  await page.getByPlaceholder(/搜索历史对话|Search chat history/).fill(title);
  await page.locator("[data-chat-history-title]").filter({ hasText: title }).first().click();
};

const selectChatFromHistory = async (page: Page, title: string) => {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1024) {
    await page.getByRole("button", { name: /Toggle navigation/ }).click();
  }

  await page.getByRole("button", { name: /历史|History/ }).click();
  await page.locator("[data-chat-history-title]").filter({ hasText: title }).first().click();
};

const clickHistoryRowAction = async (row: Locator, action: string) => {
  await row.getByTestId("chat-history-row-actions").click();
  await row.locator(`[data-chat-action="${action}"]`).click();
};

const createPrivateCharacterCardFile = async (name: string, password: string) => {
  const salt = randomBytes(16).toString("base64url");
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const passwordSalt = randomBytes(16).toString("base64url");
  const accessControl = {
    version: 1 as const,
    salt: passwordSalt,
    verifier: scryptSync(password, passwordSalt, 32).toString("base64url")
  };
  const payload = {
    version: 1,
    accessControl,
    prefix: "Hidden private prefix.",
    prompt: "Hidden private prompt.",
    suffix: "Hidden private suffix.",
    htmlCss: ".private-card { color: #abc; }",
    loreEntries: []
  };
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const card = {
    schemaVersion: 1,
    format: "character-card",
    visibility: "private",
    cardId: `private-character-card-${Date.now()}`,
    exportedAt: new Date().toISOString(),
    character: {
      name,
      avatar: null,
      openingHtml: "<section>Hidden private opening.</section>"
    },
    protectedPayload: {
      version: 1,
      algorithm: "aes-256-gcm",
      salt,
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      accessControl
    }
  };

  const directory = await mkdtemp(path.join(tmpdir(), "private-character-card-"));
  const filePath = path.join(directory, "card.json");
  await writeFile(filePath, JSON.stringify(card), "utf8");

  return {
    directory,
    filePath
  };
};

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title === "chat readiness surfaces missing first-run setup and links to settings") return;
  await page.addInitScript(() => {
    window.localStorage.setItem("star-companion:onboarding:v1", JSON.stringify({ dismissed: true, completed: false, lastStep: 0 }));
  });
});

test("changing language does not immediately reload stale server settings", async ({ page }) => {
  let settingsGetCount = 0;
  const now = new Date().toISOString();

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    settingsGetCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "zh-CN",
          providers: [],
          activeProviderId: "",
          activeModelId: "",
          userProfileSummary: "",
          autoSummarizeUser: true,
          showMessageAvatars: true,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: false
        }
      })
    });
  });

  await page.goto("/settings");
  const languageSelect = page.locator("select", { has: page.locator('option[value="en"]') });
  await expect(languageSelect).toBeVisible();
  await expect(languageSelect).toHaveValue("zh-CN");
  const settingsGetCountAfterLoad = settingsGetCount;

  await languageSelect.selectOption("en");
  await expect(page.getByRole("heading", { name: "Model Settings" })).toBeVisible();
  await page.waitForTimeout(500);

  await expect(languageSelect).toHaveValue("en");
  expect(settingsGetCount).toBe(settingsGetCountAfterLoad);
});

test("voice playback preferences can be saved from settings", async ({ page }) => {
  const now = new Date().toISOString();
  const baseSettings = {
    id: "voice-form-settings-e2e",
    activeProvider: "openai-compatible",
    apiBaseUrl: "https://example.invalid/v1",
    model: "chat-model",
    temperature: 0.8,
    maxTokens: 800,
    topP: 1,
    language: "en",
    providers: [],
    activeProviderId: "",
    activeModelId: "",
    moduleModelPreferences: {},
    userPersonaPresets: [],
    userProfileSummary: "",
    autoSummarizeUser: false,
    showMessageAvatars: true,
    showMessageTimestamps: false,
    ttsVoice: "alloy",
    ttsPlaybackRate: 1,
    ttsAutoPlay: false,
    userProfileUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
    hasApiKey: false
  };
  let savedPayload: Record<string, unknown> | null = null;

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      savedPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { ...baseSettings, ...savedPayload } })
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: baseSettings })
    });
  });

  await page.goto("/settings");
  await page.getByTestId("settings-tts-voice").fill("nova");
  await page.getByTestId("settings-tts-playback-rate").fill("1.4");
  await page.getByTestId("settings-tts-auto-play").check();
  await page.getByTestId("settings-save").click();

  await expect.poll(() => savedPayload).toEqual(
    expect.objectContaining({
      ttsVoice: "nova",
      ttsPlaybackRate: 1.4,
      ttsAutoPlay: true
    })
  );
  await expect(page.getByText("Settings saved locally.")).toBeVisible();
});

test("direct routes render their workspace headers", async ({ page }) => {
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: /角色工坊|Character Studio/ })).toBeVisible();

  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: /应用文档|App Docs/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /快速上手|Quick Start/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /聊天工作台|Chat Workbench/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /设置与安全|Settings and Security/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /样式参考|Appearance Reference/ })).toBeVisible();
  await expect(page.getByText("#chat-composer", { exact: true })).toBeVisible();
  const copyCssButton = page.getByRole("button", { name: /复制 CSS|Copy CSS/ }).first();
  await copyCssButton.click();
  await expect(page.getByRole("button", { name: /已复制|Copied/ })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /模型设置|Model Settings/ })).toBeVisible();
});

test("appearance preferences preview, persist, reset, and bootstrap without a theme flash", async ({ page }) => {
  const now = new Date().toISOString();
  const defaults = { themeMode: "system", fontSize: "standard", lineHeight: "comfortable", chatWidth: "standard", messageSpacing: "standard", contrast: "standard", motion: "system", backgroundOverlay: 0.55, backgroundBlur: "subtle", characterStyle: "full" };
  const settings = {
    id: "appearance-settings-e2e", activeProvider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", model: "chat-model",
    temperature: 0.8, maxTokens: 800, topP: 1, language: "en", providers: [], activeProviderId: "", activeModelId: "",
    moduleModelPreferences: {}, userPersonaPresets: [], userProfileSummary: "", autoSummarizeUser: false,
    showMessageAvatars: true, showMessageTimestamps: false, ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false,
    appearancePreferences: { ...defaults }, userProfileUpdatedAt: null, createdAt: now, updatedAt: now, hasApiKey: false
  };

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") {
      Object.assign(settings, route.request().postDataJSON());
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: settings }) });
  });

  await page.goto("/settings");
  await page.getByTestId("settings-section-appearance").click();
  await page.getByTestId("appearance-theme").selectOption("light");
  await page.getByTestId("appearance-font-size").selectOption("large");
  await page.getByTestId("appearance-motion").selectOption("reduced");
  await page.getByTestId("appearance-character-style").selectOption("restricted");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  const lightContrast = await new AxeBuilder({ page })
    .include("#main-content")
    .withRules(["color-contrast"])
    .analyze();
  expect(lightContrast.violations, "light theme text contrast").toEqual([]);
  await expect(page.getByTestId("appearance-settings")).toHaveScreenshot("appearance-settings-light.png", { animations: "disabled" });
  await page.getByTestId("settings-save").click();
  await expect.poll(() => settings.appearancePreferences).toEqual(expect.objectContaining({ themeMode: "light", fontSize: "large", motion: "reduced", characterStyle: "restricted" }));

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await page.getByTestId("settings-section-appearance").click();
  await page.getByTestId("appearance-reset").click();
  await page.getByRole("button", { name: "Reset defaults" }).click();
  await expect(page.getByTestId("appearance-theme")).toHaveValue("system");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByTestId("appearance-font-size").selectOption("extra-large");
  await expect(page.getByTestId("appearance-preview")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByTestId("appearance-preview").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("appearance-preview")).toHaveScreenshot("appearance-preview-320px-extra-large.png", { animations: "disabled" });
  await page.evaluate(() => window.dispatchEvent(new Event("star-companion:privacy-locked")));
  await expect(page.getByTestId("privacy-lock-screen")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "large");
  await expect(page.locator("[data-chat-background-layer]")).toHaveCount(0);
});

test("critical navigation and settings controls pass automated accessibility checks", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  for (const pathName of ["/", "/characters", "/settings", "/docs"]) {
    await page.goto(pathName);
    await expect(page.getByTestId("workspace-loading")).toHaveCount(0);
    if (pathName === "/settings") await page.getByTestId("settings-section-appearance").click();
    const results = await new AxeBuilder({ page }).withRules([
      "aria-allowed-attr",
      "aria-required-attr",
      "aria-valid-attr-value",
      "button-name",
      "color-contrast",
      "document-title",
      "html-has-lang",
      "label",
      "link-name"
    ]).analyze();
    expect(results.violations, `${pathName} accessibility violations`).toEqual([]);
  }

  const skipLink = page.locator(".skip-link");
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("invalid appearance bootstrap data falls back before the server responds", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("star-companion:appearance-v1", JSON.stringify({ themeMode: "neon", fontSize: "huge", motion: "spin", backgroundOverlay: 9, characterStyle: "unsafe" })));
  await page.route("**/api/settings", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "standard");
  await expect(page.locator("html")).toHaveAttribute("data-motion-preference", "system");
  await expect(page.locator("html")).toHaveAttribute("data-character-style", "full");
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--chat-background-overlay").trim())).toBe("0.55");
});

test("storage health previews every cleanup and remains usable on mobile", async ({ page }) => {
  const generatedAt = new Date().toISOString();
  const summary = {
    generatedAt, platform: "server", databaseBytes: 4096, reclaimableDatabaseBytes: 1024, freeDiskBytes: 2_000_000_000,
    categories: [
      { id: "database", label: "SQLite database", count: 1, bytes: 4096, measurement: "exact", reclaimableBytes: 1024 },
      { id: "media_orphans", label: "Unreferenced media assets", count: 2, bytes: 800, measurement: "exact", reclaimableBytes: 800 }
    ],
    issues: [{ code: "orphan_media", severity: "info", category: "media", message: "Unreferenced image assets can be safely removed.", count: 2, repairAction: "orphan_media" }],
    overall: "healthy", capabilities: { deepScan: true, fileSystemInspection: true, upgradeRecoveryCleanup: true, appTempCleanup: true, vacuum: true }, activeDeepScanId: null
  };
  let scanPolls = 0;
  await page.route("**/api/storage-health/summary", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: summary }) }));
  await page.route("**/api/storage-health/deep-scans", (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, data: { id: "scan-e2e", state: "running", startedAt: generatedAt, completedAt: null, progress: 0, checkedItems: 0, totalItems: 2, issues: [], errorCode: null } }) }));
  await page.route("**/api/storage-health/deep-scans/scan-e2e", (route) => { scanPolls += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { id: "scan-e2e", state: scanPolls > 1 ? "completed" : "running", startedAt: generatedAt, completedAt: scanPolls > 1 ? generatedAt : null, progress: scanPolls > 1 ? 100 : 50, checkedItems: scanPolls > 1 ? 2 : 1, totalItems: 2, issues: [], errorCode: null } }) }); });
  await page.route("**/api/storage-health/cleanup-plans", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, data: { id: "plan-e2e", createdAt: generatedAt, expiresAt: new Date(Date.now() + 300_000).toISOString(), fingerprint: "safe-plan", items: [{ action: "orphan_media", count: 2, estimatedBytes: 800, supported: true, warning: null }] } }) }));
  await page.route("**/api/storage-health/cleanup-plans/plan-e2e/execute", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirm: "EXECUTE_STORAGE_CLEANUP" });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { planId: "plan-e2e", completedAt: generatedAt, items: [{ action: "orphan_media", status: "completed", count: 2, reclaimedBytes: 800, errorCode: null }] } }) });
  });

  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/settings?section=storage");
  await page.getByTestId("settings-section-storage").click();
  const center = page.getByTestId("storage-health-center");
  await expect(center).toBeVisible();
  await expect(center.getByTestId("storage-category-database")).toContainText("4.00 KB");
  const checkboxes = center.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(9);
  for (let index = 0; index < 9; index += 1) await expect(checkboxes.nth(index)).not.toBeChecked();
  await center.getByRole("button", { name: /运行深度检查|Run deep check/ }).click();
  await expect(center.getByText(/completed/)).toBeVisible({ timeout: 5000 });
  await checkboxes.nth(1).check();
  await center.getByRole("button", { name: /生成清理预览|Preview selected actions/ }).click();
  await expect(page.getByText(/计划将在 5 分钟后过期|plan expires in 5 minutes/)).toBeVisible();
  await page.getByRole("button", { name: /确认执行计划|Confirm plan execution/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /维护完成|Maintenance finished/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include('[data-testid="storage-health-center"]').withRules(["button-name", "color-contrast", "label"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("usage and reliability panel hides all details behind the session privacy lock", async ({ page }) => {
  const now = new Date().toISOString();
  let privacyLocked = false;
  const settings = {
    id: "usage-settings-e2e",
    activeProvider: "openai-compatible",
    apiBaseUrl: "https://example.invalid/v1",
    model: "priced-model",
    temperature: 0.8,
    maxTokens: 800,
    topP: 1,
    language: "en",
    providers: [{
      id: "provider-local",
      label: "Local provider",
      provider: "openai-compatible",
      apiBaseUrl: "https://example.invalid/v1",
      hasKey: true,
      models: [{
        id: "model-local",
        label: "Priced model",
        model: "priced-model",
        capabilities: ["text_generation"],
        pricing: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 6_000_000, currency: "USD", updatedAt: now, source: "user" }
      }]
    }],
    activeProviderId: "provider-local",
    activeModelId: "model-local",
    moduleModelPreferences: {},
    modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
    usageBudgets: { dailySoftMicros: null, dailyHardMicros: 5_000_000, monthlySoftMicros: null, monthlyHardMicros: null, allowUnknownPricing: true },
    usageTimezone: "UTC",
    userPersonaPresets: [],
    userProfileSummary: "",
    autoSummarizeUser: false,
    showMessageAvatars: true,
    showMessageTimestamps: false,
    ttsVoice: "alloy",
    ttsPlaybackRate: 1,
    ttsAutoPlay: false,
    userProfileUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
    hasApiKey: true
  };
  let clearRequested = false;
  await page.route("**/api/privacy/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { locked: privacyLocked } })
  }));
  await page.route("**/api/privacy/lock", async (route) => {
    privacyLocked = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { locked: true } })
    });
  });
  await page.route("**/api/privacy/unlock", async (route) => {
    const body = route.request().postDataJSON() as { passcode?: string };
    if (body.passcode !== "2468") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Incorrect unlock code." })
      });
      return;
    }
    privacyLocked = false;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { locked: false } })
    });
  });
  await page.route("**/api/settings", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: settings }) }));
  await page.route("**/api/usage/summary**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: {
      from: now, to: now, todayCostMicros: 125_000, monthCostMicros: 500_000,
      todayTokens: 30, monthTokens: 120, unknownCostAttempts: 1,
      budgets: settings.usageBudgets, timezone: "UTC",
      byModule: [{ key: "chat", label: "chat", attempts: 2, succeeded: 1, failed: 1, retries: 1, fallbacks: 0, promptTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCostMicros: 125_000, unknownCostAttempts: 1 }],
      byProvider: [], byModel: [],
      byChat: [{ key: "chat-private", label: "Private Chat Title", attempts: 1, succeeded: 1, failed: 0, retries: 0, fallbacks: 0, promptTokens: 8, outputTokens: 4, totalTokens: 12, estimatedCostMicros: 40, unknownCostAttempts: 0 }],
      recent: [{ attemptId: "attempt-e2e", requestId: "request-e2e", attemptNumber: 2, module: "chat", chatId: "chat-private", chatTitle: "Private Chat Title", messageId: null, providerId: "provider-local", providerType: "openai-compatible", modelId: "priced-model", startedAt: now, completedAt: now, status: "succeeded", promptTokens: 8, outputTokens: 4, totalTokens: 12, usageSource: "provider", inputPriceMicros: 2_000_000, outputPriceMicros: 6_000_000, estimatedCostMicros: 40, currency: "USD", specialTokensUnknown: false, usedFallback: false, errorCode: null }]
    } })
  }));
  await page.route("**/api/usage/history", async (route) => {
    clearRequested = true;
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ confirm: "DELETE_USAGE_HISTORY" });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { attempts: 2, requests: 2 } }) });
  });

  await page.goto("/settings?section=usage");
  await page.getByTestId("settings-section-usage").click();
  const panel = page.getByTestId("usage-budget-panel");
  await expect(panel).toContainText("$0.1250");
  await expect(panel).toContainText("Unknown-cost calls");
  await expect(panel).toContainText("Succeeded / failed");
  await expect(panel).toContainText("1 / 1");
  await expect(panel).toContainText("Retries / fallbacks");
  await expect(panel).toContainText("Daily hard budget / left");
  await expect(panel).toContainText("$5.00 / $4.88");
  await expect(panel).toContainText("Private Chat Title");
  await expect(panel).toContainText("Enable safe automatic retries");
  await expect(panel).toContainText("I consent to automatic chat model switching");

  await panel.getByRole("button", { name: "Private Chat Title" }).first().click();
  await expect.poll(() => page.url()).toMatch(/\/$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("star-companion:selected-chat"))).toBe("chat-private");
  await page.goto("/settings?section=usage");
  await page.getByTestId("settings-section-usage").click();

  await panel.getByRole("button", { name: "Clear usage history" }).click();
  await expect(page.getByText("This deletes only local call and cost history.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(clearRequested).toBe(false);

  await page.getByTestId("privacy-lock-passcode").fill("2468");
  await page.getByTestId("privacy-lock-confirm").fill("2468");
  await page.getByTestId("privacy-lock-action").click();
  await expect(page.getByTestId("privacy-lock-screen")).toBeVisible();
  await expect(page.getByTestId("usage-budget-panel")).toHaveCount(0);
  await expect(page.getByText("Private Chat Title")).toHaveCount(0);
  await page.getByTestId("privacy-unlock-input").fill("wrong");
  await page.getByTestId("privacy-unlock-submit").click();
  await expect(page.getByRole("alert")).toContainText("Incorrect unlock code");
  await page.getByTestId("privacy-unlock-input").fill("2468");
  await page.getByTestId("privacy-unlock-submit").click();
  await expect(page.getByTestId("usage-budget-panel")).toBeVisible();
});

test("about and updates shows safe migration state and uses a mocked desktop updater", async ({ page }) => {
  await page.addInitScript(() => {
    let state: DesktopUpdateState = {
      status: "idle",
      currentVersion: "1.0.2",
      availableVersion: null,
      releaseNotes: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      lastCheckedAt: null,
      errorCode: null,
      disabledReason: null
    };
    const listeners: Array<(next: DesktopUpdateState) => void> = [];
    const emit = (next: DesktopUpdateState) => {
      state = next;
      listeners.forEach((listener) => listener(state));
    };
    window.starCompanionDesktop = {
      getUpdateState: async () => state,
      checkForUpdates: async () => {
        emit({ ...state, status: "available", availableVersion: "1.1.0", releaseNotes: "Privacy-safe update notes", lastCheckedAt: "2026-08-10T12:00:00.000Z" });
        return state;
      },
      downloadUpdate: async () => {
        emit({ ...state, status: "downloading", progressPercent: 42, transferredBytes: 42, totalBytes: 100 });
        window.setTimeout(() => emit({ ...state, status: "downloaded", progressPercent: 100, transferredBytes: 100, totalBytes: 100 }), 500);
        return state;
      },
      deferUpdate: async () => {
        emit({ ...state, status: "deferred" });
        return state;
      },
      installUpdate: async () => {
        (window as Window & { __mockInstalled?: boolean }).__mockInstalled = true;
        emit({ ...state, status: "installing" });
        return state;
      },
      onUpdateState: (listener) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      }
    };
  });
  await page.route("**/api/app/info", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          appVersion: "1.0.2",
          schemaVersion: "20260810000300_add_recovery_points",
          schemaChecksum: "safe-checksum",
          platform: "windows",
          buildType: "release",
          buildCommit: "0123456789ab",
          migration: { status: "upgraded", previousAppVersion: "1.0.1", previousSchemaVersion: "old-schema", appliedCount: 1, recoveryCreated: true },
          update: { capability: "desktop", externalUrl: null }
        }
      })
    });
  });

  await page.goto("/settings?section=about");
  await expect(page.getByTestId("about-updates-panel")).toBeVisible();
  await expect(page.getByTestId("upgrade-launch-notice")).toBeVisible();
  await expect(page.getByText("1.0.2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /检查更新|Check for updates/ }).click();
  await expect(page.getByText(/1\.1\.0/)).toBeVisible();
  await expect(page.getByTestId("update-release-notes")).toContainText("Privacy-safe update notes");
  await page.getByRole("button", { name: /下载更新|Download update/ }).click();
  await expect(page.getByTestId("update-download-progress")).toBeVisible();
  await expect(page.getByRole("button", { name: /确认重启并安装|Confirm restart and install/ })).toBeVisible();
  await page.getByRole("button", { name: /确认重启并安装|Confirm restart and install/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /确认重启并安装|Confirm restart and install/ }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __mockInstalled?: boolean }).__mockInstalled)).toBe(true);
});

test("backup import requires preflight review and explicit conflict resolution", async ({ page }) => {
  let importPayload: Record<string, unknown> | null = null;
  const counts = { added: 0, updated: 1, skipped: 0, conflicts: 1, invalid: 0, deleted: 0 };

  await page.route("**/api/backups/recovery-points", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: [] }) });
  });
  await page.route("**/api/backups/preview", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          previewId: "preview-e2e-1234567890",
          schemaVersion: 1,
          mode: "merge",
          sourceExportedAt: "2026-08-10T00:00:00.000Z",
          counts,
          byEntity: {
            settings: { ...counts, updated: 0, conflicts: 0 },
            characters: counts,
            chats: { ...counts, updated: 0, conflicts: 0 },
            messages: { ...counts, updated: 0, conflicts: 0 },
            memories: { ...counts, updated: 0, conflicts: 0 }
          },
          conflicts: [{ key: "characters:e2e-conflict", entity: "characters", id: "e2e-conflict" }],
          issues: [],
          canExecute: true,
          requiresRecoveryPoint: true
        }
      })
    });
  });
  await page.route("**/api/backups/import", async (route) => {
    importPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          mode: "merge",
          characters: 1,
          chats: 0,
          messages: 0,
          memories: 0,
          settingsImported: false,
          added: 0,
          updated: 1,
          skipped: 0,
          conflictsResolved: 1,
          recoveryPointId: "recovery-e2e",
          completedAt: "2026-08-10T00:01:00.000Z"
        }
      })
    });
  });

  await page.goto("/settings?section=backup");
  await page.locator("#backup-import-input").setInputFiles({
    name: "safe-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, characters: [], chats: [], messages: [], memories: [] }))
  });

  await expect(page.getByTestId("backup-impact-preview")).toBeVisible();
  const confirmButton = page.getByTestId("backup-confirm-import");
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel(/冲突处理 1|Conflict resolution 1/).selectOption("use_incoming");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await page.getByRole("dialog").getByRole("button", { name: /确认|Confirm/ }).click();

  await expect.poll(() => importPayload).toEqual(
    expect.objectContaining({
      previewId: "preview-e2e-1234567890",
      conflictResolutions: [{ key: "characters:e2e-conflict", action: "use_incoming" }]
    })
  );
});

test("dialogs trap keyboard focus and restore their trigger", async ({ page }) => {
  await page.goto("/");
  const trigger =
    (page.viewportSize()?.width ?? 1280) < 1024
      ? page.getByTestId("new-chat-trigger-mobile")
      : page.getByTestId("new-chat-trigger-desktop");
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.locator(":focus")).toHaveCount(1);

  // The focus trap must also recover when mounting timing leaves focus on the
  // dialog surface itself instead of one of its controls.
  await dialog.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("chat readiness surfaces missing first-run setup and links to settings", async ({ page }) => {
  const now = new Date().toISOString();
  await page.route("**/api/readiness", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          serverReachable: true,
          appLocked: false,
          hasCharacter: false,
          hasAvailableCharacter: false,
          hasChat: false,
          hasProvider: false,
          hasApiKey: false,
          hasActiveModel: false,
          chatModuleAssigned: false,
          chatModelSupportsText: false,
          visionAvailable: false,
          budgetAllowsChat: true,
          configurationValid: false,
          ready: false,
          overallStatus: "needs_configuration",
          connectionStatus: {
            status: "untested", mode: null, testId: null, providerKind: null,
            providerId: null, modelId: null, checkedAt: null, errorCode: null,
            diagnosticId: null, summary: null, retryable: false,
            suggestedAction: "test_connection", mayIncurCost: false
          },
          nextRecommendedAction: "create_character",
          issues: [
            { code: "provider_missing", severity: "error", field: "provider", action: "configure_provider" },
            { code: "chat_model_missing", severity: "error", field: "modulePreferences", action: "select_chat_model", module: "chat" }
          ],
          characterCount: 0,
          chatCount: 0,
          computedAt: now
        }
      })
    });
  });

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "settings-readiness-e2e",
          activeProvider: "",
          apiBaseUrl: "",
          model: "",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers: [],
          activeProviderId: "",
          activeModelId: "",
          userProfileSummary: "",
          autoSummarizeUser: true,
          showMessageAvatars: true,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: false
        }
      })
    });
  });
  await page.route("**/api/characters/page**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 1,
          totalPages: 1,
          availableTags: []
        }
      })
    });
  });
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: [] })
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await expect(page.getByTestId("onboarding-dialog")).toContainText("Your data stays local by default");
  await page.getByRole("button", { name: "Continue later" }).click();
  await page.goto("/docs");
  const reopenGuide = page.getByTestId("docs-open-onboarding");
  await reopenGuide.click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  await expect(reopenGuide).toBeFocused();
  await page.goto("/");
  await expect(page.getByTestId("chat-new-empty-action")).toContainText("Open Characters");
  const newChatTrigger =
    (page.viewportSize()?.width ?? 1280) < 1024
      ? page.getByTestId("new-chat-trigger-mobile")
      : page.getByTestId("new-chat-trigger-desktop");
  await newChatTrigger.click();
  const newChatDialog = page.getByTestId("new-chat-dialog");
  await expect(newChatDialog).toContainText("There are no characters available for chat yet.");
  await expect(page.getByTestId("new-chat-empty-quick-create")).toBeVisible();
  await expect(page.getByTestId("new-chat-open-characters")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByTestId("chat-readiness-trigger").click();
  await expect(page.getByTestId("chat-readiness-dialog")).toBeVisible();
  await expect(page.locator('[data-readiness-item="provider"]')).toContainText("No usable provider yet");
  await expect(page.locator('[data-readiness-item="character"]')).toContainText("No characters yet");

  await page.locator('[data-readiness-action="provider"]').click();
  await expect(page).toHaveURL(/\/settings\?section=providers&focus=provider$/);
  await expect(page.getByRole("heading", { name: "Model Settings" })).toBeVisible();
  await expect(page.getByTestId("settings-section-providers")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  const setupGuide = page.getByTestId("settings-setup-guide");
  await expect(setupGuide).toHaveAttribute(
    "data-settings-setup-focus",
    "provider"
  );
  await expect(setupGuide).toBeInViewport();
  await expect(page.locator('[data-setup-step="provider"]')).toHaveAttribute(
    "data-setup-focused",
    "true"
  );
});

test("reopened guide derives completed character, model, and connection steps", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("app-language", "en"));
  await page.route("**/api/readiness", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: readinessFixture({
        hasCharacter: true,
        hasAvailableCharacter: true,
        hasProvider: true,
        hasApiKey: true,
        hasActiveModel: true,
        chatModuleAssigned: true,
        chatModelSupportsText: true,
        configurationValid: true,
        ready: true,
        overallStatus: "ready_with_limited_capabilities",
        connectionStatus: {
          status: "succeeded", mode: "metadata", testId: "connection-safe-e2e",
          providerKind: "openai-compatible", providerId: "provider-safe-e2e",
          modelId: "model-safe-e2e", checkedAt: new Date().toISOString(),
          errorCode: null, diagnosticId: "mdl_safe_e2e", summary: "Metadata verified.",
          retryable: false, suggestedAction: "create_chat", mayIncurCost: false
        },
        nextRecommendedAction: "create_chat",
        characterCount: 1
      }) })
    });
  });

  await page.goto("/docs");
  await page.getByTestId("docs-open-onboarding").click();
  const dialog = page.getByTestId("onboarding-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('button[aria-label^="2."]').click();
  await expect(dialog).toContainText(/1 character\(s\) are available|已有 1 个可用角色/);
  await dialog.locator('button[aria-label^="3."]').click();
  await expect(dialog).toContainText(/passed static checks|通过静态检查/);
  await dialog.locator('button[aria-label^="4."]').click();
  await expect(dialog).toContainText(/verified without model inference|未调用模型推理/);
});

test("authentication diagnostics locate saved settings and can be retested safely", async ({ page }) => {
  const now = new Date().toISOString();
  const provider = {
    id: "provider-auth-e2e",
    label: "Auth recovery provider",
    provider: "openai-compatible",
    apiBaseUrl: "https://provider.invalid/v1",
    hasKey: true,
    models: [{
      id: "model-auth-e2e",
      label: "Auth recovery model",
      model: "auth-model",
      capabilities: ["text_generation"],
      pricing: { inputMicrosPerMillion: 1, outputMicrosPerMillion: 1, currency: "USD", updatedAt: now, source: "user" }
    }]
  };
  let connectionSucceeded = false;
  let testPayload: Record<string, unknown> | null = null;
  const connection = () => connectionSucceeded ? {
    status: "succeeded", mode: "metadata", testId: "connection-auth-e2e",
    providerKind: "openai-compatible", providerId: provider.id, modelId: provider.models[0].id,
    checkedAt: now, errorCode: null, diagnosticId: "mdl_auth_fixed_e2e",
    summary: "Metadata verified.", retryable: false, suggestedAction: "create_chat", mayIncurCost: false
  } : {
    status: "failed", mode: "metadata", testId: "connection-auth-e2e",
    providerKind: "openai-compatible", providerId: provider.id, modelId: provider.models[0].id,
    checkedAt: now, errorCode: "authentication", diagnosticId: "mdl_auth_failed_e2e",
    summary: "Authentication failed.", retryable: false, suggestedAction: "add_api_key", mayIncurCost: false
  };

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
      id: "settings-auth-e2e", activeProvider: provider.provider, apiBaseUrl: provider.apiBaseUrl,
      model: provider.models[0].model, temperature: 0.8, maxTokens: 800, topP: 1, language: "en",
      providers: [provider], activeProviderId: provider.id, activeModelId: provider.models[0].id,
      moduleModelPreferences: {}, modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
      usageBudgets: { dailySoftMicros: null, dailyHardMicros: null, monthlySoftMicros: null, monthlyHardMicros: null, allowUnknownPricing: true },
      usageTimezone: "UTC", userPersonaPresets: [], userProfileSummary: "", autoSummarizeUser: false,
      showMessageAvatars: true, showMessageTimestamps: false, appearancePreferences: {},
      ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false, userProfileUpdatedAt: null,
      createdAt: now, updatedAt: now, hasApiKey: true
    } }) });
  });
  await page.route("**/api/readiness", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: readinessFixture({
      hasCharacter: true, hasAvailableCharacter: true, hasProvider: true, hasApiKey: true,
      hasActiveModel: true, chatModuleAssigned: true, chatModelSupportsText: true,
      configurationValid: true, ready: true,
      overallStatus: connectionSucceeded ? "ready_with_limited_capabilities" : "connection_failed",
      connectionStatus: connection(), nextRecommendedAction: connectionSucceeded ? "create_chat" : "retry_connection",
      characterCount: 1
    }) }) });
  });
  await page.route("**/api/readiness/connection-tests", async (route) => {
    testPayload = route.request().postDataJSON() as Record<string, unknown>;
    connectionSucceeded = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: connection() }) });
  });

  await page.goto("/settings");
  await expect(page.getByTestId("connection-diagnostic-result")).toContainText("authentication");
  await page.getByTestId("connection-diagnostic-fix").click();
  await expect(page.getByTestId("settings-section-providers")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Test metadata (normally no inference cost)" }).click();
  await expect(page.getByTestId("connection-diagnostic-result")).toContainText("Connection check passed");
  expect(testPayload).toEqual({ mode: "metadata", confirmCost: false });
  expect(JSON.stringify(testPayload)).not.toContain("key");
  await page.getByRole("button", { name: "Create a chat" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("new chat can quick-create a character and enter the conversation", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Quick Create ${suffix}`;
  const prompt = `A precise night train conductor who speaks calmly. ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    await page.goto("/");
    const trigger =
      (page.viewportSize()?.width ?? 1280) < 1024
        ? page.getByTestId("new-chat-trigger-mobile")
        : page.getByTestId("new-chat-trigger-desktop");
    await trigger.click();

    const dialog = page.getByTestId("new-chat-dialog");
    await page.getByTestId("new-chat-quick-create-tab").click();
    await expect(dialog).toContainText(/填写最少信息创建角色|Create a character with the essentials/);
    await page.getByTestId("new-chat-quick-name").fill(characterName);
    await page.getByTestId("new-chat-quick-prompt").fill(prompt);
    await page.getByTestId("new-chat-quick-submit").click();

    await expect(dialog).toBeHidden();
    await expect(page.locator("#chat-title")).toContainText("New Chat");

    const charactersResponse = await request.get(
      `/api/characters/page?q=${encodeURIComponent(characterName)}&pageSize=10`
    );
    expect(charactersResponse.ok()).toBeTruthy();
    const charactersPayload = (await charactersResponse.json()) as ApiDataResponse<{
      items: E2ECharacter[];
    }>;
    const createdCharacter = charactersPayload.data?.items.find(
      (character) => character.name === characterName
    );
    expect(createdCharacter).toMatchObject({
      name: characterName,
      description: prompt,
      prompt
    });
    characterId = createdCharacter?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatsResponse = await request.get("/api/chats");
    expect(chatsResponse.ok()).toBeTruthy();
    const chats = ((await chatsResponse.json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    const createdChat = chats.find((chat) => chat.characterId === characterId);
    expect(createdChat).toBeTruthy();
    chatId = createdChat?.id ?? null;
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("chat image attachments preview, send, reload, view, and unmount when locked", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Vision Character ${suffix}`;
  const chatTitle = `Vision Chat ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;
  const derivedChatIds: string[] = [];
  const now = new Date().toISOString();
  const visionReply = `Vision reply ${suffix}`;

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
      id: "vision-settings-e2e", activeProvider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", model: "vision-model",
      temperature: 0.8, maxTokens: 800, topP: 1, language: "en",
      providers: [{ id: "vision-provider", label: "Vision provider", provider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", models: [{ id: "vision-model-id", label: "Vision model", model: "vision-model", capabilities: ["text_generation", "vision_input"] }] }],
      activeProviderId: "vision-provider", activeModelId: "vision-model-id", moduleModelPreferences: {}, userPersonaPresets: [], userProfileSummary: "", autoSummarizeUser: false,
      showMessageAvatars: true, showMessageTimestamps: false, ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false,
      userProfileUpdatedAt: null, createdAt: now, updatedAt: now, hasApiKey: true
    } }) });
  });

  try {
    const characterResponse = await request.post("/api/characters", { data: { name: characterName, description: "Vision E2E", prefix: "", prompt: "Describe images.", suffix: "" } });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", { data: { title: chatTitle, characterId } });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    await page.addInitScript(({ selectedChatId, reply }) => {
      window.localStorage.setItem("star-companion:selected-chat", selectedChatId);
      let socket: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
      const emit = (message: Record<string, unknown>) => socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      class MockWebSocket {
        static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
        readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
        readyState = 0; onopen: ((event: Event) => void) | null = null; onclose: ((event: CloseEvent) => void) | null = null; onerror: ((event: Event) => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null;
        constructor() { socket = this; window.setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0); }
        send(data: string) {
          const value = JSON.parse(data) as { type: string; requestId: string; chatId?: string; content?: string; draftId?: string };
          if (value.type !== "generate") return;
          (window as unknown as { __visionRequest: unknown }).__visionRequest = value;
          window.setTimeout(async () => {
            const response = await fetch("http://127.0.0.1:4010/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: value.chatId, role: "user", content: value.content ?? "", draftId: value.draftId }) });
            const payload = await response.json();
            emit({ type: "user_message", requestId: value.requestId, message: payload.data });
            emit({ type: "generation_started", requestId: value.requestId });
            emit({ type: "token", requestId: value.requestId, content: reply.slice(0, 7) });
            emit({ type: "token", requestId: value.requestId, content: reply.slice(7) });
            const assistantResponse = await fetch("http://127.0.0.1:4010/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: value.chatId, role: "assistant", content: reply }) });
            const assistantPayload = await assistantResponse.json();
            emit({ type: "assistant_message", requestId: value.requestId, message: assistantPayload.data });
            emit({ type: "generation_done", requestId: value.requestId });
          }, 0);
        }
        close() { this.readyState = 3; }
      }
      Object.assign(window, { WebSocket: MockWebSocket, __visionRequest: null });
    }, { selectedChatId: chatId, reply: visionReply });

    await page.goto("/");
    const chooser = page.getByLabel(/选择聊天图片|Choose chat images/);
    await chooser.setInputFiles({ name: "vision.png", mimeType: "image/png", buffer: Buffer.from(e2ePngBase64, "base64") });
    const draft = page.getByTestId("chat-image-draft");
    await expect(draft).toBeVisible();
    await expect(draft.getByRole("img")).toHaveCount(1);
    await draft.getByRole("button", { name: /移除图片|Remove image/ }).click();
    await expect(draft.getByRole("img")).toHaveCount(0);

    await page.locator("#chat-message-input").evaluate((element, base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "pasted-vision.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, e2ePngBase64);
    await expect(draft.getByRole("img")).toHaveCount(1);
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();
    await expect(page.locator('[data-chat-message="user"]')).toHaveCount(1);
    await expect(page.getByTestId("chat-message-viewport").getByText(visionReply)).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem("star-companion:onboarding:v1") || "{}"))).toMatchObject({ completed: true });
    const requestPayload = await page.evaluate(() => (window as unknown as { __visionRequest: { content: string; draftId: string } }).__visionRequest);
    expect(requestPayload.content).toBe("");
    expect(requestPayload.draftId).toMatch(/^draft_/);
    await expect(page.getByTestId("message-image-gallery")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("message-image-gallery")).toBeVisible();
    const opener = page.getByTestId("message-image-gallery").getByRole("button");
    await opener.click();
    await expect(page.getByRole("dialog", { name: /图片查看器|Image viewer/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /图片查看器|Image viewer/ })).toHaveCount(0);
    await expect(opener).toBeFocused();

    const sourceResponse = await request.get(`/api/chats/${chatId}`);
    const source = ((await sourceResponse.json()) as ApiDataResponse<{ messages: Array<{ id: string; role: string; attachments: unknown[] }> }>).data;
    const imageMessage = source?.messages.find((message) => message.role === "user");
    expect(imageMessage?.attachments).toHaveLength(1);
    const branchResponse = await request.post(`/api/chats/${chatId}/branches`, { data: { messageId: imageMessage?.id, title: `Vision branch ${suffix}`, kind: "branch" } });
    const branch = ((await branchResponse.json()) as ApiDataResponse<{ id: string; messages: Array<{ attachments: unknown[] }> }>).data;
    expect(branch?.messages[0]?.attachments).toHaveLength(1);
    if (branch?.id) derivedChatIds.push(branch.id);
    const archiveResponse = await request.get(`/api/chats/${chatId}/archive`);
    const archive = ((await archiveResponse.json()) as ApiDataResponse<unknown>).data;
    const importedResponse = await request.post("/api/chats/import-archive", { data: { archive, title: `Vision import ${suffix}` } });
    const imported = ((await importedResponse.json()) as ApiDataResponse<{ id: string; messages: Array<{ attachments: unknown[] }> }>).data;
    expect(imported?.messages.find((message) => message.attachments.length)?.attachments).toHaveLength(1);
    if (imported?.id) derivedChatIds.push(imported.id);

    await page.locator('[data-chat-message="user"] [data-chat-action="edit"]').click();
    const editor = page.getByRole("dialog", { name: /编辑消息|Edit Message/ });
    await expect(editor.getByTestId("edit-message-images").getByRole("img")).toHaveCount(1);
    await editor.getByRole("button", { name: /移除图片|Remove image/ }).click();
    await editor.locator("textarea").fill("Edited without image");
    await editor.getByRole("button", { name: /保存修改|Save Edit/ }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("message-image-gallery")).toHaveCount(0);
    await expect(page.locator('[data-chat-message="user"]')).toContainText("Edited without image");

    await page.evaluate(() => window.dispatchEvent(new Event("star-companion:privacy-locked")));
    await expect(page.getByTestId("privacy-lock-screen")).toBeVisible();
    await expect(page.getByTestId("message-image-gallery")).toHaveCount(0);
  } finally {
    for (const id of derivedChatIds) await permanentlyDeleteChatViaApi(request, id).catch(() => {});
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId).catch(() => {});
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => {});
  }
});

test("chat image controls explain incompatible models without uploading", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  let characterId: string | null = null;
  let chatId: string | null = null;
  const now = new Date().toISOString();
  await page.route("**/api/settings", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
    id: "text-only-settings-e2e", activeProvider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", model: "text-model", temperature: 0.8, maxTokens: 800, topP: 1, language: "en",
    providers: [{ id: "text-provider", label: "Text provider", provider: "openai-compatible", apiBaseUrl: "https://example.invalid/v1", models: [{ id: "text-model-id", label: "Text model", model: "text-model", capabilities: ["text_generation"] }] }],
    activeProviderId: "text-provider", activeModelId: "text-model-id", moduleModelPreferences: {}, userPersonaPresets: [], userProfileSummary: "", autoSummarizeUser: false,
    showMessageAvatars: true, showMessageTimestamps: false, ttsVoice: "alloy", ttsPlaybackRate: 1, ttsAutoPlay: false, userProfileUpdatedAt: null, createdAt: now, updatedAt: now, hasApiKey: true
  } }) }));
  try {
    const characterResponse = await request.post("/api/characters", { data: { name: `Text Only ${suffix}`, description: "", prefix: "", prompt: "Text only.", suffix: "" } });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", { data: { title: `Text Only Chat ${suffix}`, characterId } });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(characterId).toBeTruthy();
    expect(chatId).toBeTruthy();
    await page.addInitScript((selectedChatId) => window.localStorage.setItem("star-companion:selected-chat", selectedChatId), chatId);
    await page.goto("/");
    if (await page.locator('[data-chat-action="attach-image"]').count() === 0) await openChatHistoryAndSelect(page, `Text Only Chat ${suffix}`);
    const attach = page.locator('[data-chat-action="attach-image"]');
    await expect(attach).toHaveAttribute("title", /不支持图片输入|does not support image input/);
    await attach.click();
    const chooser = page.getByLabel(/选择聊天图片|Choose chat images/);
    await chooser.setInputFiles({ name: "blocked.png", mimeType: "image/png", buffer: Buffer.from(e2ePngBase64, "base64") });
    await expect(page.getByRole("alert")).toContainText(/不支持图片输入|does not support image input/);
    await expect(page.getByRole("button", { name: /切换模型|Switch model/ })).toBeVisible();
    await expect(page.getByTestId("chat-image-draft").getByRole("img")).toHaveCount(0);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId).catch(() => {});
    if (characterId) await request.delete(`/api/characters/${characterId}`).catch(() => {});
  }
});

test("new chat starts from the workspace without visiting the character page", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Quick Start Character ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        description: "A character selected directly from the New Chat dialog.",
        prefix: "",
        prompt: "Stay in character.",
        suffix: ""
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    await page.goto("/");
    const trigger =
      (page.viewportSize()?.width ?? 1280) < 1024
        ? page.getByTestId("new-chat-trigger-mobile")
        : page.getByTestId("new-chat-trigger-desktop");
    await trigger.click();

    const dialog = page.getByTestId("new-chat-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("new-chat-search").fill(characterName);
    const characterChoice = dialog.locator(`[data-character-id="${characterId}"]`);
    await expect(characterChoice).toBeVisible();
    await characterChoice.click();

    await expect(dialog).toBeHidden();
    await expect(page.locator("#chat-title")).toContainText("New Chat");
    await expect(page).toHaveURL(/\/$/);

    const chatsResponse = await request.get("/api/chats");
    const chats = ((await chatsResponse.json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    const createdChat = chats.find((chat) => chat.characterId === characterId);
    expect(createdChat).toBeTruthy();
    chatId = createdChat?.id ?? null;
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("recent chats switch directly from the sidebar or mobile drawer", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const targetTitle = `Recent Switch ${suffix}`;
  const preview = `The route is ready for ${suffix}.`;
  let characterId: string | null = null;
  let targetChatId: string | null = null;
  let otherChatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: `Recent Character ${suffix}`,
        description: "Used to verify direct recent-chat navigation.",
        prefix: "",
        prompt: "Keep the route concise.",
        suffix: ""
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const otherResponse = await request.post("/api/chats", {
      data: { title: `Older Switch ${suffix}`, characterId }
    });
    otherChatId = ((await otherResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    const targetResponse = await request.post("/api/chats", {
      data: { title: targetTitle, characterId }
    });
    targetChatId = ((await targetResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(targetChatId).toBeTruthy();

    await request.post("/api/messages", {
      data: { chatId: targetChatId, role: "assistant", characterId, content: preview }
    });

    await page.goto("/");
    const mobile = (page.viewportSize()?.width ?? 1280) < 1024;
    if (mobile) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    const navigation = mobile
      ? page.getByTestId("mobile-nav-content")
      : page.getByTestId("desktop-sidebar");
    const recentRow = navigation.locator(
      `[data-testid="chat-recent-item"][data-chat-id="${targetChatId}"]`
    );
    await expect(recentRow).toBeVisible();
    await expect(recentRow).toContainText(preview);
    await recentRow.click();

    await expect(page.locator("#chat-title")).toContainText(targetTitle);
    if (mobile) {
      await expect(page.getByTestId("mobile-nav-content")).not.toBeInViewport();
    }
  } finally {
    if (targetChatId) await permanentlyDeleteChatViaApi(request, targetChatId);
    if (otherChatId) await permanentlyDeleteChatViaApi(request, otherChatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("empty chats can generate a character opening without sending a user message", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Opening Character ${suffix}`;
  const chatTitle = `Opening Chat ${suffix}`;
  const openingContent = "The lantern flickers as I step into the room.";
  let characterId: string | null = null;
  let chatId: string | null = null;

  await page.route("**/api/chats/*/opening-message", async (route) => {
    const matchedChatId = route.request().url().match(/\/api\/chats\/([^/]+)\/opening-message/)?.[1] ?? "";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: `opening-message-${suffix}`,
          chatId: matchedChatId,
          role: "assistant",
          characterId,
          content: openingContent,
          variants: [openingContent],
          activeVariantIndex: 0,
          tokenUsage: {
            promptTokens: 40,
            completionTokens: 12,
            totalTokens: 52,
            estimated: true
          },
          loreMatches: [],
          memoryMatches: [],
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "Stay atmospheric.",
        prompt: "You are an opening message fixture.",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    expect(characterResponse.ok()).toBeTruthy();
    const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
    characterId = character?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: {
        title: chatTitle,
        characterId,
        memoryTurns: 12,
        autoMemoryEnabled: true,
        backgroundUrl: "",
        userPersona: "",
        userProfileSummary: ""
      }
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
    chatId = chat?.id ?? null;
    expect(chatId).toBeTruthy();

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await expect(page.getByTestId("chat-generate-opening")).toBeVisible();
    await page.getByTestId("chat-generate-opening").click();
    await expect(page.getByText(openingContent)).toBeVisible();
    await expect(page.locator('[data-chat-message="user"]')).toHaveCount(0);
  } finally {
    if (chatId) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    if (characterId) {
      await request.delete(`/api/characters/${characterId}`);
    }
  }
});

test("messages queued during generation can be managed and send after the reply", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Queue Character ${suffix}`;
  const chatTitle = `Queue Chat ${suffix}`;
  const firstMessage = "Check the signal at the old station.";
  const queuedMessage = "Then ask who sent it.";
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "Stay concise.",
        prompt: "Answer in character.",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    await page.addInitScript((selectedChatId) => {
      window.localStorage.setItem("star-companion:selected-chat", selectedChatId);

      type QueueRequest = { type: string; requestId: string; content?: string };
      const requests: QueueRequest[] = [];
      let socket: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
      const emit = (message: Record<string, unknown>) => {
        socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };

      class MockWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSING = 2;
        readonly CLOSED = 3;
        readyState = MockWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        constructor(_url: string | URL) {
          socket = this;
          window.setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          }, 0);
        }

        send(data: string) {
          const request = JSON.parse(data) as QueueRequest;
          if (request.type !== "generate") return;
          requests.push(request);
          emit({ type: "generation_started", requestId: request.requestId });
          if (requests.length > 1) {
            window.setTimeout(
              () => emit({ type: "generation_done", requestId: request.requestId }),
              0
            );
          }
        }

        close() {
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }
      }

      Object.assign(window, {
        WebSocket: MockWebSocket,
        __queueTestRequests: requests,
        __finishQueueTestGeneration: () => {
          const firstRequest = requests[0];
          if (firstRequest) emit({ type: "generation_done", requestId: firstRequest.requestId });
        }
      });
    }, chatId);

    await page.goto("/");
    const composer = page.locator("#chat-message-input");
    await expect(composer).toBeVisible();

    await composer.fill(firstMessage);
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __queueTestRequests: Array<{ content?: string }> })
              .__queueTestRequests.length
        )
      )
      .toBe(1);

    await composer.fill(queuedMessage);
    await page.locator('#chat-primary-action[data-chat-action="queue"]').click();
    const queue = page.getByTestId("chat-message-queue");
    await expect(queue).toContainText(queuedMessage);

    await composer.fill("Discard this queued note.");
    await page.locator('#chat-primary-action[data-chat-action="queue"]').click();
    await queue
      .locator("[data-chat-queue-item]")
      .filter({ hasText: "Discard this queued note." })
      .locator('[data-chat-action="queue-delete"]')
      .click();
    await expect(queue).not.toContainText("Discard this queued note.");

    await queue
      .locator("[data-chat-queue-item]")
      .filter({ hasText: queuedMessage })
      .locator('[data-chat-action="queue-edit"]')
      .click();
    await expect(composer).toHaveValue(queuedMessage);
    await page.locator('#chat-primary-action[data-chat-action="queue"]').click();

    await page.evaluate(() =>
      (
        window as unknown as {
          __finishQueueTestGeneration: () => void;
        }
      ).__finishQueueTestGeneration()
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __queueTestRequests: Array<{ content?: string }> })
              .__queueTestRequests
        )
      )
      .toEqual([
        expect.objectContaining({ content: firstMessage }),
        expect.objectContaining({ content: queuedMessage })
      ]);
    await expect(queue).toBeHidden();
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("message deletion previews its exact timeline impact before changing data", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Delete Safety Character ${suffix}`;
  const chatTitle = `Delete Safety Chat ${suffix}`;
  const firstUser = `The first user turn stays ${suffix}`;
  const firstAssistant = `The first assistant reply stays initially ${suffix}`;
  const secondUser = `Delete from this user turn ${suffix}`;
  const secondAssistant = `This following reply is also removed ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    let secondUserMessageId: string | null = null;
    for (const message of [
      { role: "user", content: firstUser, characterId: null },
      { role: "assistant", content: firstAssistant, characterId },
      { role: "user", content: secondUser, characterId: null },
      { role: "assistant", content: secondAssistant, characterId }
    ]) {
      const response = await request.post("/api/messages", {
        data: { chatId, ...message }
      });
      expect(response.ok()).toBeTruthy();
      if (message.content === secondUser) {
        secondUserMessageId = ((await response.json()) as ApiDataResponse<{ id: string }>).data?.id ?? null;
      }
    }
    expect(secondUserMessageId).toBeTruthy();
    const memoryResponse = await request.post(`/api/chats/${chatId}/memories`, {
      data: {
        title: `Retired path ${suffix}`,
        content: "This memory should be disabled when its source path is deleted.",
        sourceMessageIds: [secondUserMessageId]
      }
    });
    expect(memoryResponse.ok()).toBeTruthy();
    const retiredMemoryId =
      ((await memoryResponse.json()) as ApiDataResponse<{ id: string }>).data?.id ?? null;
    expect(retiredMemoryId).toBeTruthy();

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const secondUserBubble = page
      .locator('[data-chat-message="user"]')
      .filter({ hasText: secondUser });
    await secondUserBubble.locator('[data-chat-action="delete"]').click();

    const deleteDialog = page.getByRole("dialog", {
      name: /删除消息|Delete Message/
    });
    await expect(deleteDialog.getByTestId("delete-message-impact")).toContainText(
      /紧随其后的 1 条消息，共 2 条|next message \(2 total\)/
    );
    await expect(deleteDialog.getByTestId("delete-message-preview")).toContainText(
      secondUser
    );
    await expect(
      deleteDialog.getByRole("button", {
        name: /删除 2 条消息|Delete 2 messages/
      })
    ).toBeVisible();

    await deleteDialog.getByRole("button", { name: /取消|Cancel/ }).click();
    await expect(deleteDialog).toBeHidden();
    const unchangedResponse = await request.get(`/api/chats/${chatId}`);
    const unchanged = (await unchangedResponse.json()) as ApiDataResponse<{
      messages: Array<{ content: string }>;
    }>;
    expect(unchanged.data?.messages.map((message) => message.content)).toEqual([
      firstUser,
      firstAssistant,
      secondUser,
      secondAssistant
    ]);

    let failedDeleteOnce = false;
    await page.route("**/api/messages/*/timeline", async (route) => {
      if (route.request().method() === "DELETE" && !failedDeleteOnce) {
        failedDeleteOnce = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Simulated delete failure" })
        });
        return;
      }
      await route.continue();
    });
    await secondUserBubble.locator('[data-chat-action="delete"]').click();
    await deleteDialog
      .getByRole("button", { name: /删除 2 条消息|Delete 2 messages/ })
      .click();
    await expect(deleteDialog).toBeHidden();
    await expect(page.getByText("Simulated delete failure", { exact: true })).toBeVisible();
    await expect(
      page.getByTestId("chat-message-viewport").getByText(secondAssistant, {
        exact: true
      })
    ).toBeVisible();
    await page.unroute("**/api/messages/*/timeline");

    await secondUserBubble.locator('[data-chat-action="delete"]').click();
    await deleteDialog
      .getByRole("button", { name: /删除 2 条消息|Delete 2 messages/ })
      .click();
    await expect(deleteDialog).toBeHidden();
    const messageViewport = page.getByTestId("chat-message-viewport");
    await expect(messageViewport.getByText(secondUser, { exact: true })).toBeHidden();
    await expect(messageViewport.getByText(secondAssistant, { exact: true })).toBeHidden();
    await expect(messageViewport.getByText(firstUser, { exact: true })).toBeVisible();
    await expect(messageViewport.getByText(firstAssistant, { exact: true })).toBeVisible();
    await expect(page.getByText(/停用 1 条源于已移除剧情的长期记忆|disabled 1 long-term memory item/)).toBeVisible();

    const memoriesResponse = await request.get(`/api/chats/${chatId}/memories`);
    const memories = (await memoriesResponse.json()) as ApiDataResponse<Array<{ id: string; enabled: boolean }>>;
    expect(memories.data?.find((memory) => memory.id === retiredMemoryId)?.enabled).toBe(false);

    const firstAssistantBubble = page
      .locator('[data-chat-message="assistant"]')
      .filter({ hasText: firstAssistant });
    await firstAssistantBubble.locator('[data-chat-action="delete"]').click();
    await expect(deleteDialog.getByTestId("delete-message-impact")).toContainText(
      /只会删除当前这一条消息|Only this message will be removed/
    );
    await expect(deleteDialog.getByTestId("delete-message-preview")).toContainText(
      firstAssistant
    );
    await deleteDialog.getByRole("button", { name: /^删除$|^Delete$/ }).click();
    await expect(deleteDialog).toBeHidden();
    await expect(messageViewport.getByText(firstAssistant, { exact: true })).toBeHidden();
    await expect(messageViewport.getByText(firstUser, { exact: true })).toBeVisible();

    const remainingResponse = await request.get(`/api/chats/${chatId}`);
    const remaining = (await remainingResponse.json()) as ApiDataResponse<{
      messages: Array<{ content: string }>;
    }>;
    expect(remaining.data?.messages.map((message) => message.content)).toEqual([
      firstUser
    ]);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("resending a historical user message confirms its impact and waits for server start", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Resend Safety Character ${suffix}`;
  const chatTitle = `Resend Safety Chat ${suffix}`;
  const firstUser = `The original setup ${suffix}`;
  const firstAssistant = `The original answer ${suffix}`;
  const targetUser = `Resend this direction ${suffix}`;
  const followingAssistant = `Keep this visible until resend starts ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  await page.route("**/api/readiness", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: readinessFixture({
      hasCharacter: true, hasAvailableCharacter: true, hasChat: true,
      hasProvider: true, hasApiKey: true, hasActiveModel: true,
      chatModuleAssigned: true, chatModelSupportsText: true,
      configurationValid: true, ready: true, overallStatus: "ready_with_limited_capabilities",
      connectionStatus: {
        status: "succeeded", mode: "metadata", testId: "connection-resend-e2e",
        providerKind: "openai-compatible", providerId: "provider-resend-e2e",
        modelId: "model-resend-e2e", checkedAt: new Date().toISOString(), errorCode: null,
        diagnosticId: "mdl_resend_e2e", summary: "Metadata verified.", retryable: false,
        suggestedAction: "continue_chat", mayIncurCost: false
      },
      nextRecommendedAction: "continue_chat", characterCount: 1, chatCount: 1
    }) })
  }));

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    for (const message of [
      { role: "user", content: firstUser, characterId: null },
      { role: "assistant", content: firstAssistant, characterId },
      { role: "user", content: targetUser, characterId: null },
      { role: "assistant", content: followingAssistant, characterId }
    ]) {
      const response = await request.post("/api/messages", {
        data: { chatId, ...message }
      });
      expect(response.ok()).toBeTruthy();
    }

    await page.addInitScript(
      ({ selectedChatId, targetContent }) => {
        window.localStorage.setItem("star-companion:selected-chat", selectedChatId);
        let socket: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
        let resendRequest: { requestId: string; messageId: string } | null = null;
        const resendRequests: Array<{ requestId: string; messageId: string }> = [];
        const emit = (message: Record<string, unknown>) => {
          socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
        };

        class MockWebSocket {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSING = 2;
          static readonly CLOSED = 3;
          readonly CONNECTING = 0;
          readonly OPEN = 1;
          readonly CLOSING = 2;
          readonly CLOSED = 3;
          readyState = MockWebSocket.CONNECTING;
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;

          constructor(_url: string | URL) {
            socket = this;
            window.setTimeout(() => {
              this.readyState = MockWebSocket.OPEN;
              this.onopen?.(new Event("open"));
            }, 0);
          }

          send(data: string) {
            const request = JSON.parse(data) as { type: string; requestId: string; messageId: string };
            if (request.type === "resend") {
              resendRequest = request;
              resendRequests.push(request);
            }
          }

          close() {
            this.readyState = MockWebSocket.CLOSED;
            this.onclose?.(new CloseEvent("close"));
          }
        }

        Object.assign(window, {
          WebSocket: MockWebSocket,
          __resendRequestReceived: () => Boolean(resendRequest),
          __resendRequestCount: () => resendRequests.length,
          __resendRequestStarted: () => {
            if (!resendRequest) return false;
            const now = new Date().toISOString();
            emit({ type: "generation_started", requestId: resendRequest.requestId });
            emit({
              type: "user_message",
              requestId: resendRequest.requestId,
              message: {
                id: `replacement-user-${Date.now()}`,
                chatId: selectedChatId,
                role: "user",
                characterId: null,
                content: targetContent,
                contextIncluded: true,
                isBookmarked: false,
                variants: [],
                activeVariantIndex: 0,
                tokenUsage: null,
                loreMatches: [],
                memoryMatches: [],
                attachments: [],
                createdAt: now,
                updatedAt: now
              }
            });
            emit({ type: "generation_done", requestId: resendRequest.requestId });
            return true;
          }
        });
      },
      { selectedChatId: chatId, targetContent: targetUser }
    );

    await page.goto("/");
    const messageViewport = page.getByTestId("chat-message-viewport");
    const targetBubble = page.locator('[data-chat-message="user"]').filter({ hasText: targetUser });
    await targetBubble.locator('[data-chat-action="resend"]').click();
    const resendDialog = page.getByRole("dialog", { name: /从这里重发？|Resend from here\?/ });
    await expect(resendDialog.getByTestId("resend-message-impact")).toContainText(
      /其后的 1 条消息|next message/
    );
    await expect(resendDialog.getByTestId("resend-message-preview")).toContainText(targetUser);
    await resendDialog.getByRole("button", { name: /取消|Cancel/ }).click();
    await expect(messageViewport.getByText(followingAssistant, { exact: true })).toBeVisible();

    await targetBubble.locator('[data-chat-action="resend"]').click();
    await resendDialog.getByRole("button", { name: /重发并替换后续|Resend and replace/ }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __resendRequestReceived: () => boolean }).__resendRequestReceived()
        )
      )
      .toBe(true);
    await expect(messageViewport.getByText(followingAssistant, { exact: true })).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __resendRequestStarted: () => boolean }).__resendRequestStarted()
    );
    await expect(messageViewport.getByText(followingAssistant, { exact: true })).toBeHidden();
    await expect(messageViewport.getByText(targetUser, { exact: true })).toHaveCount(1);

    await page.reload();
    const sourceTargetBubble = page.locator('[data-chat-message="user"]').filter({ hasText: targetUser });
    await sourceTargetBubble.locator('[data-chat-action="resend"]').click();
    await resendDialog.getByRole("button", { name: /创建分支并重发|Create branch and resend/ }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __resendRequestCount: () => number }).__resendRequestCount()
        )
      )
      .toBe(1);

    const originalResponse = await request.get(`/api/chats/${chatId}`);
    const original = (await originalResponse.json()) as ApiDataResponse<{
      messages: Array<{ content: string }>;
    }>;
    expect(original.data?.messages.map((message) => message.content)).toEqual([
      firstUser,
      firstAssistant,
      targetUser,
      followingAssistant
    ]);

    const chatsResponse = await request.get("/api/chats");
    const chats = (await chatsResponse.json()) as ApiDataResponse<E2EChat[]>;
    const branch = chats.data?.find((chat) => chat.parentChatId === chatId);
    expect(branch?.id).toBeTruthy();
    const branchResponse = await request.get(`/api/chats/${branch?.id}`);
    const branchDetails = (await branchResponse.json()) as ApiDataResponse<{
      messages: Array<{ content: string }>;
    }>;
    expect(branchDetails.data?.messages.map((message) => message.content)).toEqual([
      firstUser,
      firstAssistant,
      targetUser,
      followingAssistant
    ]);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("chat agent panel inserts reply drafts and confirms memory candidates before saving", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Agent Character ${suffix}`;
  const chatTitle = `Agent Chat ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  await page.route("**/api/chats/*/agent-draft", async (route) => {
    const body = route.request().postDataJSON() as { mode?: string };
    const memoryCandidate = body.mode === "memory_lore_candidates";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          mode: body.mode ?? "reply_drafts",
          title: memoryCandidate ? "Memory and Lore Candidates" : "Reply Drafts",
          content: memoryCandidate ? "[MEMORY Blue door trust | The user trusts the blue door. | blue door, trust]" : "Agent draft reply for the next turn.",
          createdAt: new Date().toISOString(),
          actions: memoryCandidate
            ? [{ id: "agent-memory-1", kind: "memory_candidate", title: "Blue door trust", content: "The user trusts the blue door.", keywords: ["blue door", "trust"] }]
            : [{ id: "agent-draft-1", kind: "reply_draft", title: "Draft 1", content: "A focused reply draft." }],
          matchedLoreEntries: [],
          matchedMemoryEntries: []
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "Stay in scene.",
        prompt: "You are an agent panel fixture.",
        suffix: "Reply briefly.",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    expect(characterResponse.ok()).toBeTruthy();
    const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
    characterId = character?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: {
        title: chatTitle,
        characterId,
        memoryTurns: 12,
        autoMemoryEnabled: true,
        backgroundUrl: "",
        userPersona: "",
        userProfileSummary: ""
      }
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
    chatId = chat?.id ?? null;
    expect(chatId).toBeTruthy();

    await request.post("/api/messages", {
      data: {
        chatId,
        role: "user",
        content: "Set up an agent panel test message."
      }
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.getByTestId("chat-agent-trigger").click();
    await expect(page.getByTestId("chat-agent-panel")).toBeVisible();
    await page.getByRole("button", { name: /回复草案|Reply Drafts/ }).click();
    await page.getByPlaceholder(/可选：告诉 Agent|Optional: tell the Agent/).fill("next turn");
    await page.getByTestId("chat-agent-run").click();
    await expect(page.getByText("Agent draft reply for the next turn.")).toBeVisible();
    await page.getByRole("button", { name: /插入|Insert/ }).last().click();
    await expect(page.locator("#chat-message-input")).toHaveValue("A focused reply draft.");
    await page.getByRole("button", { name: /插入输入框|Insert into composer/ }).click();
    await expect(page.locator("#chat-message-input")).toHaveValue(
      "Agent draft reply for the next turn."
    );

    await page.getByTestId("agent-mode-memory_lore_candidates").click();
    await page.getByTestId("chat-agent-run").click();
    await expect(page.getByText("The user trusts the blue door.", { exact: true })).toBeVisible();
    await page.getByTestId("agent-action-agent-memory-1").click();
    const confirmationDialog = page.locator("[role=dialog][aria-modal=true]");
    await expect(confirmationDialog).toBeVisible();
    await confirmationDialog.getByRole("button").last().click();
    await expect(page.getByTestId("agent-action-agent-memory-1")).toHaveCount(0);
    const memoriesResponse = await request.get(`/api/chats/${chatId}/memories`);
    const memories = ((await memoriesResponse.json()) as ApiDataResponse<Array<{ title: string; content: string }>>).data;
    expect(memories?.some((memory) => memory.title === "Blue door trust" && memory.content === "The user trusts the blue door.")).toBeTruthy();

    await page.getByRole("button", { name: /关闭 Agent|Close Agent/ }).click();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByTestId("chat-agent-trigger").click();
    await expect(page.getByTestId("chat-agent-panel")).toBeVisible();
    const mobilePanelBox = await page.getByTestId("chat-agent-panel").boundingBox();
    expect(mobilePanelBox?.y ?? 0).toBeGreaterThan(120);
  } finally {
    if (chatId) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    if (characterId) {
      await request.delete(`/api/characters/${characterId}`);
    }
  }
});

test("guided regeneration sends one-time feedback and keeps the previous variant", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const originalReply = `Original cautious reply ${suffix}`;
  const revisedReply = `Revised restrained reply ${suffix}`;
  const guidance = "Keep the established facts, but make the tone more restrained.";
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: `Guided Regeneration ${suffix}`,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "Stay consistent.",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: `Guided Chat ${suffix}`, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();
    await request.post("/api/messages", {
      data: { chatId, role: "user", content: "How does she answer?" }
    });
    const messageResponse = await request.post("/api/messages", {
      data: { chatId, role: "assistant", characterId, content: originalReply }
    });
    const message = ((await messageResponse.json()) as ApiDataResponse<{ id: string; createdAt: string }>).data;
    expect(message?.id).toBeTruthy();

    await page.addInitScript(
      ({ selectedChatId, selectedCharacterId, messageId, original, revised, createdAt }) => {
        window.localStorage.setItem("star-companion:selected-chat", selectedChatId);
        let socket: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
        const emit = (value: Record<string, unknown>) =>
          socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));

        class MockWebSocket {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSING = 2;
          static readonly CLOSED = 3;
          readonly CONNECTING = 0;
          readonly OPEN = 1;
          readonly CLOSING = 2;
          readonly CLOSED = 3;
          readyState = 0;
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;

          constructor() {
            socket = this;
            window.setTimeout(() => {
              this.readyState = MockWebSocket.OPEN;
              (window as unknown as { __guidedSocketReady: boolean }).__guidedSocketReady = true;
              this.onopen?.(new Event("open"));
            }, 0);
          }

          send(data: string) {
            const request = JSON.parse(data) as { type: string; requestId: string; guidance?: string };
            if (request.type !== "regenerate") return;
            (window as unknown as { __guidedRegenerateRequest: unknown }).__guidedRegenerateRequest = request;
            window.setTimeout(() => {
              emit({ type: "generation_started", requestId: request.requestId });
              emit({
                type: "assistant_message",
                requestId: request.requestId,
                message: {
                  id: messageId,
                  chatId: selectedChatId,
                  role: "assistant",
                  characterId: selectedCharacterId,
                  content: revised,
                  contextIncluded: true,
                  isBookmarked: false,
                  variants: [original, revised],
                  activeVariantIndex: 1,
                  tokenUsage: null,
                  loreMatches: [],
                  memoryMatches: [],
                  attachments: [],
                  createdAt,
                  updatedAt: new Date().toISOString()
                }
              });
              emit({ type: "generation_done", requestId: request.requestId });
            }, 0);
          }

          close() {
            this.readyState = 3;
          }
        }

        Object.assign(window, {
          WebSocket: MockWebSocket,
          __guidedRegenerateRequest: null,
          __guidedSocketReady: false
        });
      },
      {
        selectedChatId: chatId!,
        selectedCharacterId: characterId!,
        messageId: message!.id,
        original: originalReply,
        revised: revisedReply,
        createdAt: message!.createdAt
      }
    );

    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __guidedSocketReady: boolean }).__guidedSocketReady))
      .toBe(true);
    const bubble = page.locator("article").filter({ hasText: originalReply }).first();
    await bubble.locator('[data-chat-action="guided-regenerate"]').click();
    await page.getByTestId("guided-regenerate-input").fill(guidance);
    await page.getByTestId("guided-regenerate-run").click();
    await expect(page.getByText(revisedReply)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __guidedRegenerateRequest: { messageId?: string; guidance?: string } }).__guidedRegenerateRequest))
      .toEqual(expect.objectContaining({ messageId: message!.id, guidance }));
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("a dropped generation connection reconnects by request id without resubmitting", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const draft = `Keep this unsent draft ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: `Reconnect Character ${suffix}`,
        prefix: "",
        prompt: "Answer only after the connection is stable.",
        suffix: ""
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: `Reconnect Chat ${suffix}`, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    await page.addInitScript((selectedChatId) => {
      window.localStorage.setItem("star-companion:selected-chat", selectedChatId);

      class MockWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSING = 2;
        readonly CLOSED = 3;
        readyState = MockWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        constructor() {
          const state = window as unknown as {
            __reconnectSocketCount: number;
            __reconnectSocketReady: boolean;
            __generationSubmitCount: number;
            __generationStatusCount: number;
          };
          state.__reconnectSocketCount += 1;
          window.setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            state.__reconnectSocketReady = true;
            this.onopen?.(new Event("open"));
          }, 0);
        }

        send(data: string) {
          const request = JSON.parse(data) as { type: string; requestId: string };
          const state = window as unknown as {
            __generationSubmitCount: number;
            __generationStatusCount: number;
          };
          if (request.type === "status") {
            state.__generationStatusCount += 1;
            window.setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
              type: "generation_status",
              request: {
                requestId: request.requestId,
                module: "chat",
                operation: "generate",
                chatId: selectedChatId,
                messageId: null,
                status: "running",
                activeAttemptId: "attempt-reconnect-e2e",
                outputStarted: false,
                error: null,
                createdAt: new Date().toISOString(),
                startedAt: new Date().toISOString(),
                completedAt: null,
                updatedAt: new Date().toISOString()
              }
            }) })), 0);
            return;
          }
          if (request.type !== "generate") return;
          state.__generationSubmitCount += 1;
          (window as unknown as { __droppedGenerationRequest: unknown }).__droppedGenerationRequest =
            request;
          window.setTimeout(() => {
            this.readyState = MockWebSocket.CLOSED;
            this.onclose?.(new Event("close"));
          }, 20);
        }

        close() {
          this.readyState = MockWebSocket.CLOSED;
        }
      }

      Object.assign(window, {
        WebSocket: MockWebSocket,
        __reconnectSocketCount: 0,
        __reconnectSocketReady: false,
        __generationSubmitCount: 0,
        __generationStatusCount: 0,
        __droppedGenerationRequest: null
      });
    }, chatId!);

    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __reconnectSocketReady: boolean }).__reconnectSocketReady
        )
      )
      .toBe(true);

    const composer = page.locator("#chat-message-input");
    await composer.fill(draft);
    await page.locator('[data-chat-action="send"]').click();

    await expect(page.getByTestId("chat-connection-status")).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator('[data-chat-action="stop"]')).toBeVisible();

    await page.locator('[data-chat-action="reconnect"]').click();
    await expect(page.getByTestId("chat-connection-status")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __reconnectSocketCount: number }).__reconnectSocketCount
        )
      )
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __generationStatusCount: number }).__generationStatusCount))
      .toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => (window as unknown as { __generationSubmitCount: number }).__generationSubmitCount)).toBe(1);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("AI title suggestion stays editable until the user confirms it", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Title Character ${suffix}`;
  const chatTitle = `Original Title ${suffix}`;
  const suggestedTitle = "Blue Door Investigation";
  let characterId: string | null = null;
  let chatId: string | null = null;

  await page.route("**/api/chats/*/title-suggestion", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { title: suggestedTitle, createdAt: new Date().toISOString() }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();
    await request.post("/api/messages", {
      data: { chatId, role: "user", content: "The blue door is locked." }
    });

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.getByTestId("chat-title-suggestion-trigger").click();
    await expect(page.locator("#chat-title input")).toHaveValue(suggestedTitle);

    const persistedChat = await request.get(`/api/chats/${chatId}`);
    const persisted = (await persistedChat.json()) as ApiDataResponse<E2EChat>;
    expect(persisted.data?.title).toBe(chatTitle);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("a default chat requests and applies one AI title after its first exchange", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Auto Title Character ${suffix}`;
  const generatedTitle = "Blue Door Arrival";
  let characterId: string | null = null;
  let chatId: string | null = null;
  let titleRequests = 0;

  await page.route("**/api/chats/*/auto-title", async (route) => {
    titleRequests += 1;
    const persistedResponse = await request.put(`/api/chats/${chatId}`, {
      data: { title: generatedTitle }
    });
    await route.fulfill({
      status: persistedResponse.status(),
      contentType: "application/json",
      body: await persistedResponse.text()
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", { data: { title: "New Chat", characterId } });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    await request.post("/api/messages", { data: { chatId, role: "user", content: "The blue door opened." } });
    await request.post("/api/messages", { data: { chatId, role: "assistant", characterId, content: "I waited behind it." } });

    await page.addInitScript((selectedId) => {
      window.localStorage.setItem("star-companion:selected-chat", selectedId);
    }, chatId);
    await page.goto("/");
    await expect(page.locator("#chat-title")).toContainText(generatedTitle);
    await expect.poll(() => titleRequests).toBe(1);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("active chats export readable Markdown and plain-text transcripts", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Transcript Character ${suffix}`;
  const chatTitle = `Transcript Chat ${suffix}`;
  const userMessage = "Follow the **silver trail**.";
  const assistantMessage = "I marked the route in `chalk`.";
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    await request.post("/api/messages", {
      data: { chatId, role: "user", content: userMessage }
    });
    await request.post("/api/messages", {
      data: { chatId, role: "assistant", characterId, content: assistantMessage }
    });

    await page.addInitScript((selectedId) => {
      window.localStorage.setItem("star-companion:selected-chat", selectedId);
    }, chatId);
    await page.goto("/");
    await expect(page.locator("#chat-title")).toContainText(chatTitle);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /导出聊天|Export Chat/ }).click();

    const dialog = page.getByTestId("chat-export-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/聊天记录预览|Transcript preview/)).toContainText(chatTitle);
    await dialog.getByRole("checkbox").uncheck();

    const markdownDownloadPromise = page.waitForEvent("download");
    await dialog.locator('[data-chat-action="export-download"]').click();
    const markdownDownload = await markdownDownloadPromise;
    expect(markdownDownload.suggestedFilename()).toMatch(/\.md$/);
    const markdownPath = await markdownDownload.path();
    expect(markdownPath).toBeTruthy();
    const markdown = await readFile(markdownPath!, "utf8");
    expect(markdown).toContain(`# ${chatTitle}`);
    expect(markdown).toContain(characterName);
    expect(markdown).toContain(userMessage);
    expect(markdown).toContain(assistantMessage);
    expect(markdown).not.toMatch(/^## .+ · /m);

    await dialog.locator('[data-chat-export-format="text"]').click();
    const textDownloadPromise = page.waitForEvent("download");
    await dialog.locator('[data-chat-action="export-download"]').click();
    const textDownload = await textDownloadPromise;
    expect(textDownload.suggestedFilename()).toMatch(/\.txt$/);
    const textPath = await textDownload.path();
    expect(textPath).toBeTruthy();
    const plainText = await readFile(textPath!, "utf8");
    expect(plainText).toContain(chatTitle);
    expect(plainText).toContain(characterName);
    expect(plainText).toContain(userMessage);
    expect(plainText).not.toContain(`# ${chatTitle}`);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("chat history imports a structured chat archive without replacing its source", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Archive Character ${suffix}`;
  const sourceTitle = `Archive Source ${suffix}`;
  const importedTitle = `Archive Imported ${suffix}`;
  let characterId: string | null = null;
  let sourceChatId: string | null = null;
  let importedChatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const sourceResponse = await request.post("/api/chats", { data: { title: sourceTitle, characterId } });
    sourceChatId = ((await sourceResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    await request.post("/api/messages", {
      data: { chatId: sourceChatId, role: "user", content: "Preserve this archive source." }
    });
    const archiveResponse = await request.get(`/api/chats/${sourceChatId}/archive`);
    const archive = ((await archiveResponse.json()) as ApiDataResponse<Record<string, unknown>>).data;
    (archive?.chat as { title?: string }).title = importedTitle;

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 1024) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.getByRole("button", { name: /历史|History/ }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "chat-archive.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(archive))
    });
    await expect(page.locator("#chat-title")).toContainText(importedTitle);

    const chats = ((await (await request.get("/api/chats")).json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    importedChatId = chats.find((chat) => chat.title === importedTitle)?.id ?? null;
    expect(importedChatId).toBeTruthy();
    const source = (await (await request.get(`/api/chats/${sourceChatId}`)).json()) as ApiDataResponse<E2EChatDetails>;
    expect(source.data?.title).toBe(sourceTitle);
  } finally {
    if (importedChatId) await permanentlyDeleteChatViaApi(request, importedChatId);
    if (sourceChatId) await permanentlyDeleteChatViaApi(request, sourceChatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("history searches message content across chats and jumps to the matching turn", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Global Search Character ${suffix}`;
  const firstTitle = `Global Search First ${suffix}`;
  const targetTitle = `Global Search Target ${suffix}`;
  const targetText = `The observatory key is hidden under the blue lantern ${suffix}`;

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary search character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const firstChatResponse = await request.post("/api/chats", {
    data: { title: firstTitle, characterId: character.id }
  });
  const targetChatResponse = await request.post("/api/chats", {
    data: { title: targetTitle, characterId: character.id }
  });
  expect(firstChatResponse.ok()).toBeTruthy();
  expect(targetChatResponse.ok()).toBeTruthy();
  const firstChat = (await firstChatResponse.json()).data;
  const targetChat = (await targetChatResponse.json()).data;
  const messageResponse = await request.post("/api/messages", {
    data: { chatId: targetChat.id, role: "user", content: targetText }
  });
  expect(messageResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    const viewport = page.viewportSize();
    if (viewport && viewport.width < 1024) {
      await page.getByTestId("global-search-trigger-mobile").click();
    } else {
      await page.keyboard.press("Control+K");
    }
    const globalSearchInput = page.getByTestId("chat-history-search");
    await expect(globalSearchInput).toBeFocused();
    await expect(
      page
        .getByRole("group", { name: /历史搜索模式|History search mode/ })
        .getByRole("button", { name: /^(消息|Messages)$/ })
    ).toHaveAttribute("aria-pressed", "true");
    await globalSearchInput.fill("observatory key");
    await globalSearchInput.press("Enter");
    await page
      .getByTestId("history-message-search-result")
      .filter({ hasText: targetText })
      .click();
    await expect(page.locator("#chat-title")).toContainText(targetTitle);
    await expect(page.locator("article").filter({ hasText: targetText }).first()).toBeVisible();
  } finally {
    await permanentlyDeleteChatViaApi(request, firstChat.id);
    await permanentlyDeleteChatViaApi(request, targetChat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat history shows a bounded last-message preview and activity metadata", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const chatTitle = `Preview Chat ${suffix}`;
  const assistantPrefix = `The observatory doors closed behind us ${suffix}.`;
  const assistantContent = `${assistantPrefix}\n${"The signal remains visible. ".repeat(12)}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: `Preview Character ${suffix}`,
        prefix: "",
        prompt: "Keep the scene moving.",
        suffix: ""
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();

    await request.post("/api/messages", {
      data: { chatId, role: "user", content: "Did anyone follow us?" }
    });
    await request.post("/api/messages", {
      data: { chatId, role: "assistant", characterId, content: assistantContent }
    });

    const listResponse = await request.get("/api/chats");
    const listedChats = ((await listResponse.json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    const listedChat = listedChats.find((chat) => chat.id === chatId);
    expect(listedChat?.messageCount).toBe(2);
    expect(listedChat?.lastMessagePreview?.role).toBe("assistant");
    expect(listedChat?.lastMessagePreview?.content).toContain(assistantPrefix);
    expect(listedChat?.lastMessagePreview?.content).not.toContain("\n");
    expect(listedChat?.lastMessagePreview?.content.length).toBeLessThanOrEqual(180);

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 1280) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.getByRole("button", { name: /历史|History/ }).click();

    const row = page.locator(
      `[data-chat-history-row][data-chat-id="${chatId}"]`
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId("chat-history-preview")).toContainText(assistantPrefix);
    await expect(row.getByText(/2 (msg|条)/)).toBeVisible();
    await expect(row.getByTestId("chat-history-activity")).not.toBeEmpty();
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("pinned chats move to the top of history and persist", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Pin Character ${suffix}`;
  const searchPrefix = `Pin ${suffix}`;
  let characterId: string | null = null;
  let targetChatId: string | null = null;
  let recentChatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    const targetResponse = await request.post("/api/chats", {
      data: { title: `${searchPrefix} Target`, characterId }
    });
    targetChatId = ((await targetResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    const recentResponse = await request.post("/api/chats", {
      data: { title: `${searchPrefix} Recent`, characterId }
    });
    recentChatId = ((await recentResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(targetChatId).toBeTruthy();
    expect(recentChatId).toBeTruthy();

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.locator('[data-testid="chat-history-trigger"]:visible').click();
    await page.getByTestId("chat-history-search").fill(searchPrefix);

    const rows = page.locator("[data-chat-history-row]");
    await expect(rows).toHaveCount(2);
    const targetRow = page.locator(`[data-chat-history-row][data-chat-id="${targetChatId}"]`);
    await clickHistoryRowAction(targetRow, "pin");

    await targetRow.getByTestId("chat-history-row-actions").click();
    await expect(targetRow.locator('[data-chat-action="pin"]')).toHaveAttribute("aria-pressed", "true");
    await expect(rows.first()).toHaveAttribute("data-chat-id", targetChatId!);

    const listResponse = await request.get("/api/chats");
    const persisted = (await listResponse.json()) as ApiDataResponse<Array<E2EChat & { isPinned: boolean }>>;
    expect(persisted.data?.[0]?.id).toBe(targetChatId);
    expect(persisted.data?.[0]?.isPinned).toBe(true);
  } finally {
    if (targetChatId) await permanentlyDeleteChatViaApi(request, targetChatId);
    if (recentChatId) await permanentlyDeleteChatViaApi(request, recentChatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("archived chats leave active history and can be restored without data loss", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const chatTitle = `Archive Restore ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: { name: `Archive Character ${suffix}`, prefix: "", prompt: "", suffix: "" }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(characterId).toBeTruthy();
    expect(chatId).toBeTruthy();

    await request.post("/api/messages", {
      data: { chatId, role: "user", content: `Archived scene ${suffix}` }
    });
    await request.post(`/api/chats/${chatId}/memories`, {
      data: {
        title: "Archive memory",
        content: "This memory must survive chat archiving.",
        keywords: ["archive"],
        importance: 3,
        enabled: true,
        sourceMessageIds: []
      }
    });

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.locator('[data-testid="chat-history-trigger"]:visible').click();
    await page.getByTestId("chat-history-search").fill(chatTitle);

    const row = page.locator(`[data-chat-history-row][data-chat-id="${chatId}"]`);
    await expect(row).toBeVisible();
    await clickHistoryRowAction(row, "archive");
    await expect(row).toHaveCount(0);

    await page.getByTestId("chat-history-scope-archived").click();
    await expect(row).toBeVisible();
    const archived = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<{
      isArchived: boolean;
      messages: unknown[];
      memories: unknown[];
    }>;
    expect(archived.data?.isArchived).toBe(true);
    expect(archived.data?.messages).toHaveLength(1);
    expect(archived.data?.memories).toHaveLength(1);

    await clickHistoryRowAction(row, "archive");
    await expect(row).toHaveCount(0);
    await page.getByTestId("chat-history-scope-active").click();
    await expect(row).toBeVisible();

    const restored = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<{
      isArchived: boolean;
    }>;
    expect(restored.data?.isArchived).toBe(false);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("trashed chats can be restored before a separately confirmed permanent deletion", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const chatTitle = `Trash Restore ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: { name: `Trash Character ${suffix}`, prefix: "", prompt: "", suffix: "" }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(characterId).toBeTruthy();
    expect(chatId).toBeTruthy();

    await request.post("/api/messages", {
      data: { chatId, role: "user", content: `Recoverable trash message ${suffix}` }
    });
    await request.post(`/api/chats/${chatId}/memories`, {
      data: {
        title: "Recoverable memory",
        content: "This memory must survive a trip through Trash.",
        keywords: ["recoverable"],
        importance: 3,
        enabled: true,
        sourceMessageIds: []
      }
    });

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.locator('[data-testid="chat-history-trigger"]:visible').click();
    await page.getByTestId("chat-history-search").fill(chatTitle);
    const row = page.locator(`[data-chat-history-row][data-chat-id="${chatId}"]`);
    await expect(row).toBeVisible();

    await clickHistoryRowAction(row, "trash");
    const trashConfirm = page.getByRole("dialog").last();
    await expect(trashConfirm).toContainText(/消息和长期记忆会保留|messages and long-term memories will be kept/i);
    await trashConfirm.getByRole("button", { name: /移入回收站|Move to Trash/i }).click();
    await expect(row).toHaveCount(0);

    const trashedList = (await (await request.get("/api/chats")).json()) as ApiDataResponse<
      Array<E2EChat & { deletedAt: string | null }>
    >;
    expect(trashedList.data?.find((chat) => chat.id === chatId)?.deletedAt).toBeTruthy();
    expect((await request.get(`/api/chats/${chatId}`)).status()).toBe(404);

    await page.getByTestId("chat-history-scope-trash").click();
    await page.getByTestId("chat-history-search").fill(chatTitle);
    await expect(row).toBeVisible();
    await clickHistoryRowAction(row, "restore");
    await expect(row).toHaveCount(0);

    await page.getByTestId("chat-history-scope-active").click();
    await page.getByTestId("chat-history-search").fill(chatTitle);
    await expect(row).toBeVisible();
    const restored = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<{
      deletedAt: string | null;
      messages: unknown[];
      memories: unknown[];
    }>;
    expect(restored.data?.deletedAt).toBeNull();
    expect(restored.data?.messages).toHaveLength(1);
    expect(restored.data?.memories).toHaveLength(1);

    await clickHistoryRowAction(row, "trash");
    await page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: /移入回收站|Move to Trash/i })
      .click();
    await page.getByTestId("chat-history-scope-trash").click();
    await page.getByTestId("chat-history-search").fill(chatTitle);
    await expect(row).toBeVisible();
    await clickHistoryRowAction(row, "permanent-delete");
    const permanentConfirm = page.getByRole("dialog").last();
    await expect(permanentConfirm).toContainText(/不可撤销|cannot be undone/i);
    await permanentConfirm.getByRole("button", { name: /永久删除|Delete Permanently/i }).click();
    await expect(row).toHaveCount(0);
    expect((await request.get(`/api/chats/${chatId}`)).status()).toBe(404);
    expect(
      ((await (await request.get("/api/chats")).json()) as ApiDataResponse<E2EChat[]>).data?.some(
        (chat) => chat.id === chatId
      )
    ).toBe(false);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("history manage mode archives and restores multiple chats together", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const searchPrefix = `Batch Archive ${suffix}`;
  let characterId: string | null = null;
  const chatIds: string[] = [];

  try {
    const characterResponse = await request.post("/api/characters", {
      data: { name: `Batch Archive Character ${suffix}`, prefix: "", prompt: "", suffix: "" }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    for (const title of [`${searchPrefix} One`, `${searchPrefix} Two`]) {
      const chatResponse = await request.post("/api/chats", {
        data: { title, characterId }
      });
      const chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id;
      expect(chatId).toBeTruthy();
      chatIds.push(chatId!);
    }

    await page.goto("/");
    await page.evaluate((chatId) => {
      window.localStorage.setItem("star-companion:selected-chat", chatId);
    }, chatIds[0]);
    await page.reload();
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.locator('[data-testid="chat-history-trigger"]:visible').click();
    await page.getByTestId("chat-history-search").fill(searchPrefix);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);

    await page.getByTestId("chat-history-manage").click();
    await page.getByTestId("chat-history-select-all").click();
    await page.getByTestId("chat-history-batch-archive").click();
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("star-companion:selected-chat")))
      .toBeNull();

    for (const chatId of chatIds) {
      const archived = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<{
        isArchived: boolean;
      }>;
      expect(archived.data?.isArchived).toBe(true);
    }

    await page.getByTestId("chat-history-scope-archived").click();
    await page.getByTestId("chat-history-search").fill(searchPrefix);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);
    await page.getByTestId("chat-history-manage").click();
    await page.getByTestId("chat-history-select-all").click();
    await page.getByTestId("chat-history-batch-archive").click();
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(0);

    await page.getByTestId("chat-history-scope-active").click();
    await page.getByTestId("chat-history-search").fill(searchPrefix);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);
    for (const chatId of chatIds) {
      const restored = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<{
        isArchived: boolean;
      }>;
      expect(restored.data?.isArchived).toBe(false);
    }
  } finally {
    for (const chatId of chatIds) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("chat history filters and reorganizes chats by folder", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Folder Character ${suffix}`;
  const firstTitle = `Folder Chat One ${suffix}`;
  const secondTitle = `Folder Chat Two ${suffix}`;
  const mainFolder = `Main story ${suffix}`;
  const sideFolder = `Side story ${suffix}`;
  const archiveFolder = `Archive folder ${suffix}`;
  const renamedFolder = `Renamed folder ${suffix}`;
  let characterId: string | null = null;
  const chatIds: string[] = [];

  try {
    const characterResponse = await request.post("/api/characters", {
      data: { name: characterName, prefix: "", prompt: "", suffix: "" }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    expect(characterId).toBeTruthy();

    for (const [title, folder] of [
      [firstTitle, mainFolder],
      [secondTitle, sideFolder]
    ]) {
      const chatResponse = await request.post("/api/chats", {
        data: { title, characterId, folder }
      });
      const chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id;
      expect(chatId).toBeTruthy();
      chatIds.push(chatId!);
    }

    await page.goto("/");
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.locator('[data-testid="chat-history-trigger"]:visible').click();

    const folderFilter = page.getByTestId("chat-history-folder-filter");
    await folderFilter.selectOption(mainFolder);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(1);
    await expect(page.locator("[data-chat-history-row]")).toContainText(firstTitle);

    const firstRow = page.locator("[data-chat-history-row]").filter({ hasText: firstTitle });
    await clickHistoryRowAction(firstRow, "folder");
    const folderDialog = page.getByRole("dialog", { name: /整理聊天文件夹|Organize Chat Folder/ });
    await folderDialog.getByRole("textbox").fill(sideFolder);
    await folderDialog.getByRole("button", { name: /保存|Save/ }).click();
    await expect(folderDialog).toBeHidden();

    await folderFilter.selectOption(sideFolder);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);
    await expect(
      page.locator("[data-chat-history-row]").filter({ hasText: firstTitle })
    ).toHaveCount(1);
    await expect(
      page.locator("[data-chat-history-row]").filter({ hasText: secondTitle })
    ).toHaveCount(1);

    await page.getByTestId("chat-history-manage").click();
    await page.getByTestId("chat-history-select-all").click();
    await page.getByTestId("chat-history-batch-folder").click();
    const batchFolderDialog = page.getByRole("dialog", {
      name: /批量整理聊天文件夹|Organize Selected Chats/
    });
    await batchFolderDialog.getByRole("textbox").fill(archiveFolder);
    await batchFolderDialog.getByRole("button", { name: /保存|Save/ }).click();
    await expect(batchFolderDialog).toBeHidden();
    await folderFilter.selectOption(archiveFolder);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);

    await page.getByTestId("chat-history-rename-folder").click();
    const renameFolderDialog = page.getByRole("dialog", {
      name: /重命名聊天文件夹|Rename Chat Folder/
    });
    await renameFolderDialog.getByRole("textbox").fill(renamedFolder);
    await renameFolderDialog.getByRole("button", { name: /保存|Save/ }).click();
    await expect(renameFolderDialog).toBeHidden();
    await expect(page.getByTestId("chat-history-folder-filter")).toHaveValue(renamedFolder);
    await expect(page.locator("[data-chat-history-row]")).toHaveCount(2);

    const updated = (await (await request.get(`/api/chats/${chatIds[0]}`)).json()) as ApiDataResponse<{
      folder: string;
    }>;
    expect(updated.data?.folder).toBe(renamedFolder);
  } finally {
    for (const chatId of chatIds) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("unconfigured media tools open the matching module model setting", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Media Setup Character ${suffix}`;
  const chatTitle = `Media Setup Chat ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;
  const now = new Date().toISOString();

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "media-setup-settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://example.invalid/v1",
          model: "chat-model",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers: [
            {
              id: "media-setup-provider",
              label: "Chat provider",
              provider: "openai-compatible",
              apiBaseUrl: "https://example.invalid/v1",
              models: [
                {
                  id: "chat-model",
                  label: "Chat model",
                  model: "chat-model",
                  capabilities: ["text_generation"]
                }
              ]
            }
          ],
          activeProviderId: "media-setup-provider",
          activeModelId: "chat-model",
          moduleModelPreferences: {},
          userProfileSummary: "",
          autoSummarizeUser: true,
          showMessageAvatars: true,
          showMessageTimestamps: false,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: true
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const recordButton = page.locator('[data-chat-action="voice-record"]');
    const speechButton = page.locator('[data-chat-action="voice-speak"]');
    const imageButton = page.locator('[data-chat-action="image-generate"]');
    await expect(recordButton).toBeEnabled();
    await expect(recordButton).toHaveAttribute(
      "aria-label",
      "Configure voice transcription model"
    );
    await expect(speechButton).toBeEnabled();
    await expect(speechButton).toHaveAttribute(
      "aria-label",
      "Configure text-to-speech model"
    );
    await expect(imageButton).toBeEnabled();
    await expect(imageButton).toHaveAttribute(
      "aria-label",
      "Configure image generation model"
    );

    await imageButton.click();
    await expect(page).toHaveURL(
      /\/settings\?section=providers&focus=module-image_generation$/
    );
    await expect(page.getByTestId("settings-section-providers")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const focusedRow = page.locator('[data-module-model="image_generation"]');
    await expect(focusedRow).toHaveAttribute("data-module-model-focused", "true");
    await expect(focusedRow).toBeInViewport();
    await expect(focusedRow.locator("select")).toBeFocused();
    await expect(focusedRow).toContainText(
      "Choose a compatible model for this feature"
    );
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("image generation previews a result before inserting it into the composer", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Image Character ${suffix}`;
  const chatTitle = `Image Chat ${suffix}`;
  const imagePrompt = "A blue door under moonlight";
  let characterId: string | null = null;
  let chatId: string | null = null;
  const now = new Date().toISOString();

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "image-settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://example.invalid/v1",
          model: "gpt-4o-mini",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers: [
            {
              id: "image-provider",
              label: "Image provider",
              provider: "openai-compatible",
              apiBaseUrl: "https://example.invalid/v1",
              models: [
                {
                  id: "image-model",
                  label: "Image model",
                  model: "gpt-image-1",
                  capabilities: ["image_generation"]
                }
              ]
            }
          ],
          activeProviderId: "",
          activeModelId: "",
          moduleModelPreferences: {
            image_generation: { providerId: "image-provider", modelId: "image-model" }
          },
          userProfileSummary: "",
          autoSummarizeUser: true,
          showMessageAvatars: true,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: true
        }
      })
    });
  });
  await page.route("**/api/media/images/generations", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          images: [{ b64Json: Buffer.from("image-preview").toString("base64"), mimeType: "image/png" }],
          model: "gpt-image-1",
          createdAt: now
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", { data: { title: chatTitle, characterId } });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator('[data-chat-action="image-generate"]').click();
    await expect(page.getByTestId("chat-image-dialog")).toBeVisible();
    await page.getByPlaceholder("Enter an image prompt").fill(imagePrompt);
    await page.getByTestId("chat-image-generate").click();
    await expect(page.getByTestId("chat-image-preview")).toHaveAttribute("alt", imagePrompt);
    await page.getByTestId("chat-image-insert").click();
    await expect(page.locator("#chat-message-input")).toHaveValue(new RegExp(`!\\[${imagePrompt}\\]\\(data:image/png;base64,`));
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("new assistant replies use the configured voice playback preferences", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Voice Character ${suffix}`;
  const chatTitle = `Voice Chat ${suffix}`;
  const historicalContent = "The older beacon reply is still available.";
  const assistantContent = "The signal is clear. I can hear you.";
  let characterId: string | null = null;
  let chatId: string | null = null;
  const speechRequests: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "voice-settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://example.invalid/v1",
          model: "chat-model",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers: [
            {
              id: "voice-provider",
              label: "Voice provider",
              provider: "openai-compatible",
              apiBaseUrl: "https://example.invalid/v1",
              models: [
                {
                  id: "chat-model",
                  label: "Chat model",
                  model: "chat-model",
                  capabilities: ["text_generation"]
                },
                {
                  id: "speech-model",
                  label: "Speech model",
                  model: "tts-1",
                  capabilities: ["text_to_speech"]
                }
              ]
            }
          ],
          activeProviderId: "voice-provider",
          activeModelId: "chat-model",
          moduleModelPreferences: {
            voice_speech: { providerId: "voice-provider", modelId: "speech-model" }
          },
          userPersonaPresets: [],
          userProfileSummary: "",
          autoSummarizeUser: false,
          showMessageAvatars: true,
          showMessageTimestamps: false,
          ttsVoice: "nova",
          ttsPlaybackRate: 1.5,
          ttsAutoPlay: true,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: true
        }
      })
    });
  });
  await page.route("**/api/media/voice/speech", async (route) => {
    speechRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          audioBase64: Buffer.from("voice-e2e").toString("base64"),
          mimeType: "audio/mpeg",
          model: "tts-1",
          createdAt: now
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "Answer briefly.",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId }
    });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;
    expect(chatId).toBeTruthy();
    const historicalMessageResponse = await request.post("/api/messages", {
      data: {
        chatId,
        role: "assistant",
        characterId,
        content: historicalContent
      }
    });
    expect(historicalMessageResponse.ok()).toBeTruthy();

    await page.addInitScript(
      ({ selectedChatId, selectedCharacterId, reply }) => {
        window.localStorage.setItem("star-companion:selected-chat", selectedChatId);
        let socket: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
        const emit = (message: Record<string, unknown>) => {
          socket?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
        };

        class MockAudio {
          currentTime = 0;
          playbackRate = 1;
          onended: (() => void) | null = null;
          onerror: (() => void) | null = null;

          constructor(_source: string) {
            (window as unknown as { __voiceAudio: MockAudio }).__voiceAudio = this;
          }

          play() {
            (window as unknown as { __voicePlayCount: number }).__voicePlayCount += 1;
            return Promise.resolve();
          }

          pause() {
            (window as unknown as { __voicePauseCount: number }).__voicePauseCount += 1;
          }
        }

        class MockWebSocket {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSING = 2;
          static readonly CLOSED = 3;
          readonly CONNECTING = 0;
          readonly OPEN = 1;
          readonly CLOSING = 2;
          readonly CLOSED = 3;
          readyState = MockWebSocket.CONNECTING;
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;

          constructor(_url: string | URL) {
            socket = this;
            window.setTimeout(() => {
              this.readyState = MockWebSocket.OPEN;
              this.onopen?.(new Event("open"));
            }, 0);
          }

          send(data: string) {
            const request = JSON.parse(data) as { type: string; requestId: string };
            if (request.type !== "generate") return;
            window.setTimeout(() => {
              emit({ type: "generation_started", requestId: request.requestId });
              emit({
                type: "assistant_message",
                requestId: request.requestId,
                message: {
                  id: `voice-message-${Date.now()}`,
                  chatId: selectedChatId,
                  role: "assistant",
                  characterId: selectedCharacterId,
                  content: reply,
                  contextIncluded: true,
                  isBookmarked: false,
                  variants: [reply],
                  activeVariantIndex: 0,
                  tokenUsage: null,
                  loreMatches: [],
                  memoryMatches: [],
                  attachments: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                }
              });
              emit({ type: "generation_done", requestId: request.requestId });
            }, 0);
          }

          close() {
            this.readyState = MockWebSocket.CLOSED;
            this.onclose?.(new CloseEvent("close"));
          }
        }

        Object.assign(window, {
          Audio: MockAudio,
          WebSocket: MockWebSocket,
          __voiceAudio: null,
          __voicePlayCount: 0,
          __voicePauseCount: 0
        });
      },
      { selectedChatId: chatId!, selectedCharacterId: characterId, reply: assistantContent }
    );

    await page.goto("/");
    const composer = page.locator("#chat-message-input");
    await expect(page.getByTestId("chat-message-viewport").getByText(historicalContent)).toBeVisible();
    expect(speechRequests).toHaveLength(0);
    await composer.fill("Can you hear me?");
    await page.locator('#chat-primary-action[data-chat-action="send"]').click();

    await expect.poll(() => speechRequests[0] ?? null).toEqual(
      expect.objectContaining({ text: assistantContent, voice: "nova", format: "mp3" })
    );
    await expect
      .poll(() =>
        page.evaluate(() => ({
          rate: (window as unknown as { __voiceAudio: { playbackRate: number } }).__voiceAudio.playbackRate,
          plays: (window as unknown as { __voicePlayCount: number }).__voicePlayCount
        }))
      )
      .toEqual({ rate: 1.5, plays: 1 });

    const speechButton = page.locator('[data-chat-action="voice-speak"]');
    await expect(speechButton).toHaveAttribute("title", "Stop speech playback");
    await speechButton.click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __voicePauseCount: number }).__voicePauseCount)
      )
      .toBe(1);

    const historicalBubble = page.locator("article").filter({ hasText: historicalContent }).first();
    const historicalSpeechButton = historicalBubble.locator(
      '[data-chat-action="voice-speak-message"]'
    );
    await expect(historicalSpeechButton).toHaveAttribute("title", "Read this reply");
    await historicalSpeechButton.click();
    await expect.poll(() => speechRequests[1] ?? null).toEqual(
      expect.objectContaining({ text: historicalContent, voice: "nova", format: "mp3" })
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __voicePlayCount: number }).__voicePlayCount)
      )
      .toBe(2);
    await expect(historicalSpeechButton).toHaveAttribute("title", "Stop speech playback");
    await historicalSpeechButton.click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __voicePauseCount: number }).__voicePauseCount)
      )
      .toBe(2);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("assistant messages expose matched lore and memory context to users", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Context Character ${suffix}`;
  const chatTitle = `Context Chat ${suffix}`;
  const loreId = `context-lore-${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "Stay in scene.",
        prompt: "You are a context visibility fixture.",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [
          {
            id: loreId,
            keys: ["archive"],
            content: "The archive key is behind the blue door.",
            priority: 4,
            scope: "prompt",
            triggerMode: "both",
            alwaysActive: false,
            enabled: true
          }
        ],
        quickReplies: []
      }
    });
    expect(characterResponse.ok()).toBeTruthy();
    const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
    characterId = character?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: {
        title: chatTitle,
        characterId,
        memoryTurns: 12,
        autoMemoryEnabled: true,
        backgroundUrl: "",
        userPersona: "",
        userProfileSummary: ""
      }
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
    chatId = chat?.id ?? null;
    expect(chatId).toBeTruthy();

    await request.post("/api/messages", {
      data: {
        chatId,
        role: "user",
        content: "What do we know about the archive?"
      }
    });
    await request.post("/api/messages", {
      data: {
        chatId,
        role: "assistant",
        characterId,
        content: "The blue door still matters.",
        variants: ["The blue door still matters."],
        activeVariantIndex: 0,
        tokenUsage: {
          promptTokens: 120,
          completionTokens: 12,
          totalTokens: 132,
          estimated: true
        },
        promptBreakdown: {
          promptTokens: 120,
          promptTokensEstimated: true,
          includedMessageCount: 2,
          sections: [
            { id: "character", tokenEstimate: 30, characterCount: 60, itemCount: 1 },
            { id: "lore", tokenEstimate: 25, characterCount: 50, itemCount: 1 },
            { id: "memory", tokenEstimate: 25, characterCount: 50, itemCount: 1 },
            { id: "history", tokenEstimate: 40, characterCount: 80, itemCount: 2 }
          ]
        },
        loreMatches: [
          {
            id: loreId,
            characterId,
            characterName,
            keys: ["archive"],
            content: "The archive key is behind the blue door.",
            priority: 4,
            scope: "prompt",
            triggerMode: "both",
            alwaysActive: false,
            enabled: true
          }
        ],
        memoryMatches: [
          {
            id: `context-memory-${suffix}`,
            chatId,
            title: "Blue door clue",
            content: "The user found a blue door clue earlier.",
            keywords: ["blue door"],
            importance: 5,
            enabled: true
          }
        ]
      }
    });

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    const contextButton = page.locator('[data-chat-context-summary=""]').first();
    await expect(contextButton).toBeVisible();
    await contextButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("prompt-breakdown")).toBeVisible();
    await expect(page.getByTestId("prompt-breakdown-total")).toContainText("120");
    await expect(page.locator('[data-prompt-breakdown-section="lore"]')).toBeVisible();
    await expect(page.locator('[data-prompt-breakdown-section="history"]')).toBeVisible();
    await page.locator('[data-debug-section-toggle="chatMemories"]').click();
    await expect(page.getByText("Blue door clue", { exact: true })).toBeVisible();
    await page.locator('[data-debug-section-toggle="character"]').click();
    await page.locator('[data-debug-section-toggle="char-prompt"]').click();
    await expect(page.getByText("The archive key is behind the blue door.")).toBeVisible();
  } finally {
    if (chatId) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    if (characterId) {
      await request.delete(`/api/characters/${characterId}`);
    }
  }
});

test("character built-in css previews in the editor and styles only matching chats", async ({
  page,
  request
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  testInfo.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterAName = `CSS Character A ${suffix}`;
  const characterBName = `CSS Character B ${suffix}`;
  const chatATitle = `CSS Chat A ${suffix}`;
  const chatBTitle = `CSS Chat B ${suffix}`;
  const assistantReplyAText = "Assistant reply for character CSS coverage.";
  const assistantReplyA = `<div class="custom-fold"><details open><summary><span class="title-icon"></span>Memory Scroll</summary><p>${assistantReplyAText}</p><button class="css-danger">Accessible control</button></details></div>`;
  const assistantReplyB = "Assistant reply that should keep default chat styling.";
  const customCss = `body {
  background-color: rgb(253, 246, 227);
  color: rgb(75, 34, 12);
  font-family: Georgia, serif;
}

#chat-composer {
  background: rgb(17, 24, 39) !important;
  border: 2px solid rgb(255, 0, 0) !important;
}

#chat-message-input {
  color: rgb(34, 197, 94) !important;
}

[data-chat-message="assistant"] [data-chat-bubble] {
  background: rgb(12, 34, 56) !important;
  border-color: rgb(56, 189, 248) !important;
}

.custom-fold summary {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
}

.custom-fold summary .title-icon {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: rgb(196, 30, 58);
}

.custom-fold summary::after {
  content: "";
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid rgb(122, 59, 46);
  margin-left: auto;
}

.css-danger {
  display: none;
  font-size: 1px;
  pointer-events: none;
  animation: pulse 1s infinite;
  z-index: 999999;
}

@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }

/* Responsive card tweak */
@media (min-width: 1px) {
  .custom-fold summary {
    border-bottom: 3px solid rgb(1, 2, 3);
  }
}`;
  const expandedCss = `${customCss}
/* expanded editor smoke */`;
  const expandedOpeningHtml = `<section><h1>Expanded opening ${suffix}</h1></section>`;
  const settingsResponse = await request.get("/api/settings");
  const settingsPayload = (await settingsResponse.json()) as ApiDataResponse<Record<string, unknown>>;
  const originalSettings = settingsPayload.data ?? {};
  let characterStyleMode: "full" | "restricted" | "off" = "full";
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const appearance = originalSettings.appearancePreferences && typeof originalSettings.appearancePreferences === "object"
      ? originalSettings.appearancePreferences as Record<string, unknown>
      : {};
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { ...originalSettings, appearancePreferences: { ...appearance, characterStyle: characterStyleMode } } })
    });
  });

  const createCharacter = async (name: string) => {
    const response = await request.post("/api/characters", {
      data: {
        name,
        prefix: "Stay concise.",
        prompt: "A temporary character for built-in CSS coverage.",
        suffix: "Reply directly."
      }
    });
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as ApiDataResponse<E2ECharacter>;
    if (!payload.data) {
      throw new Error("Character creation did not return data");
    }
    return payload.data;
  };

  const createChat = async (title: string, characterId: string) => {
    const response = await request.post("/api/chats", {
      data: { title, characterId }
    });
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as ApiDataResponse<E2EChat>;
    if (!payload.data) {
      throw new Error("Chat creation did not return data");
    }
    return payload.data;
  };

  const createMessage = async (
    chatId: string,
    role: "user" | "assistant",
    content: string,
    characterId?: string
  ) => {
    const response = await request.post("/api/messages", {
      data: {
        chatId,
        role,
        content,
        ...(characterId ? { characterId } : {})
      }
    });
    expect(response.ok()).toBeTruthy();
  };

  const openHistoryAndSelectChat = async (title: string) => {
    await page.getByRole("button", { name: /历史|History/ }).click();
    await page
      .getByRole("dialog")
      .locator("[data-chat-history-row]")
      .filter({ hasText: title })
      .click();
  };

  const characterA = await createCharacter(characterAName);
  const characterB = await createCharacter(characterBName);
  const chatA = await createChat(chatATitle, characterA.id);
  const chatB = await createChat(chatBTitle, characterB.id);

  try {
    await createMessage(chatA.id, "user", "User prompt for character A.");
    await createMessage(chatA.id, "assistant", assistantReplyA, characterA.id);
    await createMessage(chatB.id, "user", "User prompt for character B.");
    await createMessage(chatB.id, "assistant", assistantReplyB, characterB.id);

    await page.goto("/characters");
    await page
      .getByPlaceholder(/搜索角色名称或简介|Search character name or description|閹兼粎鍌ㄧ憴鎺曞閸氬秶袨/)
      .fill(characterAName);
    const visibleEditButtons = page.locator("button:visible").filter({ hasText: /编辑|Edit/ });
    await expect(visibleEditButtons).toHaveCount(1);
    await visibleEditButtons.first().click();
    await page.getByRole("button", { name: /高级模式|Advanced/ }).click();
    await page.getByRole("button", { name: /内置\s*CSS|Built-in CSS/i }).click();
    await page.getByRole("textbox", { name: /内置\s*css|Built-in CSS/i }).fill(customCss);
    await page.getByTestId("expand-html-css-editor").click();
    await expect(page.getByTestId("expanded-character-textarea")).toHaveValue(customCss);
    await page.getByTestId("expanded-character-textarea").fill(expandedCss);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("textbox", { name: /内置\s*css|Built-in CSS/i })).toHaveValue(
      expandedCss
    );
    await page.getByRole("button", { name: /聊天界面|Chat UI/ }).click();

    const previewComposer = page.locator("#chat-composer");
    const previewInput = page.locator("#chat-message-input");
    const previewAssistantBubble = page.locator(
      '[data-chat-message="assistant"] [data-chat-bubble]'
    );

    await expect(previewComposer).toHaveCSS("background-color", "rgb(17, 24, 39)");
    await expect(previewComposer).toHaveCSS("border-top-color", "rgb(255, 0, 0)");
    await expect(previewInput).toHaveCSS("color", "rgb(34, 197, 94)");
    await expect(previewAssistantBubble).toHaveCSS("background-color", "rgb(12, 34, 56)");
    await page.getByRole("button", { name: /开场 HTML|Opening HTML/i }).click();
    await page.getByTestId("expand-opening-html-editor").click();
    await page.getByTestId("expanded-character-textarea").fill(expandedOpeningHtml);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(
      page.getByPlaceholder(/输入开场 HTML|Enter opening HTML/i)
    ).toHaveValue(expandedOpeningHtml);

    await page
      .getByRole("button", { name: /保存|Save/ })
      .last()
      .click();
    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);

    const storedCharacterResponse = await request.get(`/api/characters/${characterA.id}`);
    expect(storedCharacterResponse.ok()).toBeTruthy();
    const storedCharacter = (await storedCharacterResponse.json()) as ApiDataResponse<
      E2ECharacter & { htmlCss?: string; openingHtml?: string }
    >;
    expect(storedCharacter.data?.htmlCss).toContain("#chat-composer");
    expect(storedCharacter.data?.htmlCss).toContain("expanded editor smoke");
    expect(storedCharacter.data?.openingHtml).toBe(expandedOpeningHtml);

    await page.goto("/");
    await openHistoryAndSelectChat(chatATitle);
    await expect(page.getByTestId("chat-message-viewport").getByText(assistantReplyAText)).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("background-color", "rgb(253, 246, 227)");
    await expect(page.locator("#chat-page-root")).not.toHaveCSS(
      "background-color",
      "rgb(253, 246, 227)"
    );
    await expect(page.locator("#chat-composer")).toHaveCSS("background-color", "rgb(17, 24, 39)");
    await expect(page.locator("#chat-composer")).toHaveCSS("border-top-color", "rgb(255, 0, 0)");
    await expect(page.locator("#chat-message-input")).toHaveCSS("color", "rgb(34, 197, 94)");
    await expect(
      page.locator('[data-chat-message="assistant"] [data-chat-bubble]').first()
    ).toHaveCSS("background-color", "rgb(12, 34, 56)");
    const renderedRootStyles = await page.locator(".custom-fold").evaluate((element) => {
      const root = element.closest(".rp-wrap");
      if (!root) {
        throw new Error("Rendered HTML root was not found");
      }

      const rootStyle = getComputedStyle(root);
      return {
        backgroundColor: rootStyle.backgroundColor,
        color: rootStyle.color,
        fontFamily: rootStyle.fontFamily
      };
    });
    expect(renderedRootStyles.backgroundColor).toBe("rgb(253, 246, 227)");
    expect(renderedRootStyles.color).toBe("rgb(75, 34, 12)");
    expect(renderedRootStyles.fontFamily).toContain("Georgia");
    await expect(page.locator(".custom-fold summary")).toHaveCount(1);
    await expect(page.locator(".custom-fold summary .title-icon")).toHaveCSS(
      "background-color",
      "rgb(196, 30, 58)"
    );
    await expect(page.locator(".custom-fold summary")).toHaveCSS(
      "border-bottom-color",
      "rgb(1, 2, 3)"
    );
    const disclosureStyles = await page.locator(".custom-fold summary").evaluate((summary) => ({
      beforeContent: getComputedStyle(summary, "::before").content,
      afterContent: getComputedStyle(summary, "::after").content,
      listStyleType: getComputedStyle(summary).listStyleType
    }));
    expect(disclosureStyles).toEqual({
      beforeContent: "none",
      afterContent: '""',
      listStyleType: "none"
    });
    await expect(page.getByRole("button", { name: "Accessible control" })).toBeHidden();

    characterStyleMode = "restricted";
    await page.reload();
    await expect(page.getByRole("button", { name: "Accessible control" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accessible control" })).toHaveCSS("pointer-events", "auto");
    await expect(page.locator("#chat-composer")).toHaveCSS("background-color", "rgb(17, 24, 39)");

    characterStyleMode = "off";
    await page.reload();
    await expect(page.locator("#chat-composer")).not.toHaveCSS("background-color", "rgb(17, 24, 39)");
    await expect(page.getByRole("button", { name: "Accessible control" })).toBeVisible();

    await openHistoryAndSelectChat(chatBTitle);
    await expect(page.getByTestId("chat-message-viewport").getByText(assistantReplyB)).toBeVisible();
    await expect(page.locator("#chat-composer")).not.toHaveCSS(
      "background-color",
      "rgb(17, 24, 39)"
    );
    await expect(page.locator("#chat-message-input")).not.toHaveCSS("color", "rgb(34, 197, 94)");
    await expect(
      page.locator('[data-chat-message="assistant"] [data-chat-bubble]').first()
    ).not.toHaveCSS("background-color", "rgb(12, 34, 56)");

    await page.locator('[data-testid="chat-docs-entry"]:visible').click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByTestId("docs-page-root")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /样式参考|Appearance Reference/ })
    ).toBeVisible();
  } finally {
    await permanentlyDeleteChatViaApi(request, chatA.id).catch(() => {});
    await permanentlyDeleteChatViaApi(request, chatB.id).catch(() => {});
    await request.delete(`/api/characters/${characterA.id}`).catch(() => {});
    await request.delete(`/api/characters/${characterB.id}`).catch(() => {});
  }
});

test("character management can create a character with markdown prompt fields", async ({
  page,
  request
}, testInfo) => {
  const cleanupE2ECharacter = async (name: string) => {
    const response = await request.get("/api/characters");
    const payload = (await response.json()) as ApiDataResponse<E2ECharacter[]>;
    const characters = Array.isArray(payload.data) ? payload.data : [];

    await Promise.all(
      characters
        .filter((character) => character.name === name)
        .map((character) => request.delete(`/api/characters/${character.id}`))
    );
  };

  await page.goto("/characters");

  await page.getByRole("button", { name: /^(新建|New)$/ }).click();
  await expect(page.getByRole("heading", { name: /创建角色|Create Character/ })).toBeVisible();
  await page.getByRole("button", { name: /高级模式|Advanced/ }).click();
  const name = `E2E Character ${testInfo.project.name} ${Date.now()}`;

  try {
    await page.getByLabel(/名称|Name/).fill(name);
    const promptEditors = page.locator(".roleplay-md-editor textarea");
    await promptEditors.nth(0).fill("Stay within the role boundary and keep the response stable.");
    await promptEditors
      .nth(1)
      .fill("This is an original character card used for end-to-end coverage.");
    await promptEditors.nth(2).fill("Reply concisely.");
    await page.getByRole("button", { name: /保存|Save/ }).last().click();

    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);
    await expect
      .poll(async () => {
        const response = await request.get("/api/characters");
        const payload = (await response.json()) as ApiDataResponse<E2ECharacter[]>;
        const characters = Array.isArray(payload.data) ? payload.data : [];
        return characters.some((character) => character.name === name);
      })
      .toBe(true);
  } finally {
    await cleanupE2ECharacter(name);
  }
});

test("chat context budget uses the active model window and latest token usage", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Budget Character ${suffix}`;
  const chatTitle = `Budget Chat ${suffix}`;
  const now = new Date().toISOString();
  let characterId: string | null = null;
  let chatId: string | null = null;

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "context-budget-settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://example.com/v1",
          model: "budget-model",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers: [
            {
              id: "context-budget-provider",
              label: "Budget provider",
              provider: "openai-compatible",
              apiBaseUrl: "https://example.com/v1",
              models: [
                {
                  id: "context-budget-model",
                  label: "Budget model",
                  model: "budget-model",
                  contextWindow: 4096,
                  capabilities: ["text_generation"]
                }
              ]
            }
          ],
          activeProviderId: "context-budget-provider",
          activeModelId: "context-budget-model",
          moduleModelPreferences: {},
          userPersonaPresets: [],
          userProfileSummary: "",
          autoSummarizeUser: false,
          showMessageAvatars: true,
          showMessageTimestamps: false,
          ttsVoice: "alloy",
          ttsPlaybackRate: 1,
          ttsAutoPlay: false,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: true
        }
      })
    });
  });

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        prefix: "Stay in scene.",
        prompt: "You are a context budget fixture.",
        suffix: "Reply directly."
      }
    });
    expect(characterResponse.ok()).toBeTruthy();
    const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
    characterId = character?.id ?? null;
    expect(characterId).toBeTruthy();

    const chatResponse = await request.post("/api/chats", {
      data: { title: chatTitle, characterId, memoryTurns: 12 }
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
    chatId = chat?.id ?? null;
    expect(chatId).toBeTruthy();

    const messageResponse = await request.post("/api/messages", {
      data: {
        chatId,
        role: "assistant",
        characterId,
        content: "The current scene is ready.",
        tokenUsage: {
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          estimated: false
        }
      }
    });
    expect(messageResponse.ok()).toBeTruthy();

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("#chat-settings-trigger").click();
    await page.getByTestId("chat-context-budget-trigger").click();

    const dialog = page.getByTestId("chat-context-budget-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Budget provider / Budget model")).toBeVisible();
    await expect(dialog.getByTestId("context-budget-total")).toContainText("2,000");
    await expect(dialog.getByTestId("context-budget-window")).toHaveText("4,096");
    await expect(dialog.locator('[data-context-budget-status="safe"]')).toBeVisible();
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("character editor protects unsaved changes before leaving", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const originalName = `Unsaved Character ${suffix}`;
  const draftName = `${originalName} Draft`;
  let characterId = "";

  try {
    const createResponse = await request.post("/api/characters", {
      data: {
        name: originalName,
        description: "Protect this character draft before navigation.",
        prefix: "",
        prompt: "Keep the role stable.",
        suffix: ""
      }
    });
    expect(createResponse.ok()).toBeTruthy();
    characterId =
      ((await createResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? "";
    expect(characterId).toBeTruthy();

    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色|Search characters/).fill(originalName);
    const card = page.locator(`[data-character-id="${characterId}"]`);
    await expect(card).toBeVisible();
    await card.locator('[data-character-action="edit"]').click();

    const nameInput = page.getByLabel(/名称|Name/);
    await nameInput.fill(draftName);
    await expect(page.getByTestId("character-unsaved-indicator")).toBeVisible();
    await expect(page.getByTestId("character-save")).toBeEnabled();

    const editorBackButton = page.getByTestId("character-editor-back");
    await editorBackButton.click();
    const discardDialog = page.getByRole("dialog");
    await expect(discardDialog).toContainText(
      /当前角色还有未保存的内容|This character still has unsaved content/
    );
    const cancelDiscardButton = discardDialog.getByRole("button", { name: /取消|Cancel/ });
    const confirmDiscardButton = discardDialog.getByRole("button", {
      name: /放弃更改|Discard Changes/
    });
    await expect(cancelDiscardButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirmDiscardButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancelDiscardButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(discardDialog).toBeHidden();
    await expect(editorBackButton).toBeFocused();
    await expect(nameInput).toHaveValue(draftName);

    if ((page.viewportSize()?.width ?? 1280) < 1024) {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await page
        .getByTestId("mobile-nav-content")
        .getByRole("button", { name: /^(聊天|Chat)$/ })
        .click();
    } else {
      await page
        .getByTestId("desktop-sidebar")
        .getByRole("button", { name: /^(聊天|Chat)$/ })
        .click();
    }

    const navigationDialog = page.getByRole("dialog", {
      name: /未保存的更改|Unsaved Changes/
    });
    await expect(navigationDialog).toContainText(
      /当前页面有未保存的更改|This page has unsaved changes/
    );
    await navigationDialog
      .getByRole("button", { name: /放弃并离开|Discard and Leave/ })
      .click();
    await expect(page).toHaveURL(/\/$/);

    const persistedResponse = await request.get(`/api/characters/${characterId}`);
    const persisted = (await persistedResponse.json()) as ApiDataResponse<E2ECharacter>;
    expect(persisted.data?.name).toBe(originalName);
  } finally {
    if (characterId) {
      await request.delete(`/api/characters/${characterId}`).catch(() => {});
    }
  }
});

test("character creation studio preserves advanced fields, checks quality, applies and undoes mocked AI drafts", async ({ page, request }, testInfo) => {
  testInfo.setTimeout(90_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const name = `Original Studio ${suffix}`;
  let createdId = "";
  let createdChatId = "";
  let aiRequest: Record<string, unknown> | null = null;

  await page.route("**/api/characters/draft", async (route) => {
    aiRequest = route.request().postDataJSON() as Record<string, unknown>;
    if (aiRequest.brief === "cancel-me") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: {
      requestId: aiRequest.requestId, task: aiRequest.task, title: "Core prompt draft",
      notice: "AI-generated draft. Review it for accuracy before applying or saving.",
      sentFieldCategories: ["name", "description", "brief"], createdAt: new Date().toISOString(),
      items: [
        { id: "studio-draft-1", field: "prompt", title: "Original core draft", suggestion: "AI suggested original core prompt." },
        { id: "studio-draft-2", field: "loreEntries", title: "Original lore draft", suggestion: "A proposed original lore entry.", loreEntry: { keys: ["draft-key"], content: "Draft lore content.", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true } },
        { id: "studio-draft-3", field: "quickReplies", title: "Original reply draft", suggestion: "A proposed quick reply.", quickReply: { label: "Draft greeting", content: "Hello from the draft." } }
      ]
    } }) });
  });

  try {
    await page.goto("/characters");
    await page.getByRole("button", { name: /^(新建|New)$/ }).click();
    await page.getByRole("button", { name: /基础模式|Basic/ }).click();
    await expect(page.getByTestId("character-wizard")).toBeVisible();
    await page.getByLabel(/名称|Name/).fill(name);
    await page.getByLabel(/简介|Description/).fill("An original character created in the guided studio.");
    await page.getByRole("button", { name: /下一步（可跳过）|Next \(optional\)/ }).click();
    await page.locator('[data-character-field="prompt"] .roleplay-md-editor textarea').fill("Original user core prompt.");
    await page.getByRole("button", { name: /下一步（可跳过）|Next \(optional\)/ }).click();
    await page.getByRole("button", { name: /下一步（可跳过）|Next \(optional\)/ }).click();
    await expect(page.getByTestId("character-review-preview")).toContainText(name);
    await page.getByRole("button", { name: /上一步|Previous/ }).click();
    await page.getByRole("button", { name: /切换高级编辑|Switch to advanced/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("star-companion-character-editor-mode"))).toBe("advanced");
    const promptEditors = page.locator(".roleplay-md-editor textarea");
    await expect(promptEditors.nth(1)).toHaveValue("Original user core prompt.");
    await expect(promptEditors.nth(1)).toHaveAttribute("aria-describedby", "character-prompt-help");
    await expect(page.locator("#character-prompt-help")).toContainText(/提示词|prompt/i);
    await promptEditors.nth(0).fill("Advanced prefix must survive basic save.");
    await promptEditors.nth(2).fill("Advanced suffix must survive basic save.");
    await page.getByRole("button", { name: /开场 HTML|Opening HTML/i }).click();
    await page.getByRole("textbox", { name: /^开场 HTML$|^Opening HTML$/i }).fill('<div>Safe opening<img src="http://insecure.invalid/tracker.png" onerror="window.__openingAttack=true"><script>window.__openingAttack=true</script></div>');
    const openingPreview = page.getByTestId("opening-html-preview");
    await expect(openingPreview).toContainText("Safe opening");
    await expect(openingPreview.locator("script")).toHaveCount(0);
    await expect(openingPreview.locator("img")).not.toHaveAttribute("src", /http:/);
    expect(await page.evaluate(() => (window as Window & { __openingAttack?: boolean }).__openingAttack)).not.toBe(true);
    await page.getByRole("button", { name: /^检查$|^Review$/ }).click();
    await page.getByTestId("run-character-quality").click();
    await expect(page.getByTestId("character-quality-panel")).toContainText(/估算|Estimated|≈/);
    await page.getByLabel(/简介|Description/).fill("");
    await page.getByTestId("run-character-quality").click();
    await page.getByTestId("character-quality-panel").locator("button", { hasText: "description_empty" }).click();
    await expect(page.getByLabel(/简介|Description/)).toBeFocused();
    await page.getByLabel(/简介|Description/).fill("An original character created in the guided studio.");
    await page.getByRole("button", { name: /^检查$|^Review$/ }).click();
    await page.getByTestId("run-character-quality").click();
    await expect(page.getByTestId("character-quality-panel")).toContainText(/未发现问题|No issues found/);

    await page.getByRole("button", { name: /创作助手|Draft assistant/ }).click();
    await page.getByLabel(/可选要点|Optional points/).fill("cancel-me");
    await page.getByTestId("run-character-draft").click();
    await page.getByRole("button", { name: /^取消$|^Cancel$/ }).click();
    await expect(page.getByTestId("run-character-draft")).toBeEnabled();
    await expect(page.getByText("AI suggested original core prompt.")).toHaveCount(0);
    await page.getByLabel(/可选要点|Optional points/).fill("");
    await page.getByTestId("run-character-draft").click();
    await expect(page.getByText("AI suggested original core prompt.")).toBeVisible();
    expect(aiRequest).not.toBeNull();
    expect(JSON.stringify(aiRequest)).not.toContain("apiKey");
    expect(JSON.stringify(aiRequest)).not.toContain("chat");
    await page.getByText("Original core draft").locator(".." ).getByRole("button", { name: /应用此项|Apply item/ }).click();
    await page.getByRole("button", { name: /撤销上次草稿操作|Undo last draft action/ }).click();
    await page.getByRole("button", { name: /放弃草案|Discard/ }).click();
    await expect(page.getByText("AI suggested original core prompt.")).toHaveCount(0);
    await page.getByTestId("run-character-draft").click();
    await page.getByRole("button", { name: /全部应用|Apply all/ }).click();
    const applyAllDialog = page.getByRole("dialog", { name: /全部应用 AI 草案|Apply all AI drafts/ });
    await expect(applyAllDialog).toBeVisible();
    await applyAllDialog.getByRole("button", { name: /应用并保留撤销|Apply and keep undo/ }).click();
    await page.getByTestId("character-editor-section-prompt").click();
    await expect(page.locator('[data-character-field="prompt"] .roleplay-md-editor textarea').nth(1)).toHaveValue("AI suggested original core prompt.");
    await page.getByTestId("character-editor-section-lore").click();
    await expect(page.getByText("draft-key", { exact: true })).toBeVisible();
    await page.getByTestId("character-editor-section-quickReplies").click();
    await expect(page.getByText("Draft greeting", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /撤销上次草稿操作|Undo last draft action/ }).click();
    await expect(page.getByText("Draft greeting", { exact: true })).toHaveCount(0);
    await page.getByTestId("character-editor-section-prompt").click();
    await expect(page.locator('[data-character-field="prompt"] .roleplay-md-editor textarea').nth(1)).toHaveValue("Original user core prompt.");
    await page.getByRole("button", { name: /基础模式|Basic/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("star-companion-character-editor-mode"))).toBe("basic");
    await page.getByRole("button", { name: /2\. (核心设定|Core)/ }).click();
    await expect(page.locator('[data-character-field="prompt"] .roleplay-md-editor textarea')).toHaveValue("Original user core prompt.");
    await page.getByTestId("character-save").click();
    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);

    const characters = ((await (await request.get("/api/characters")).json()) as ApiDataResponse<E2ECharacter[]>).data ?? [];
    createdId = characters.find((item) => item.name === name)?.id ?? "";
    expect(createdId).toBeTruthy();
    const saved = ((await (await request.get(`/api/characters/${createdId}`)).json()) as ApiDataResponse<E2ECharacter>).data!;
    expect(saved.prompt).toBe("Original user core prompt.");
    expect(saved.prefix).toBe("Advanced prefix must survive basic save.");
    expect(saved.suffix).toBe("Advanced suffix must survive basic save.");

    await page.getByLabel(/简介|Description/).fill("Updated from basic mode without touching advanced fields.");
    await page.getByTestId("character-save").click();
    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);
    const savedAfterBasicUpdate = ((await (await request.get(`/api/characters/${createdId}`)).json()) as ApiDataResponse<E2ECharacter>).data!;
    expect(savedAfterBasicUpdate.description).toBe("Updated from basic mode without touching advanced fields.");
    expect(savedAfterBasicUpdate.prefix).toBe("Advanced prefix must survive basic save.");
    expect(savedAfterBasicUpdate.suffix).toBe("Advanced suffix must survive basic save.");

    const exported = ((await (await request.post(`/api/characters/${createdId}/export`, { data: { visibility: "public" } })).json()) as ApiDataResponse<Record<string, unknown>>).data!;
    expect(JSON.stringify(exported)).not.toContain("editorMode");
    expect(JSON.stringify(exported)).not.toContain("wizardStep");
    expect(JSON.stringify(exported)).not.toContain("AI suggested original core prompt");
    const importedCard = { ...exported, cardId: `roundtrip-${suffix}`, character: { ...(exported.character as Record<string, unknown>), name: `${name} Roundtrip` } };
    const importedResponse = await request.post("/api/characters/import", { data: importedCard });
    expect(importedResponse.ok()).toBeTruthy();
    const imported = ((await importedResponse.json()) as ApiDataResponse<E2ECharacter>).data!;
    expect(imported.prompt).toBe(savedAfterBasicUpdate.prompt);
    expect(imported.prefix).toBe(savedAfterBasicUpdate.prefix);
    expect(imported.suffix).toBe(savedAfterBasicUpdate.suffix);
    await request.delete(`/api/characters/${imported.id}`);
    await expect(page.getByTestId("character-start-chat")).toBeVisible();
    await page.getByTestId("character-start-chat").click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("star-companion:selected-chat"))).not.toBeNull();
    createdChatId = await page.evaluate(() => localStorage.getItem("star-companion:selected-chat") ?? "");
  } finally {
    if (createdChatId) await permanentlyDeleteChatViaApi(request, createdChatId).catch(() => {});
    if (createdId) await request.delete(`/api/characters/${createdId}`);
  }
});

test("character favorites persist and filter the library", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const favoriteName = `Favorite Character ${suffix}`;
  const regularName = `Regular Character ${suffix}`;
  const createdIds: string[] = [];

  try {
    for (const name of [favoriteName, regularName]) {
      const response = await request.post("/api/characters", {
        data: {
          name,
          description: `Favorite filter coverage for ${name}`,
          prefix: "",
          prompt: "Stay concise.",
          suffix: ""
        }
      });
      expect(response.ok()).toBeTruthy();
      createdIds.push(((await response.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? "");
    }

    await page.goto("/characters");
    const favoriteCard = page.locator(`[data-character-id="${createdIds[0]}"]`);
    await expect(favoriteCard).toBeVisible();
    await favoriteCard.locator('[data-character-action="favorite"]').click();
    await expect(favoriteCard).toHaveAttribute("data-character-favorite", "true");

    await page.getByTestId("characters-favorites-filter").click();
    await expect(favoriteCard).toBeVisible();
    await expect(page.locator(`[data-character-id="${createdIds[1]}"]`)).toHaveCount(0);

    await page.reload();
    const persistedCard = page.locator(`[data-character-id="${createdIds[0]}"]`);
    await expect(persistedCard).toHaveAttribute("data-character-favorite", "true");
    await expect(
      persistedCard.locator('[data-character-action="favorite"]')
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    await Promise.all(
      createdIds.filter(Boolean).map((id) => request.delete(`/api/characters/${id}`).catch(() => {}))
    );
  }
});

test("character library sorts by name and duplicates a character", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const prefix = `Library Sort ${suffix}`;
  const createdIds: string[] = [];
  let alphaCharacter: E2ECharacter | null = null;

  try {
    for (const label of ["Zulu", "Alpha"]) {
      const response = await request.post("/api/characters", {
        data: {
          name: `${prefix} ${label}`,
          description: `Character library sorting coverage ${suffix}`,
          prefix: "",
          prompt: `Prompt for ${label}`,
          suffix: ""
        }
      });
      expect(response.ok()).toBeTruthy();
      const character = ((await response.json()) as ApiDataResponse<E2ECharacter>).data;
      expect(character?.id).toBeTruthy();
      createdIds.push(character?.id ?? "");
      if (label === "Alpha") alphaCharacter = character ?? null;
    }

    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(prefix);
    await page.getByTestId("characters-sort").selectOption("name_asc");

    const cards = page.locator("[data-character-id]");
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute("data-character-id", alphaCharacter?.id ?? "");
    await cards.first().getByRole("button", { name: /编辑|Edit/ }).click();
    await page.getByRole("button", { name: /复制角色|Duplicate Character/ }).click();
    await expect(page.getByRole("status")).toContainText(/角色副本已创建|Character duplicate created/);

    await expect
      .poll(async () => {
        const response = await request.get("/api/characters");
        const payload = (await response.json()) as ApiDataResponse<E2ECharacter[]>;
        return payload.data?.find((character) => character.name === `${alphaCharacter?.name} copy`) ??
          payload.data?.find((character) => character.name === `${alphaCharacter?.name} 副本`) ??
          null;
      })
      .not.toBeNull();

    const response = await request.get("/api/characters");
    const payload = (await response.json()) as ApiDataResponse<E2ECharacter[]>;
    const duplicated = payload.data?.find(
      (character) => character.name === `${alphaCharacter?.name} copy` || character.name === `${alphaCharacter?.name} 副本`
    );
    expect(duplicated?.cardId).not.toBe(alphaCharacter?.cardId);
    expect(duplicated?.prompt).toBe(alphaCharacter?.prompt);
    if (duplicated?.id) createdIds.push(duplicated.id);
  } finally {
    await Promise.all(
      createdIds.filter(Boolean).map((id) => request.delete(`/api/characters/${id}`).catch(() => {}))
    );
  }
});

test("character cover uploads locally and can be removed", async ({ page, request }, testInfo) => {
  const name = `Local Cover ${testInfo.project.name} ${Date.now()}`;
  const imageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";
  const response = await request.post("/api/characters", {
    data: { name, description: "Local cover upload coverage.", prompt: "Stay concise." }
  });
  expect(response.ok()).toBeTruthy();
  const character = ((await response.json()) as ApiDataResponse<E2ECharacter>).data;
  expect(character?.id).toBeTruthy();

  try {
    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(name);
    const card = page.locator(`[data-character-id="${character?.id}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: /编辑|Edit/ }).click();

    await page.getByTestId("character-avatar-upload").setInputFiles({
      name: "cover.png",
      mimeType: "image/png",
      buffer: Buffer.from(imageBase64, "base64")
    });
    await expect(page.getByRole("status")).toContainText(
      /本地封面已载入|Local cover loaded/
    );
    await expect(page.getByTestId("character-cover-preview")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/
    );

    await page.getByRole("button", { name: /保存|Save/ }).last().click();
    await expect
      .poll(async () => {
        const saved = await request.get(`/api/characters/${character?.id}`);
        return ((await saved.json()) as ApiDataResponse<{ avatar: string | null }>).data?.avatar ?? "";
      })
      .toMatch(/^data:image\/png;base64,/);

    await page.getByRole("button", { name: /移除封面|Remove cover/ }).click();
    await page.getByRole("button", { name: /保存|Save/ }).last().click();
    await expect
      .poll(async () => {
        const saved = await request.get(`/api/characters/${character?.id}`);
        return ((await saved.json()) as ApiDataResponse<{ avatar: string | null }>).data?.avatar;
      })
      .toBeNull();
  } finally {
    if (character?.id) await request.delete(`/api/characters/${character.id}`).catch(() => {});
  }
});

test("character batch management adds and removes tags", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const prefix = `Batch Tags ${suffix}`;
  const createdIds: string[] = [];

  try {
    for (const label of ["Alpha", "Beta"]) {
      const response = await request.post("/api/characters", {
        data: {
          name: `${prefix} ${label}`,
          description: `Batch tag coverage ${suffix}`,
          tags: ["existing"],
          prompt: `Prompt for ${label}`
        }
      });
      expect(response.ok()).toBeTruthy();
      const character = ((await response.json()) as ApiDataResponse<E2ECharacter>).data;
      expect(character?.id).toBeTruthy();
      createdIds.push(character?.id ?? "");
    }

    await page.goto("/characters");
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(prefix);
    await expect(page.locator("[data-character-id]")).toHaveCount(2);

    await page.getByTestId("characters-batch-mode").click();
    for (const id of createdIds) {
      await page.locator(`[data-character-id="${id}"]`).click();
    }
    await page.getByTestId("characters-batch-add-tags").click();
    await page.getByTestId("characters-batch-tags-input").fill("campaign, Existing");
    await page.getByTestId("characters-batch-tags-input").press("Enter");
    await page.getByTestId("characters-batch-tags-apply").click();
    await expect(page.getByRole("status")).toContainText(/已为 2 个角色添加标签|Tags added to 2 characters/);

    await expect
      .poll(async () => {
        const values = await Promise.all(
          createdIds.map(async (id) => {
            const response = await request.get(`/api/characters/${id}`);
            return ((await response.json()) as ApiDataResponse<E2ECharacter>).data?.tags ?? [];
          })
        );
        return values.every(
          (tags) =>
            tags.includes("campaign") &&
            tags.filter((tag) => tag.toLowerCase() === "existing").length === 1
        );
      })
      .toBe(true);

    await page.getByTestId("characters-batch-mode").click();
    for (const id of createdIds) {
      await page.locator(`[data-character-id="${id}"]`).click();
    }
    await page.getByTestId("characters-batch-remove-tags").click();
    const dialog = page.getByTestId("characters-batch-tags-dialog");
    await dialog.getByRole("button", { name: "campaign", exact: true }).click();
    await page.getByTestId("characters-batch-tags-apply").click();
    await expect(page.getByRole("status")).toContainText(/已从 2 个角色移除标签|Tags removed from 2 characters/);

    await expect
      .poll(async () => {
        const values = await Promise.all(
          createdIds.map(async (id) => {
            const response = await request.get(`/api/characters/${id}`);
            return ((await response.json()) as ApiDataResponse<E2ECharacter>).data?.tags ?? [];
          })
        );
        return values.every((tags) => !tags.includes("campaign") && tags.includes("existing"));
      })
      .toBe(true);

    const limitUpdate = await request.put(`/api/characters/${createdIds[0]}`, {
      data: {
        tags: Array.from({ length: 24 }, (_, index) => `limit-${index}`)
      }
    });
    expect(limitUpdate.ok()).toBeTruthy();
    await page.reload();
    await page.getByPlaceholder(/搜索角色名称或简介|Search character name or description/).fill(prefix);
    await expect(page.locator("[data-character-id]")).toHaveCount(2);
    await page.getByTestId("characters-batch-mode").click();
    for (const id of createdIds) {
      await page.locator(`[data-character-id="${id}"]`).click();
    }
    await page.getByTestId("characters-batch-add-tags").click();
    await page.getByTestId("characters-batch-tags-input").fill("overflow");
    await page.getByTestId("characters-batch-tags-input").press("Enter");
    await page.getByTestId("characters-batch-tags-apply").click();
    await expect(page.getByTestId("characters-batch-tags-dialog")).toContainText(
      /每个角色最多只能有 24 个标签|Each character can have at most 24 tags/
    );
    await expect(page.getByTestId("characters-batch-tags-dialog")).toBeVisible();
    for (const id of createdIds) {
      const response = await request.get(`/api/characters/${id}`);
      const tags = ((await response.json()) as ApiDataResponse<E2ECharacter>).data?.tags ?? [];
      expect(tags).not.toContain("overflow");
    }
  } finally {
    await Promise.all(
      createdIds.filter(Boolean).map((id) => request.delete(`/api/characters/${id}`).catch(() => {}))
    );
  }
});

test("mobile chat drawer switches between sections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const navigationTrigger = page.getByRole("button", { name: /Toggle navigation/ });
  await expect(navigationTrigger).toBeVisible();
  await navigationTrigger.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await expect(drawer.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(navigationTrigger).toBeFocused();

  await navigationTrigger.click();
  let mobileDrawer = page.getByTestId("mobile-nav-content");
  await expect(mobileDrawer.getByRole("button", { name: /历史|History/ })).toBeVisible();
  await expect(mobileDrawer.getByRole("button", { name: /文档|Docs/ })).toBeVisible();

  await mobileDrawer.getByRole("button", { name: /角色|Characters/ }).click();
  await expect(page.getByRole("heading", { name: /角色工坊|Character Studio/ })).toBeVisible();

  await page.getByRole("button", { name: /Toggle navigation/ }).click();
  mobileDrawer = page.getByTestId("mobile-nav-content");
  await mobileDrawer.getByRole("button", { name: /^(聊天|Chat)$/ }).click();
  await expect(page.getByRole("heading", { name: /消息流|Message Stream|Chat Workbench/ })).toBeVisible();
  await expect(page.getByText(/前往角色中开始聊天吧|Go to Characters to start chatting/)).toBeVisible();
});

test("chat settings control avatars and message timestamps", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Avatar Check ${suffix}`;
  const chatTitle = `Avatar Chat ${suffix}`;
  const assistantText = "Assistant reply for avatar visibility coverage.";
  const userText = "User message for avatar visibility coverage.";

  const settingsResponse = await request.get("/api/settings");
  expect(settingsResponse.ok()).toBeTruthy();
  const originalSettings = (await settingsResponse.json()).data;

  const persistSettings = async (showMessageAvatars: boolean, showMessageTimestamps: boolean) => {
    const response = await request.put("/api/settings", {
      data: {
        activeProvider: originalSettings.activeProvider,
        apiBaseUrl: originalSettings.apiBaseUrl,
        model: originalSettings.model,
        temperature: originalSettings.temperature,
        maxTokens: originalSettings.maxTokens,
        topP: originalSettings.topP,
        language: originalSettings.language,
        providers: originalSettings.providers ?? [],
        activeProviderId: originalSettings.activeProviderId ?? "",
        activeModelId: originalSettings.activeModelId ?? "",
        autoSummarizeUser: originalSettings.autoSummarizeUser,
        userProfileSummary: originalSettings.userProfileSummary ?? "",
        showMessageAvatars,
        showMessageTimestamps
      }
    });
    expect(response.ok()).toBeTruthy();
  };

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay concise.",
      prompt: "A temporary character for avatar visibility testing.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  const userMessageResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: userText
    }
  });
  expect(userMessageResponse.ok()).toBeTruthy();

  const assistantMessageResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "assistant",
      characterId: character.id,
      content: assistantText
    }
  });
  expect(assistantMessageResponse.ok()).toBeTruthy();

  try {
    await persistSettings(false, true);

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const assistantBubble = page.locator("article").filter({ hasText: assistantText }).first();
    await expect(assistantBubble).toBeVisible();
    await expect(assistantBubble).not.toContainText(characterName);
    await expect(page.getByTestId("message-avatar")).toHaveCount(0);
    await expect(page.locator("[data-chat-message-timestamp]")).toHaveCount(2);
  } finally {
    await persistSettings(originalSettings.showMessageAvatars, originalSettings.showMessageTimestamps);
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat branches return to their highlighted source through Story paths", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Branch Character ${suffix}`;
  const chatTitle = `Branch Chat ${suffix}`;
  const branchTitle = `${chatTitle} - Branch`;
  const firstUserText = `First branch user turn ${suffix}`;
  const assistantText = `Assistant branch target ${suffix}`;
  const secondUserText = `Second branch user turn ${suffix}`;
  let branchChatId: string | undefined;

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay in branch test mode.",
      prompt: "A temporary character for branch testing.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: firstUserText
    }
  });
  const assistantResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "assistant",
      characterId: character.id,
      content: assistantText
    }
  });
  expect(assistantResponse.ok()).toBeTruthy();
  const assistantMessage = (await assistantResponse.json()).data;
  await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: secondUserText
    }
  });

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const assistantBubble = page.locator("article").filter({ hasText: assistantText }).first();
    await expect(assistantBubble).toBeVisible();
    await assistantBubble.getByRole("button", { name: /从这里创建分支|Branch from here/ }).click();

    const messageViewport = page.getByTestId("chat-message-viewport");
    await expect(messageViewport.getByText(firstUserText)).toBeVisible();
    await expect(messageViewport.getByText(assistantText)).toBeVisible();
    await expect(messageViewport.getByText(secondUserText)).toHaveCount(0);
    await page.getByTestId("chat-story-trigger").click();
    const storyNavigator = page.getByTestId("chat-story-navigator");
    await expect(storyNavigator.getByTestId("chat-story-path-node")).toHaveCount(2);
    await storyNavigator
      .locator(`[data-testid="chat-story-path-node"][data-chat-id="${chat.id}"]`)
      .click();
    await expect(messageViewport.getByText(secondUserText)).toBeVisible();
    await expect(page.locator(`[data-message-id="${assistantMessage.id}"]`)).toHaveClass(/ring-2/);

    const chatsResponse = await request.get("/api/chats");
    expect(chatsResponse.ok()).toBeTruthy();
    const chats = (await chatsResponse.json()).data as E2EChat[];
    branchChatId = chats.find((candidate) => candidate.title === branchTitle)?.id;
    expect(branchChatId).toBeTruthy();
  } finally {
    if (branchChatId) {
      await permanentlyDeleteChatViaApi(request, branchChatId);
    }
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("a checkpoint stays in the background and opens from Story paths", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Checkpoint Character ${suffix}`;
  const chatTitle = `Checkpoint Chat ${suffix}`;
  const checkpointTitle = `Checkpoint Save ${suffix}`;
  const messageText = `Save this plot point ${suffix}`;
  let checkpointId: string | null = null;

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary checkpoint character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", {
    data: { title: chatTitle, characterId: character.id }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;
  const messageResponse = await request.post("/api/messages", {
    data: { chatId: chat.id, role: "user", content: messageText }
  });
  expect(messageResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    const bubble = page.locator("article").filter({ hasText: messageText }).first();
    await bubble.locator('[data-chat-action="checkpoint"]').click();
    const checkpointDialog = page.getByRole("dialog").last();
    await checkpointDialog.getByLabel(/标题|Title/).fill(checkpointTitle);
    await checkpointDialog.getByRole("button", { name: /保存检查点|Save checkpoint/ }).click();
    await expect(page.locator("#chat-title")).toContainText(chatTitle);
    await expect(
      page.getByText(/检查点已保存，可在历史记录中打开。|Checkpoint saved. Open it from History/)
    ).toBeVisible();
    await page.getByTestId("chat-story-trigger").click();
    const checkpointPath = page
      .getByTestId("chat-story-navigator")
      .getByTestId("chat-story-child")
      .filter({ hasText: checkpointTitle });
    await expect(checkpointPath).toContainText(messageText);
    await checkpointPath.click();
    await expect(page.locator("#chat-title")).toContainText(checkpointTitle);

    const chatsResponse = await request.get("/api/chats");
    expect(chatsResponse.ok()).toBeTruthy();
    const chats = (await chatsResponse.json()).data as Array<E2EChat & { isCheckpoint?: boolean }>;
    checkpointId = chats.find((candidate) => candidate.isCheckpoint && candidate.title === checkpointTitle)?.id ?? null;
    expect(checkpointId).toBeTruthy();
    const checkpointResponse = await request.get(`/api/chats/${checkpointId}`);
    expect(checkpointResponse.ok()).toBeTruthy();
    const checkpoint = await checkpointResponse.json();
    expect(checkpoint.data.parentChatId).toBe(chat.id);
    expect(checkpoint.data.isCheckpoint).toBe(true);
    expect(checkpoint.data.messages).toHaveLength(1);
  } finally {
    if (checkpointId) await permanentlyDeleteChatViaApi(request, checkpointId);
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("only the latest assistant reply exposes the continue action", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Continue Character ${suffix}`;
  const chatTitle = `Continue Chat ${suffix}`;
  const firstAssistantText = `Earlier assistant reply ${suffix}`;
  const latestAssistantText = `Latest assistant reply ${suffix}`;

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary continuation test character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;

  const chatResponse = await request.post("/api/chats", {
    data: { title: chatTitle, characterId: character.id }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  await request.post("/api/messages", {
    data: { chatId: chat.id, role: "user", content: `Start continuation test ${suffix}` }
  });
  await request.post("/api/messages", {
    data: { chatId: chat.id, role: "assistant", characterId: character.id, content: firstAssistantText }
  });
  await request.post("/api/messages", {
    data: { chatId: chat.id, role: "assistant", characterId: character.id, content: latestAssistantText }
  });

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const firstBubble = page.locator("article").filter({ hasText: firstAssistantText }).first();
    const latestBubble = page.locator("article").filter({ hasText: latestAssistantText }).first();
    await expect(firstBubble.locator('[data-chat-action="continue"]')).toHaveCount(0);
    await expect(latestBubble.locator('[data-chat-action="continue"]')).toBeVisible();
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("messages can be excluded from future model context without deletion", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Context Toggle Character ${suffix}`;
  const chatTitle = `Context Toggle Chat ${suffix}`;
  const messageText = `Keep this visible but excluded ${suffix}`;

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary context-toggle character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", {
    data: { title: chatTitle, characterId: character.id }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;
  const messageResponse = await request.post("/api/messages", {
    data: { chatId: chat.id, role: "user", content: messageText }
  });
  expect(messageResponse.ok()).toBeTruthy();
  const message = (await messageResponse.json()).data;

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    const bubble = page.locator("article").filter({ hasText: messageText }).first();
    await bubble.locator('[data-chat-action="context-toggle"]').click();
    await expect(bubble.locator("xpath=..")).toHaveAttribute("data-context-included", "false");
    await expect(bubble.getByTestId("message-context-excluded")).toBeVisible();

    const updatedMessageResponse = await request.get(`/api/messages/${message.id}`);
    expect(updatedMessageResponse.ok()).toBeTruthy();
    expect((await updatedMessageResponse.json()).data.contextIncluded).toBe(false);
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat timeline distinguishes rolling context from manually excluded messages", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Context Boundary Character ${suffix}`;
  const chatTitle = `Context Boundary Chat ${suffix}`;
  const messageIds: string[] = [];

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "",
      prompt: "Temporary context-boundary character.",
      suffix: ""
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", {
    data: { title: chatTitle, characterId: character.id, memoryTurns: 1 }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  for (let index = 0; index < 35; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const messageResponse = await request.post("/api/messages", {
      data: {
        chatId: chat.id,
        role,
        characterId: role === "assistant" ? character.id : undefined,
        content: `Context boundary message ${index + 1} ${suffix}`
      }
    });
    expect(messageResponse.ok()).toBeTruthy();
    messageIds.push((await messageResponse.json()).data.id);
  }

  const excludedMessageId = messageIds[34];
  const excludeResponse = await request.put(`/api/messages/${excludedMessageId}`, {
    data: { contextIncluded: false }
  });
  expect(excludeResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    await expect(page.getByTestId("chat-message-pagination")).toBeVisible();
    const boundary = page.getByTestId("chat-context-boundary");
    await expect(boundary).toBeVisible();
    await expect(boundary).toHaveAttribute("data-context-included-count", "3");
    await expect(boundary).toHaveAttribute("data-context-outside-count", "31");

    await expect(page.locator(`[data-message-id="${messageIds[30]}"]`)).toHaveAttribute(
      "data-next-reply-context",
      "outside"
    );
    await expect(page.locator(`[data-message-id="${messageIds[31]}"]`)).toHaveAttribute(
      "data-next-reply-context",
      "included"
    );
    const excludedMessage = page.locator(`[data-message-id="${excludedMessageId}"]`);
    await expect(excludedMessage).toHaveAttribute("data-next-reply-context", "excluded");
    await expect(excludedMessage.getByTestId("message-context-excluded")).toBeVisible();
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("bookmarked messages persist and jump to saved chat history", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Bookmark Character ${suffix}`;
  const chatTitle = `Bookmark Chat ${suffix}`;
  const firstMessageText = `Bookmark this visible message ${suffix}`;
  const targetMessageText = `Jump to this later bookmark ${suffix}`;

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary bookmark character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;
  const chatResponse = await request.post("/api/chats", {
    data: { title: chatTitle, characterId: character.id }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  let firstMessageId = "";
  let targetMessageId = "";
  const firstResponse = await request.post("/api/messages", {
    data: { chatId: chat.id, role: "user", content: firstMessageText }
  });
  expect(firstResponse.ok()).toBeTruthy();
  firstMessageId = (await firstResponse.json()).data.id;

  const targetResponse = await request.post("/api/messages", {
    data: { chatId: chat.id, role: "user", content: targetMessageText }
  });
  expect(targetResponse.ok()).toBeTruthy();
  targetMessageId = (await targetResponse.json()).data.id;
  const bookmarkTargetResponse = await request.put(`/api/messages/${targetMessageId}`, {
    data: { isBookmarked: true }
  });
  expect(bookmarkTargetResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const firstBubble = page.locator("article").filter({ hasText: firstMessageText }).first();
    const firstBookmark = firstBubble.locator('[data-chat-action="bookmark"]');
    await firstBookmark.click();
    await expect(firstBookmark).toHaveAttribute("aria-pressed", "true");

    const persistedFirstResponse = await request.get(`/api/messages/${firstMessageId}`);
    expect(persistedFirstResponse.ok()).toBeTruthy();
    expect((await persistedFirstResponse.json()).data.isBookmarked).toBe(true);

    await page.getByTestId("chat-bookmarks-trigger").click();
    const bookmarks = page.getByTestId("chat-bookmarks-dialog");
    await expect(bookmarks).toBeVisible();
    await bookmarks.getByTestId("chat-bookmark-result").filter({ hasText: targetMessageText }).click();
    await expect(page.locator("article").filter({ hasText: targetMessageText }).first()).toBeVisible();
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat drafts are restored per chat after switching and reloading", async ({ page, request }) => {
  const suffix = Date.now();
  const characterName = `Draft Character ${suffix}`;
  const firstTitle = `Draft First ${suffix}`;
  const secondTitle = `Draft Second ${suffix}`;
  const firstDraft = "Keep this unfinished thought for the first chat.";
  const secondDraft = "This draft belongs to the second chat.";

  const characterResponse = await request.post("/api/characters", {
    data: { name: characterName, prefix: "", prompt: "Temporary draft test character.", suffix: "" }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
  if (!character) throw new Error("Character creation did not return data");

  const firstResponse = await request.post("/api/chats", {
    data: { title: firstTitle, characterId: character.id }
  });
  const secondResponse = await request.post("/api/chats", {
    data: { title: secondTitle, characterId: character.id }
  });
  const firstChat = ((await firstResponse.json()) as ApiDataResponse<E2EChat>).data;
  const secondChat = ((await secondResponse.json()) as ApiDataResponse<E2EChat>).data;
  if (!firstChat || !secondChat) throw new Error("Chat creation did not return data");

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, firstTitle);
    const input = page.locator("#chat-message-input");
    await input.fill(firstDraft);

    await openChatHistoryAndSelect(page, secondTitle);
    await expect(input).toHaveValue("");
    await input.fill(secondDraft);

    await openChatHistoryAndSelect(page, firstTitle);
    await expect(input).toHaveValue(firstDraft);

    await page.reload();
    await openChatHistoryAndSelect(page, secondTitle);
    await expect(page.locator("#chat-message-input")).toHaveValue(secondDraft);
  } finally {
    await permanentlyDeleteChatViaApi(request, firstChat.id);
    await permanentlyDeleteChatViaApi(request, secondChat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("the last selected chat is restored after reloading the app", async ({ page, request }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Restore Character ${suffix}`;
  const chatTitle = `Restore Chat ${suffix}`;
  let characterId: string | null = null;
  let chatId: string | null = null;

  try {
    const characterResponse = await request.post("/api/characters", {
      data: {
        name: characterName,
        avatar: null,
        description: "",
        tags: [],
        prefix: "",
        prompt: "",
        suffix: "",
        htmlCss: "",
        openingHtml: "",
        loreEntries: [],
        quickReplies: []
      }
    });
    characterId = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data?.id ?? null;
    const chatResponse = await request.post("/api/chats", { data: { title: chatTitle, characterId } });
    chatId = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data?.id ?? null;

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await expect(page.locator("#chat-title")).toContainText(chatTitle);
    await page.reload();
    await expect(page.locator("#chat-title")).toContainText(chatTitle);
  } finally {
    if (chatId) await permanentlyDeleteChatViaApi(request, chatId);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
  }
});

test("chat model switch preserves stored key and runtime settings when provider has no dedicated key", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(90_000);
  const suffix = Date.now();
  const characterName = `Switch Character ${suffix}`;
  const chatTitle = `Switch Chat ${suffix}`;
  const now = new Date().toISOString();
  const providers: E2EProviderProfile[] = [
    {
      id: "provider-active",
      label: "OpenAI",
      provider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      models: [
        { id: "model-active", label: "Active Model", model: "gpt-4o-mini" },
        { id: "model-target", label: "Target Model", model: "gpt-4o" }
      ]
    }
  ];

  const moduleModelPreferences = {
    agent: { providerId: "provider-active", modelId: "model-active" }
  };
  const userPersonaPresets = [
    {
      id: "switch-preset",
      name: "Switch preset",
      avatar: "",
      config: {
        displayName: "Switch User",
        prefix: "Boundary.",
        prompt: "User role.",
        suffix: "Be concise."
      },
      createdAt: now,
      updatedAt: now
    }
  ];
  const latestSettingsPut: { value: SettingsPutPayload | null } = { value: null };

  await page.route("**/api/settings", async (route) => {
    const method = route.request().method();

    if (method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: "settings-switch-e2e",
            activeProvider: providers[0].provider,
            apiBaseUrl: providers[0].apiBaseUrl,
            model: providers[0].models[0].model,
            temperature: 1.1,
            maxTokens: 1200,
            topP: 0.9,
            language: "en",
            providers,
            activeProviderId: providers[0].id,
            activeModelId: providers[0].models[0].id,
            moduleModelPreferences,
            userPersonaPresets,
            userProfileSummary: "Stored profile summary.",
            autoSummarizeUser: true,
            showMessageAvatars: true,
            showMessageTimestamps: false,
            appearancePreferences: { themeMode: "system", fontSize: "standard", lineHeight: "comfortable", chatWidth: "standard", messageSpacing: "standard", contrast: "standard", motion: "system", backgroundOverlay: 0.55, backgroundBlur: "subtle", characterStyle: "full" },
            userProfileUpdatedAt: null,
            createdAt: now,
            updatedAt: now,
            hasApiKey: true
          }
        })
      });
      return;
    }

    if (method === "PUT") {
      latestSettingsPut.value = (route.request().postDataJSON() as SettingsPutPayload) ?? null;
      const putProviders = latestSettingsPut.value?.providers ?? providers;
      const putActiveProviderId = latestSettingsPut.value?.activeProviderId ?? providers[0].id;
      const putActiveModelId = latestSettingsPut.value?.activeModelId ?? providers[0].models[0].id;
      const activeProvider = putProviders.find((p) => p.id === putActiveProviderId) ?? putProviders[0];
      const activeModel = activeProvider?.models.find((m) => m.id === putActiveModelId) ?? activeProvider?.models[0];

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: "settings-switch-e2e",
            activeProvider: activeProvider?.provider ?? latestSettingsPut.value?.activeProvider,
            apiBaseUrl: activeProvider?.apiBaseUrl ?? latestSettingsPut.value?.apiBaseUrl,
            model: activeModel?.model ?? latestSettingsPut.value?.model,
            temperature: latestSettingsPut.value?.temperature,
            maxTokens: latestSettingsPut.value?.maxTokens,
            topP: latestSettingsPut.value?.topP,
            language: latestSettingsPut.value?.language,
            providers: putProviders,
            activeProviderId: putActiveProviderId,
            activeModelId: putActiveModelId,
            moduleModelPreferences:
              latestSettingsPut.value?.moduleModelPreferences ?? moduleModelPreferences,
            userPersonaPresets: latestSettingsPut.value?.userPersonaPresets ?? userPersonaPresets,
            userProfileSummary: latestSettingsPut.value?.userProfileSummary ?? "Stored profile summary.",
            autoSummarizeUser: true,
            showMessageAvatars: true,
            showMessageTimestamps: false,
            appearancePreferences: latestSettingsPut.value?.appearancePreferences,
            userProfileUpdatedAt: null,
            createdAt: now,
            updatedAt: now,
            hasApiKey: true
          }
        })
      });
      return;
    }

    await route.continue();
  });

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay concise.",
      prompt: "A temporary character for model switching coverage.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
  if (!character) {
    throw new Error("Character creation did not return data");
  }

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
  if (!chat) {
    throw new Error("Chat creation did not return data");
  }

  const seedMessageResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: "Seed message for chat history visibility."
    }
  });
  expect(seedMessageResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    await page.evaluate((chatId) => localStorage.setItem("star-companion:selected-chat", chatId), chat.id);
    await page.reload();
    await expect(page.locator("#chat-title")).toContainText(chatTitle);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /模型切换|Switch Model/ }).click();
    await page.getByRole("button", { name: /Target Model/ }).click();

    await expect.poll(() => latestSettingsPut.value).not.toBeNull();
    expect(latestSettingsPut.value?.language).toBe("en");
    expect(latestSettingsPut.value?.temperature).toBe(1.1);
    expect(latestSettingsPut.value?.maxTokens).toBe(1200);
    expect(latestSettingsPut.value?.topP).toBe(0.9);
    expect(latestSettingsPut.value).not.toHaveProperty("apiKey");
    expect(latestSettingsPut.value?.moduleModelPreferences).toEqual(moduleModelPreferences);
    expect(latestSettingsPut.value?.userPersonaPresets).toEqual(userPersonaPresets);
    expect(latestSettingsPut.value?.userProfileSummary).toBe("Stored profile summary.");
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat persona presets save a visible identity and prompt config", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Custom Config Character ${suffix}`;
  const chatTitle = `Custom Config Chat ${suffix}`;
  const customConfig = {
    prefix: "Treat the next prompt as a session-specific preface.",
    prompt: "The user is a field analyst who keeps private notes.",
    suffix: "Prefer crisp answers and preserve the established dynamic."
  };
  const presetName = `Analyst Persona ${suffix}`;
  const personaDisplayName = `Analyst ${suffix}`;
  const imageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";
  let userPersonaPresets: unknown[] = [];
  const now = new Date().toISOString();

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay concise.",
      prompt: "A temporary character for custom config coverage.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
  if (!character) {
    throw new Error("Character creation did not return data");
  }

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
  if (!chat) {
    throw new Error("Chat creation did not return data");
  }

  const seedMessageResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: "Seed message for chat history visibility."
    }
  });
  expect(seedMessageResponse.ok()).toBeTruthy();

  try {
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as { userPersonaPresets?: unknown[] };
        userPersonaPresets = body.userPersonaPresets ?? [];
      }

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: "settings-persona-presets-e2e",
            activeProvider: "openai-compatible",
            apiBaseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            temperature: 0.8,
            maxTokens: 800,
            topP: 1,
            language: "zh-CN",
            providers: [],
            activeProviderId: "",
            activeModelId: "",
            moduleModelPreferences: {},
            userPersonaPresets,
            userProfileSummary: "",
            autoSummarizeUser: true,
            showMessageAvatars: true,
            userProfileUpdatedAt: null,
            createdAt: now,
            updatedAt: now,
            hasApiKey: false
          }
        })
      });
    });

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("button[aria-expanded]").click();
    await page.getByRole("button", { name: /^(自定义配置|Custom Config)$/ }).click();

    const customConfigDialog = page.getByRole("dialog");
    const configInputs = customConfigDialog.locator("textarea");
    const displayNameInput = customConfigDialog.locator("#persona-display-name");
    await displayNameInput.fill(personaDisplayName);
    await customConfigDialog.getByTestId("persona-avatar-upload").setInputFiles({
      name: "persona.png",
      mimeType: "image/png",
      buffer: Buffer.from(imageBase64, "base64")
    });
    await expect(customConfigDialog.getByTestId("persona-avatar-preview")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/
    );
    await configInputs.nth(0).fill(customConfig.prefix);
    await configInputs.nth(1).fill(customConfig.prompt);
    await configInputs.nth(2).fill(customConfig.suffix);
    await customConfigDialog.getByLabel(/预设名称|Preset name/).fill(presetName);
    await customConfigDialog.getByRole("button", { name: /保存为预设|Save preset/ }).click();
    await expect(customConfigDialog.getByText(presetName)).toBeVisible();
    await configInputs.nth(0).fill("Temporary prefix that should be replaced.");
    await configInputs.nth(1).fill("Temporary prompt that should be replaced.");
    await configInputs.nth(2).fill("Temporary suffix that should be replaced.");
    await displayNameInput.fill("Temporary identity");
    await customConfigDialog.getByTestId("persona-avatar-remove").click();
    await customConfigDialog
      .locator("div")
      .filter({ hasText: presetName })
      .getByRole("button", { name: /应用|Apply/ })
      .first()
      .click();
    await expect(configInputs.nth(0)).toHaveValue(customConfig.prefix);
    await expect(configInputs.nth(1)).toHaveValue(customConfig.prompt);
    await expect(configInputs.nth(2)).toHaveValue(customConfig.suffix);
    await expect(displayNameInput).toHaveValue(personaDisplayName);
    await expect(customConfigDialog.getByTestId("persona-avatar-preview")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/
    );
    await customConfigDialog
      .getByRole("button", { name: /^(保存|Save)$/ })
      .click();

    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.locator("[data-chat-user-name]").first()).toHaveText(personaDisplayName);
    await expect(page.locator("[data-chat-message='user'] [data-chat-avatar]").first()).toHaveAttribute(
      "title",
      personaDisplayName
    );
    await expect(page.locator("[data-chat-message='user'] [data-chat-avatar] img").first()).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/
    );

    const storedChatResponse = await request.get(`/api/chats/${chat.id}`);
    expect(storedChatResponse.ok()).toBeTruthy();
    const storedChat = ((await storedChatResponse.json()) as ApiDataResponse<E2EChatDetails>).data;
    expect(storedChat?.userPersona).toContain('"type":"user-custom-config"');
    expect(storedChat?.userPersona).toContain('"version":2');
    expect(storedChat?.userPersona).toContain(personaDisplayName);
    expect(storedChat?.userPersona).toContain(customConfig.prefix);
    expect(storedChat?.userPersona).toContain(customConfig.prompt);
    expect(storedChat?.userPersona).toContain(customConfig.suffix);
    expect(storedChat?.userAvatar).toMatch(/^data:image\/png;base64,/);
    const chatListResponse = await request.get("/api/chats");
    const listedChats = ((await chatListResponse.json()) as ApiDataResponse<Array<Record<string, unknown>>>).data ?? [];
    expect(listedChats.find((entry) => entry.id === chat.id)).not.toHaveProperty("userAvatar");

    await page.reload();
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("button[aria-expanded]").click();
    await page.getByRole("button", { name: /^(自定义配置|Custom Config)$/ }).click();
    await expect(customConfigDialog.locator("textarea").nth(0)).toHaveValue(customConfig.prefix);
    await expect(customConfigDialog.locator("textarea").nth(1)).toHaveValue(customConfig.prompt);
    await expect(customConfigDialog.locator("textarea").nth(2)).toHaveValue(customConfig.suffix);
    await expect(customConfigDialog.locator("#persona-display-name")).toHaveValue(
      personaDisplayName
    );
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("module model selects only show models compatible with that feature", async ({ page }) => {
  const now = new Date().toISOString();
  const providers: E2EProviderProfile[] = [
    {
      id: "capability-provider",
      label: "Capability provider",
      provider: "openai-compatible",
      apiBaseUrl: "https://example.com/v1",
      models: [
        {
          id: "chat",
          label: "Chat model",
          model: "gpt-4o-mini",
          contextWindow: 32768,
          capabilities: ["text_generation"]
        },
        { id: "embedding", label: "Embedding model", model: "text-embedding-3-small", capabilities: ["text_embedding"] },
        { id: "speech", label: "Speech model", model: "tts-1", capabilities: ["text_to_speech"] },
        { id: "image", label: "Image model", model: "gpt-image-1", capabilities: ["image_generation"] }
      ]
    }
  ];

  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          id: "capability-settings-e2e",
          activeProvider: "openai-compatible",
          apiBaseUrl: "https://example.com/v1",
          model: "gpt-4o-mini",
          temperature: 0.8,
          maxTokens: 800,
          topP: 1,
          language: "en",
          providers,
          activeProviderId: "capability-provider",
          activeModelId: "chat",
          moduleModelPreferences: {},
          userPersonaPresets: [],
          userProfileSummary: "",
          autoSummarizeUser: true,
          showMessageAvatars: true,
          userProfileUpdatedAt: null,
          createdAt: now,
          updatedAt: now,
          hasApiKey: true
        }
      })
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Provider Management" }).click();
  await expect(page.getByLabel("Context window").first()).toHaveValue("32768");
  const imageOptions = page.getByLabel("Image generation").locator("option");
  await expect(imageOptions).toHaveText([
    "Current chat model is incompatible; choose a model",
    "Capability provider / Image model"
  ]);

  const speechOptions = page.getByLabel("Text to speech").locator("option");
  await expect(speechOptions).toHaveText([
    "Current chat model is incompatible; choose a model",
    "Capability provider / Speech model"
  ]);

  const agentOptions = page.getByLabel("AI Agent").locator("option");
  await expect(agentOptions).toHaveText(["Use current chat model", "Capability provider / Chat model"]);

  const embeddingOptions = page.getByLabel("Memory embeddings").locator("option");
  await expect(embeddingOptions).toHaveText([
    "Current chat model is incompatible; choose a model",
    "Capability provider / Embedding model"
  ]);
});

test("long-term memory delete confirm stays centered above the memory dialog", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Memory Delete Character ${suffix}`;
  const chatTitle = `Memory Delete Chat ${suffix}`;
  const memoryTitle = `Memory Delete Item ${suffix}`;

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay concise.",
      prompt: "A temporary character for memory delete coverage.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data;
  if (!character) {
    throw new Error("Character creation did not return data");
  }

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
  if (!chat) {
    throw new Error("Chat creation did not return data");
  }

  const memoryResponse = await request.post(`/api/chats/${chat.id}/memories`, {
    data: {
      title: memoryTitle,
      content: "The user wants memory delete confirmations to stay centered.",
      keywords: ["confirm"],
      importance: 3,
      enabled: true
    }
  });
  expect(memoryResponse.ok()).toBeTruthy();

  const seedMessageResponse = await request.post("/api/messages", {
    data: {
      chatId: chat.id,
      role: "user",
      content: "Seed message for memory delete dialog visibility."
    }
  });
  expect(seedMessageResponse.ok()).toBeTruthy();

  try {
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /^(记忆|Memory)$/ }).nth(1).click();

    const memoryDialog = page.getByRole("dialog").filter({ hasText: memoryTitle });
    await expect(memoryDialog).toBeVisible();
    await expect(memoryDialog.getByRole("paragraph").filter({ hasText: memoryTitle })).toBeVisible();
    await expect(memoryDialog.getByTestId("memory-index-summary")).toHaveAttribute(
      "data-memory-index-state",
      "unconfigured"
    );
    await expect(memoryDialog.getByTestId("memory-index-configure")).toBeVisible();
    await expect(memoryDialog.getByText(/仅关键词|Keywords only/)).toBeVisible();
    await memoryDialog
      .locator(`[data-chat-memory-action="delete"]`)
      .click();

    const confirmDialog = page.getByRole("dialog").filter({
      hasText: /删除这条长期记忆|Delete this long-term memory/
    });
    await expect(confirmDialog).toBeVisible();

    const geometry = await confirmDialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(centerX, centerY);
      return {
        centerDeltaX: Math.abs(centerX - window.innerWidth / 2),
        centerDeltaY: Math.abs(centerY - window.innerHeight / 2),
        isTopDialog: topElement ? element.contains(topElement) : false
      };
    });

    expect(geometry.centerDeltaX).toBeLessThan(12);
    expect(geometry.centerDeltaY).toBeLessThan(12);
    expect(geometry.isTopDialog).toBeTruthy();
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("memory history previews diffs, jumps across pages, restores tombstones, and confirms permanent purge", async ({ page, request }, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = Date.now();
  const characterResponse = await request.post("/api/characters", { data: { name: `Audit Character ${suffix}`, prefix: "Stay concise.", prompt: "Audit memory history.", suffix: "Reply directly." } });
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data!;
  const chatResponse = await request.post("/api/chats", { data: { title: `Audit Chat ${suffix}`, characterId: character.id } });
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data!;
  try {
    const sourceIds: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      const response = await request.post("/api/messages", { data: { chatId: chat.id, role: "user", content: index === 3 ? "Historical source needle" : `Audit message ${index}` } });
      sourceIds.push(((await response.json()) as ApiDataResponse<{ id: string }>).data!.id);
    }
    const createResponse = await request.post(`/api/chats/${chat.id}/memories`, { data: { title: "Audited memory", content: "Original remembered detail", keywords: ["original"], importance: 3, enabled: true, sourceMessageIds: [sourceIds[3]] } });
    const memory = ((await createResponse.json()) as ApiDataResponse<{ id: string; currentRevision: number }>).data!;
    await request.put(`/api/chats/${chat.id}/memories/${memory.id}`, { data: { content: "Edited remembered detail", keywords: ["edited"], importance: 4 } });

    await page.goto("/");
    await openChatHistoryAndSelect(page, `Audit Chat ${suffix}`);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /^(记忆|Memory)$/ }).nth(1).click();
    const auditPanel = page.getByTestId("memory-audit-panel");
    await auditPanel.getByRole("button", { name: "Audited memory" }).click();
    await expect(page.getByTestId("memory-revision-2")).toBeVisible();
    await page.getByTestId("memory-revision-2").getByRole("button").first().click();
    await expect(page.getByTestId("memory-revision-2")).toContainText(/内容|Content/);
    await page.getByTestId("memory-revision-1").getByRole("button").first().click();
    await page.getByTestId("memory-revision-1").locator("button").filter({ has: page.locator("svg.lucide-external-link") }).click();
    await expect(page.getByTestId("chat-message-viewport").getByText("Historical source needle")).toBeVisible();

    const historyResponse = await request.get(`/api/chats/${chat.id}/memories/${memory.id}/revisions`);
    const history = ((await historyResponse.json()) as ApiDataResponse<Array<{ revision: number }>>).data!;
    const currentResponse = await request.get(`/api/chats/${chat.id}/memories`);
    const current = ((await currentResponse.json()) as ApiDataResponse<Array<{ id: string; currentRevision: number }>>).data!.find((item) => item.id === memory.id)!;
    await request.delete(`/api/chats/${chat.id}/memories/${memory.id}`);
    const restoreResponse = await request.post(`/api/chats/${chat.id}/memories/${memory.id}/restore`, { data: { revision: history.at(-1)!.revision, expectedCurrentRevision: current.currentRevision + 1, confirm: "RESTORE_MEMORY_REVISION" } });
    expect(restoreResponse.ok()).toBeTruthy();
    await request.delete(`/api/chats/${chat.id}/memories/${memory.id}`);

    await page.reload();
    await openChatHistoryAndSelect(page, `Audit Chat ${suffix}`);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /^(记忆|Memory)$/ }).nth(1).click();
    await expect(page.getByText(/已删除|Deleted/, { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /永久清除历史|Permanently purge history/ }).click();
    await expect(page.getByRole("dialog").filter({ hasText: /永久清除记忆历史|Permanently purge memory history/ })).toBeVisible();
    const purgeDialog = page.getByRole("dialog").filter({ hasText: /永久清除记忆历史|Permanently purge memory history/ });
    await purgeDialog.locator("[data-dialog-cancel='true']").click();
    const stillThere = await request.get(`/api/chats/${chat.id}/memories/${memory.id}/revisions`);
    expect(stillThere.ok()).toBeTruthy();
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("chat profile summary history shows diffs and requires restore confirmation", async ({ page, request }) => {
  const suffix = Date.now();
  const characterResponse = await request.post("/api/characters", { data: { name: `Profile Character ${suffix}`, prompt: "Profile history fixture." } });
  const character = ((await characterResponse.json()) as ApiDataResponse<E2ECharacter>).data!;
  const chatResponse = await request.post("/api/chats", { data: { title: `Profile Chat ${suffix}`, characterId: character.id } });
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data!;
  try {
    await request.put(`/api/chats/${chat.id}`, { data: { userProfileSummary: "First profile version" } });
    await request.put(`/api/chats/${chat.id}`, { data: { userProfileSummary: "Second profile version" } });
    await page.goto("/");
    await openChatHistoryAndSelect(page, `Profile Chat ${suffix}`);
    await page.locator("#chat-settings-trigger").click();
    await page.getByRole("button", { name: /用户信息摘要|Profile Summary/ }).click();
    const panel = page.getByTestId("profile-history-panel");
    await expect(panel).toContainText("Second profile version");
    await expect(panel).toContainText("First profile version");
    await panel.getByRole("button", { name: /恢复|Restore/ }).last().click();
    const confirm = page.getByRole("dialog").filter({ hasText: /恢复画像摘要|Restore profile summary/ });
    await expect(confirm).toContainText("Second profile version");
    await expect(confirm).toContainText("First profile version");
    await confirm.locator("[data-dialog-cancel='true']").click();
    const current = await request.get(`/api/chats/${chat.id}`);
    expect(((await current.json()) as ApiDataResponse<{ userProfileSummary: string }>).data?.userProfileSummary).toBe("Second profile version");
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("long chats paginate and keep messages inside the scrollable viewport", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Paging Character ${suffix}`;
  const chatTitle = `Paging Chat ${suffix}`;
  const totalMessages = 90;

  const characterResponse = await request.post("/api/characters", {
    data: {
      name: characterName,
      prefix: "Stay concise.",
      prompt: "A temporary character for pagination coverage.",
      suffix: "Reply directly."
    }
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()).data;

  const chatResponse = await request.post("/api/chats", {
    data: {
      title: chatTitle,
      characterId: character.id
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()).data;

  try {
    for (let index = 0; index < totalMessages; index += 1) {
      const messageResponse = await request.post("/api/messages", {
        data: {
          chatId: chat.id,
          role: "user",
          content:
            index === 5
              ? `Paging message ${index} unique target needle`
              : `Paging message ${index}`
        }
      });
      expect(messageResponse.ok()).toBeTruthy();
    }

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const viewport = page.getByTestId("chat-message-viewport");
    await expect(viewport).toBeVisible();
    await expect(page.getByTestId("chat-message-pagination")).toBeVisible();
    await expect(viewport.getByText("Paging message 89")).toBeVisible();
    await expect(viewport.getByText("Paging message 0")).toHaveCount(0);
    const metrics = await viewport.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.getByTestId("chat-page-prev").click();

    await expect(viewport.getByText("Paging message 30")).toBeVisible();
    await expect(viewport.getByText("Paging message 89")).toHaveCount(0);

    await page.getByTestId("chat-search-trigger").click();
    const searchDialog = page.getByRole("dialog");
    await searchDialog.getByLabel(/搜索消息|Search messages/).fill("unique target needle");
    await searchDialog.getByRole("button", { name: /搜索|Search/ }).click();
    await expect(page.getByTestId("chat-search-result")).toHaveCount(1);
    await page.getByTestId("chat-search-result").click();
    await expect(viewport.getByText("Paging message 5")).toBeVisible();
    await expect(viewport.getByText("Paging message 30")).toHaveCount(0);
  } finally {
    await permanentlyDeleteChatViaApi(request, chat.id);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("character page tag filter can narrow to a paged server result before editing", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const prefix = `Bulk Character ${suffix}`;
  const targetName = `${prefix} target`;
  const targetTag = `server-tag-${suffix}`;
  const createdIds = Array.from(
    { length: 40 },
    (_, index) => `e2e-character-page-${suffix}-${index}`
  ).concat(`e2e-character-page-${suffix}-target`);

  try {
    const importResponse = await importBackupViaApi(request, {
        schemaVersion: 1,
        mode: "merge",
        characters: [
          ...Array.from({ length: 40 }, (_, index) => ({
            id: createdIds[index],
            cardId: `${createdIds[index]}-card`,
            name: `${prefix} ${String(index).padStart(2, "0")}`,
            avatar: null,
            description: "",
            prefix: "Paging fixture.",
            prompt: `Bulk prompt ${index}`,
            suffix: "Reply directly.",
            htmlCss: "",
            openingHtml: "",
            tags: [],
            loreEntries: [],
            quickReplies: []
          })),
          {
            id: createdIds[40],
            cardId: `${createdIds[40]}-card`,
            name: targetName,
            avatar: null,
            description: "",
            tags: [targetTag],
            prefix: "Paging fixture.",
            prompt: `Unique server-side-search token ${suffix}`,
            suffix: "Reply directly.",
            htmlCss: "",
            openingHtml: "",
            loreEntries: [],
            quickReplies: []
          }
        ],
        chats: [],
        messages: []
    });
    expect(importResponse.ok()).toBeTruthy();

    await page.goto("/characters");
    await page
      .getByPlaceholder(/搜索角色名称或简介|Search character name or description/)
      .fill(prefix);
    await expect(page.getByTestId("characters-page-next")).toBeEnabled();
    await page.getByTestId("characters-page-next").click();
    await expect(page.getByTestId("characters-page-prev")).toBeEnabled();

    await page.getByRole("button", { name: targetTag }).click();
    const targetCard = page
      .locator("div.group")
      .filter({ has: page.getByText(targetName) })
      .first();
    await expect(targetCard).toBeVisible();
    await targetCard.getByRole("button", { name: /编辑|Edit/ }).click();
    await expect(page.getByLabel(/名称|Name/)).toHaveValue(targetName);
  } finally {
    await Promise.all(
      createdIds.filter(Boolean).map((id) => request.delete(`/api/characters/${id}`))
    );
  }
});

test("character paging search can create a chat from the matching card", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const prefix = `Create Chat Character ${suffix}`;
  const targetName = `${prefix} target`;
  const targetTag = `chat-tag-${suffix}`;
  const createdIds = Array.from(
    { length: 40 },
    (_, index) => `e2e-create-chat-${suffix}-${index}`
  ).concat(`e2e-create-chat-${suffix}-target`);
  let chatId: string | null = null;

  try {
    const importResponse = await importBackupViaApi(request, {
        schemaVersion: 1,
        mode: "merge",
        characters: [
          ...Array.from({ length: 40 }, (_, index) => ({
            id: createdIds[index],
            cardId: `${createdIds[index]}-card`,
            name: `${prefix} ${String(index).padStart(2, "0")}`,
            avatar: null,
            description: "",
            prefix: "Create chat paging fixture.",
            prompt: `Create chat prompt ${index}`,
            suffix: "Reply directly.",
            htmlCss: "",
            openingHtml: "",
            tags: [],
            loreEntries: [],
            quickReplies: []
          })),
          {
            id: createdIds[40],
            cardId: `${createdIds[40]}-card`,
            name: targetName,
            avatar: null,
            description: "",
            tags: [targetTag],
            prefix: "Create chat paging fixture.",
            prompt: `Create chat unique-search token ${suffix}`,
            suffix: "Reply directly.",
            htmlCss: "",
            openingHtml: "",
            loreEntries: [],
            quickReplies: []
          }
        ],
        chats: [],
        messages: []
    });
    expect(importResponse.ok()).toBeTruthy();

    await page.goto("/characters");
    await page
      .getByPlaceholder(/搜索角色名称或简介|Search character name or description/)
      .fill(prefix);
    await expect(page.getByTestId("characters-page-next")).toBeEnabled();
    await page.getByTestId("characters-page-next").click();
    await expect(page.getByTestId("characters-page-prev")).toBeEnabled();

    await page.getByRole("button", { name: targetTag }).click();
    const targetCard = page
      .locator("div.group")
      .filter({ has: page.getByText(targetName) })
      .first();
    await expect(targetCard).toBeVisible();
    await targetCard.getByRole("button", { name: /游玩|Play/ }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#chat-title")).toContainText(/New Chat/);

    const chatsResponse = await request.get("/api/chats");
    const chats = ((await chatsResponse.json()) as ApiDataResponse<E2EChat[]>).data ?? [];
    chatId = chats.find((chat) => chat.title === "New Chat")?.id ?? null;
  } finally {
    if (chatId) {
      await permanentlyDeleteChatViaApi(request, chatId);
    }
    await Promise.all(
      createdIds.filter(Boolean).map((id) => request.delete(`/api/characters/${id}`))
    );
  }
});

test("private character imports keep export enabled before unlock and reveal prompt fields after unlock", async ({
  page,
  request
}, testInfo) => {
  testInfo.setTimeout(60_000);
  const name = `Imported Private Character ${testInfo.project.name} ${Date.now()}`;
  const password = "open-sesame";
  const file = await createPrivateCharacterCardFile(name, password);
  let createdId: string | null = null;

  try {
    await page.goto("/characters");
    await page.locator('input[type="file"]').setInputFiles(file.filePath);

    await expect(page.getByRole("heading", { name })).toBeVisible();

    const charactersResponse = await request.get("/api/characters");
    const characters =
      ((await charactersResponse.json()) as ApiDataResponse<E2ECharacter[]>).data ?? [];
    createdId = characters.find((character) => character.name === name)?.id ?? null;

    await expect(page.getByRole("button", { name: /^导出$|^Export$/ })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /输入密码查看|Unlock with Password/ })
    ).toBeVisible();
    await expect(page.locator(".roleplay-md-editor textarea")).toHaveCount(0);
    await expect(page.getByText("Hidden private prompt.")).toHaveCount(0);
    await expect(page.getByText("Hidden private opening.")).toHaveCount(0);

    await page.getByRole("button", { name: /输入密码查看|Unlock with Password/ }).click();
    await page.getByLabel(/密码|Password/).fill(password);
    await page.getByRole("button", { name: /查看内容|Reveal Content/ }).click();

    await page.getByRole("button", { name: /高级模式|Advanced/ }).click();

    const promptEditors = page.locator(".roleplay-md-editor textarea");
    await expect(page.getByRole("button", { name: /^导出$|^Export$/ })).toBeEnabled();
    await expect(promptEditors).toHaveCount(3);
    await expect(promptEditors.nth(0)).toHaveValue("Hidden private prefix.");
    await expect(promptEditors.nth(1)).toHaveValue("Hidden private prompt.");
    await expect(promptEditors.nth(2)).toHaveValue("Hidden private suffix.");
    await expect(page.getByText("Hidden private prompt.").first()).toBeVisible();
    await page.getByTestId("character-editor-section-html").click();
    await expect(page.locator('[data-character-field="htmlCss"] textarea').first()).toHaveValue(".private-card { color: #abc; }");
    await page.getByTestId("character-editor-section-opening").click();
    await expect(page.locator('[data-character-field="openingHtml"] textarea').first()).toHaveValue("<section>Hidden private opening.</section>");
  } finally {
    if (createdId) {
      await request.delete(`/api/characters/${createdId}`);
    }
    await rm(file.directory, { recursive: true, force: true });
  }
});
