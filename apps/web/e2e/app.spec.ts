import { expect, test } from "@playwright/test";

type E2ECharacter = {
  id: string;
  name: string;
};

type E2EChat = {
  id: string;
  title: string;
};

type E2EModelPreset = {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  model: string;
};

type SettingsPutPayload = {
  activeProvider?: string;
  apiBaseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  language?: string;
  models?: E2EModelPreset[];
  apiKey?: string;
};

type ApiDataResponse<T> = {
  data?: T;
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
          models: [],
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

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /模型设置|Model Settings/ })).toBeVisible();
});

test("character management can create a character and shows save feedback", async ({
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
  const name = `E2E角色-${testInfo.project.name}-${Date.now()}`;

  try {
    await page.getByLabel(/名称|Name/).fill(name);
    await page.getByRole("textbox", { name: /^(前置词|Prefix)/ }).fill("你会保持清晰、稳定的角色边界。");
    await page.getByRole("textbox", { name: /^(提示词|Prompt)/ }).fill("这是一张用于端到端测试的原创角色卡。");
    await page.getByRole("textbox", { name: /^(后置词|Suffix)/ }).fill("回复时保持简洁。");
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

test("mobile chat layout exposes panel switching", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: /聊天列表|Chats/ })).toBeVisible();
  await page.getByRole("button", { name: /创建聊天|Create Chat/ }).first().click();
  await expect(page.getByRole("heading", { name: /创建聊天|Create Chat/ })).toBeVisible();

  await page.getByRole("button", { name: /消息流|Message Stream/ }).click();
  await expect(
    page
      .getByPlaceholder(/输入用户消息|Write a user message/)
      .or(page.getByText(/选择或创建聊天|Select or create a chat|这段聊天还没有消息|This chat has no messages/))
      .first()
  ).toBeVisible();
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
        models: originalSettings.models ?? [],
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
      mode: "single",
      characterIds: [character.id]
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
    await page.getByRole("button", { name: chatTitle }).click();

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

test("chat model switch preserves stored key and runtime settings when preset has no dedicated key", async ({
  page,
  request
}) => {
  const suffix = Date.now();
  const characterName = `Switch Character ${suffix}`;
  const chatTitle = `Switch Chat ${suffix}`;
  const now = new Date().toISOString();
  const models: E2EModelPreset[] = [
    {
      id: "preset-active",
      label: "Active Model",
      provider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini"
    },
    {
      id: "preset-target",
      label: "Target Model",
      provider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o"
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
            activeProvider: models[0].provider,
            apiBaseUrl: models[0].apiBaseUrl,
            model: models[0].model,
            temperature: 1.1,
            maxTokens: 1200,
            topP: 0.9,
            language: "en",
            models,
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
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            id: "settings-switch-e2e",
            activeProvider: latestSettingsPut.value?.activeProvider,
            apiBaseUrl: latestSettingsPut.value?.apiBaseUrl,
            model: latestSettingsPut.value?.model,
            temperature: latestSettingsPut.value?.temperature,
            maxTokens: latestSettingsPut.value?.maxTokens,
            topP: latestSettingsPut.value?.topP,
            language: latestSettingsPut.value?.language,
            models: latestSettingsPut.value?.models,
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
      mode: "single",
      characterIds: [character.id]
    }
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = ((await chatResponse.json()) as ApiDataResponse<E2EChat>).data;
  if (!chat) {
    throw new Error("Chat creation did not return data");
  }

  try {
    await page.goto("/");
    await page.getByRole("button", { name: chatTitle }).click();
    await page.getByRole("button", { name: /记忆|Memory/ }).click();
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
      mode: "single",
      characterIds: [character.id]
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
    await page.getByRole("button", { name: chatTitle }).click();

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

test("lore entries show persistent trigger without trigger mode badge", async ({ page, request }) => {
  const name = `E2E Lorebook ${Date.now()}`;
  const content = "Persistent trigger entry created by Playwright.";
  const bookResponse = await request.post("/api/lorebooks", {
    data: {
      name,
      description: "Temporary lorebook for persistent trigger UI coverage"
    }
  });
  expect(bookResponse.ok()).toBeTruthy();
  const book = (await bookResponse.json()).data;

  const entryResponse = await request.post(`/api/lorebooks/${book.id}/entries`, {
    data: {
      keys: ["playwright-persistent"],
      content,
      priority: 0,
      triggerMode: "both",
      alwaysActive: true,
      enabled: true
    }
  });
  expect(entryResponse.ok()).toBeTruthy();

  try {
    await page.goto("/lore");
    await page.getByRole("button", { name: new RegExp(name) }).click();

    await expect(page.getByText(/持续触发\s*1|Always Active\s*1/)).toBeVisible();
    const entryCard = page.locator("article").filter({ hasText: content });
    await expect(entryCard).toContainText(/持续触发|Always Active/);
    await expect(entryCard).not.toContainText(/共同触发|Shared Trigger/);
  } finally {
    await request.delete(`/api/lorebooks/${book.id}`);
  }
});
