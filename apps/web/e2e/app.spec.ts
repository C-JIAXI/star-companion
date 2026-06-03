import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type Page } from "@playwright/test";

type E2ECharacter = {
  id: string;
  name: string;
};

type E2EChat = {
  id: string;
  title: string;
};

type E2EChatDetails = E2EChat & {
  userPersona: string;
};

type E2EProviderModel = {
  id: string;
  label: string;
  model: string;
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
};

type ApiDataResponse<T> = {
  data?: T;
};

const openChatHistoryAndSelect = async (page: Page, title: string) => {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1024) {
    await page.getByRole("button", { name: /Toggle navigation/ }).click();
  }

  await page.getByRole("button", { name: /历史|History/ }).click();
  await page.getByPlaceholder(/搜索历史对话|Search chat history/).fill(title);
  await page.getByRole("button", { name: title }).click();
};

const selectChatFromHistory = async (page: Page, title: string) => {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1024) {
    await page.getByRole("button", { name: /Toggle navigation/ }).click();
  }

  await page.getByRole("button", { name: /鍘嗗彶|History/ }).click();
  await page.getByRole("button", { name: title }).click();
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
  await expect(languageSelect).toHaveValue("zh-CN");
  const settingsGetCountAfterLoad = settingsGetCount;

  await languageSelect.selectOption("en");
  await expect(page.getByRole("heading", { name: "Model Settings" })).toBeVisible();
  await page.waitForTimeout(500);

  await expect(languageSelect).toHaveValue("en");
  expect(settingsGetCount).toBe(settingsGetCountAfterLoad);
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
  const assistantReplyA = "Assistant reply for character CSS coverage.";
  const assistantReplyB = "Assistant reply that should keep default chat styling.";
  const customCss = `#chat-composer {
  background: rgb(17, 24, 39) !important;
  border: 2px solid rgb(255, 0, 0) !important;
}

#chat-message-input {
  color: rgb(34, 197, 94) !important;
}

[data-chat-message="assistant"] [data-chat-bubble] {
  background: rgb(12, 34, 56) !important;
  border-color: rgb(56, 189, 248) !important;
}`;

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
    await page.getByRole("button", { name: title }).click();
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

    await page
      .getByRole("button", { name: /保存|Save/ })
      .last()
      .click();
    await expect(page.getByRole("status")).toContainText(/角色已保存|Character saved/);

    const storedCharacterResponse = await request.get(`/api/characters/${characterA.id}`);
    expect(storedCharacterResponse.ok()).toBeTruthy();
    const storedCharacter = (await storedCharacterResponse.json()) as ApiDataResponse<
      E2ECharacter & { htmlCss?: string }
    >;
    expect(storedCharacter.data?.htmlCss).toContain("#chat-composer");

    await page.goto("/");
    await openHistoryAndSelectChat(chatATitle);
    await expect(page.getByText(assistantReplyA)).toBeVisible();
    await expect(page.locator("#chat-composer")).toHaveCSS("background-color", "rgb(17, 24, 39)");
    await expect(page.locator("#chat-composer")).toHaveCSS("border-top-color", "rgb(255, 0, 0)");
    await expect(page.locator("#chat-message-input")).toHaveCSS("color", "rgb(34, 197, 94)");
    await expect(
      page.locator('[data-chat-message="assistant"] [data-chat-bubble]').first()
    ).toHaveCSS("background-color", "rgb(12, 34, 56)");

    await openHistoryAndSelectChat(chatBTitle);
    await expect(page.getByText(assistantReplyB)).toBeVisible();
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
    await request.delete(`/api/chats/${chatA.id}`).catch(() => {});
    await request.delete(`/api/chats/${chatB.id}`).catch(() => {});
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

  await page.getByRole("button", { name: /新建|New/ }).click();
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
  await page.getByRole("button", { name: /聊天|Chat/ }).click();
  await expect(page.getByRole("heading", { name: /消息流|Message Stream|Chat Workbench/ })).toBeVisible();
  await expect(page.getByText(/前往角色中开始聊天吧|Go to Characters to start chatting/)).toBeVisible();
});

test("chat settings can hide avatars and message bubbles do not show sender names", async ({
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

  const persistSettings = async (showMessageAvatars: boolean) => {
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
        showMessageAvatars
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
    await persistSettings(false);

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const assistantBubble = page.locator("article").filter({ hasText: assistantText }).first();
    await expect(assistantBubble).toBeVisible();
    await expect(assistantBubble).not.toContainText(characterName);
    await expect(page.getByTestId("message-avatar")).toHaveCount(0);
  } finally {
    await persistSettings(originalSettings.showMessageAvatars);
    await request.delete(`/api/chats/${chat.id}`);
    await request.delete(`/api/characters/${character.id}`);
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
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
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
    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);
    await page.locator("button[aria-expanded]").click();
    await page.getByRole("button", { name: /自定义配置|Custom Config/ }).click();

    const customConfigDialog = page.getByRole("dialog");
    const configInputs = customConfigDialog.locator("textarea");
    await configInputs.nth(0).fill(customConfig.prefix);
    await configInputs.nth(1).fill(customConfig.prompt);
    await configInputs.nth(2).fill(customConfig.suffix);
    await customConfigDialog.getByRole("button", { name: /保存|Save/ }).click();

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
    await page.getByRole("button", { name: /自定义配置|Custom Config/ }).click();
    await expect(customConfigDialog.locator("textarea").nth(0)).toHaveValue(customConfig.prefix);
    await expect(customConfigDialog.locator("textarea").nth(1)).toHaveValue(customConfig.prompt);
    await expect(customConfigDialog.locator("textarea").nth(2)).toHaveValue(customConfig.suffix);
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
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
          content: `Paging message ${index}`
        }
      });
      expect(messageResponse.ok()).toBeTruthy();
    }

    await page.goto("/");
    await openChatHistoryAndSelect(page, chatTitle);

    const viewport = page.getByTestId("chat-message-viewport");
    await expect(viewport).toBeVisible();
    await expect(page.getByTestId("chat-message-pagination")).toBeVisible();
    await expect(page.getByText("Paging message 89")).toBeVisible();
    await expect(page.getByText("Paging message 0")).toHaveCount(0);
    const metrics = await viewport.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.getByTestId("chat-page-prev").click();

    await expect(page.getByText("Paging message 30")).toBeVisible();
    await expect(page.getByText("Paging message 89")).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${chat.id}`);
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
      await request.delete(`/api/chats/${chatId}`);
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
