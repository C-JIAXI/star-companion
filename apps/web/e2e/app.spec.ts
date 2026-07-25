import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

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
  messageCount?: number;
  lastMessagePreview?: {
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  } | null;
};

type E2EChatDetails = E2EChat & {
  userPersona: string;
};

type E2EProviderModel = {
  id: string;
  label: string;
  model: string;
  capabilities?: Array<
    "text_generation" |
    "text_embedding" |
    "audio_transcription" |
    "text_to_speech" |
    "image_generation"
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
    config: { prefix: string; prompt: string; suffix: string };
    createdAt: string;
    updatedAt: string;
  }>;
  userProfileSummary?: string;
};

type ApiDataResponse<T> = {
  data?: T;
};

const permanentlyDeleteChatViaApi = async (request: APIRequestContext, chatId: string) => {
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
      avatar: null
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

test("chat readiness surfaces missing first-run setup and links to settings", async ({ page }) => {
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

test("chat agent panel generates a read-only draft and inserts it into the composer", async ({
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
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          mode: body.mode ?? "reply_drafts",
          title: "Reply Drafts",
          content: "Agent draft reply for the next turn.",
          createdAt: new Date().toISOString(),
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
    await page.getByRole("button", { name: /插入输入框|Insert into composer/ }).click();
    await expect(page.locator("#chat-message-input")).toHaveValue(
      "Agent draft reply for the next turn."
    );

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

test("a default chat receives one persisted AI title after its first exchange", async ({
  page,
  request
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const characterName = `Auto Title Character ${suffix}`;
  const generatedTitle = "Blue Door Arrival";
  let characterId: string | null = null;
  let chatId: string | null = null;
  let titleRequests = 0;

  await page.route("**/api/chats/*/title-suggestion", async (route) => {
    titleRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { title: generatedTitle, createdAt: new Date().toISOString() }
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
    const persisted = (await (await request.get(`/api/chats/${chatId}`)).json()) as ApiDataResponse<E2EChat>;
    expect(persisted.data?.title).toBe(generatedTitle);
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
      await page.getByRole("button", { name: /Toggle navigation/ }).click();
    }
    await page.getByRole("button", { name: /历史|History/ }).click();
    await page
      .getByRole("group", { name: /历史搜索模式|History search mode/ })
      .getByRole("button", { name: /^(消息|Messages)$/ })
      .click();
    await page
      .getByPlaceholder(/搜索全部聊天中的消息|Search messages across all chats/)
      .fill("observatory key");
    await page.getByRole("button", { name: /搜索全部消息|Search all messages/ }).click();
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
  const assistantReplyA = `<div class="custom-fold"><details open><summary><span class="title-icon"></span>Memory Scroll</summary><p>${assistantReplyAText}</p></details></div>`;
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

/* Responsive card tweak */
@media (min-width: 1px) {
  .custom-fold summary {
    border-bottom: 3px solid rgb(1, 2, 3);
  }
}`;
  const expandedCss = `${customCss}
/* expanded editor smoke */`;
  const expandedOpeningHtml = `<section><h1>Expanded opening ${suffix}</h1></section>`;

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
      page.getByPlaceholder(/输入完整的 HTML 内容|Enter full HTML content/i)
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

  await expect(page.getByRole("button", { name: /Toggle navigation/ })).toBeVisible();
  await page.getByRole("button", { name: /Toggle navigation/ }).click();
  await expect(page.getByRole("button", { name: /历史|History/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /文档|Docs/ })).toBeVisible();

  await page.getByRole("button", { name: /角色|Characters/ }).click();
  await expect(page.getByRole("heading", { name: /角色工坊|Character Studio/ })).toBeVisible();

  await page.getByRole("button", { name: /Toggle navigation/ }).click();
  await page.getByRole("button", { name: /^(聊天|Chat)$/ }).click();
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

    const updatedMessageResponse = await request.get(`/api/messages/${message.id}`);
    expect(updatedMessageResponse.ok()).toBeTruthy();
    expect((await updatedMessageResponse.json()).data.contextIncluded).toBe(false);
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
}) => {
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
      config: { prefix: "Boundary.", prompt: "User role.", suffix: "Be concise." },
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
    await openChatHistoryAndSelect(page, chatTitle);
    await page.getByRole("button", { name: /记忆|Memory/ }).click();
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

test("chat custom config saves prefix prompt and suffix from memory settings", async ({
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
    await configInputs.nth(0).fill(customConfig.prefix);
    await configInputs.nth(1).fill(customConfig.prompt);
    await configInputs.nth(2).fill(customConfig.suffix);
    await customConfigDialog.getByLabel(/预设名称|Preset name/).fill(presetName);
    await customConfigDialog.getByRole("button", { name: /保存为预设|Save preset/ }).click();
    await expect(customConfigDialog.getByText(presetName)).toBeVisible();
    await configInputs.nth(0).fill("Temporary prefix that should be replaced.");
    await configInputs.nth(1).fill("Temporary prompt that should be replaced.");
    await configInputs.nth(2).fill("Temporary suffix that should be replaced.");
    await customConfigDialog
      .locator("div")
      .filter({ hasText: presetName })
      .getByRole("button", { name: /应用|Apply/ })
      .first()
      .click();
    await expect(configInputs.nth(0)).toHaveValue(customConfig.prefix);
    await expect(configInputs.nth(1)).toHaveValue(customConfig.prompt);
    await expect(configInputs.nth(2)).toHaveValue(customConfig.suffix);
    await customConfigDialog
      .getByRole("button", { name: /^(保存|Save)$/ })
      .click();

    await expect(page.getByRole("status")).toBeVisible();

    const storedChatResponse = await request.get(`/api/chats/${chat.id}`);
    expect(storedChatResponse.ok()).toBeTruthy();
    const storedChat = ((await storedChatResponse.json()) as ApiDataResponse<E2EChatDetails>).data;
    expect(storedChat?.userPersona).toContain('"type":"user-custom-config"');
    expect(storedChat?.userPersona).toContain(customConfig.prefix);
    expect(storedChat?.userPersona).toContain(customConfig.prompt);
    expect(storedChat?.userPersona).toContain(customConfig.suffix);

    await page.reload();
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("button[aria-expanded]").click();
    await page.getByRole("button", { name: /^(自定义配置|Custom Config)$/ }).click();
    await expect(customConfigDialog.locator("textarea").nth(0)).toHaveValue(customConfig.prefix);
    await expect(customConfigDialog.locator("textarea").nth(1)).toHaveValue(customConfig.prompt);
    await expect(customConfigDialog.locator("textarea").nth(2)).toHaveValue(customConfig.suffix);
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
        { id: "chat", label: "Chat model", model: "gpt-4o-mini", capabilities: ["text_generation"] },
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
    await expect(memoryDialog.getByText(memoryTitle)).toBeVisible();
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
    const importResponse = await request.post("/api/backups/import", {
      data: {
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
      }
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
    const importResponse = await request.post("/api/backups/import", {
      data: {
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
      }
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

    await page.getByRole("button", { name: /输入密码查看|Unlock with Password/ }).click();
    await page.getByLabel(/密码|Password/).fill(password);
    await page.getByRole("button", { name: /查看内容|Reveal Content/ }).click();

    const promptEditors = page.locator(".roleplay-md-editor textarea");
    await expect(page.getByRole("button", { name: /^导出$|^Export$/ })).toBeEnabled();
    await expect(promptEditors).toHaveCount(3);
    await expect(promptEditors.nth(0)).toHaveValue("Hidden private prefix.");
    await expect(promptEditors.nth(1)).toHaveValue("Hidden private prompt.");
    await expect(promptEditors.nth(2)).toHaveValue("Hidden private suffix.");
    await expect(page.getByText("Hidden private prompt.").first()).toBeVisible();
  } finally {
    if (createdId) {
      await request.delete(`/api/characters/${createdId}`);
    }
    await rm(file.directory, { recursive: true, force: true });
  }
});
