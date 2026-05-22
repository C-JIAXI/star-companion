const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const created = {
  characterId: null,
  chatId: null,
  messageId: null,
  lorebookId: null
};

let originalUserProfile = null;

const fail = (message) => {
  throw new Error(message);
};

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok || payload?.ok === false) {
    fail(`${options.method ?? "GET"} ${path} failed: ${response.status} ${payload?.error ?? text}`);
  }

  return payload?.data ?? payload;
};

const cleanup = async () => {
  if (originalUserProfile) {
    await request("/api/settings/user-profile", {
      method: "PUT",
      body: originalUserProfile
    }).catch(() => {});
  }

  if (created.messageId) {
    await request(`/api/messages/${created.messageId}`, { method: "DELETE" }).catch(() => {});
  }

  if (created.chatId) {
    await request(`/api/chats/${created.chatId}`, { method: "DELETE" }).catch(() => {});
  }

  if (created.lorebookId) {
    await request(`/api/lorebooks/${created.lorebookId}`, { method: "DELETE" }).catch(() => {});
  }

  if (created.characterId) {
    await request(`/api/characters/${created.characterId}`, { method: "DELETE" }).catch(() => {});
  }
};

try {
  const health = await request("/api/health");
  if (health.ok !== true || health.database !== "connected") {
    fail("Health check did not return ok");
  }

  const settings = await request("/api/settings");
  originalUserProfile = {
    userProfileSummary: settings.userProfileSummary ?? "",
    autoSummarizeUser: settings.autoSummarizeUser ?? true
  };

  const profileSettings = await request("/api/settings/user-profile", {
    method: "PUT",
    body: {
      userProfileSummary: "Smoke test prefers concise local validation.",
      autoSummarizeUser: false
    }
  });
  if (
    profileSettings.userProfileSummary !== "Smoke test prefers concise local validation." ||
    profileSettings.autoSummarizeUser !== false
  ) {
    fail("User profile settings did not persist");
  }

  const character = await request("/api/characters", {
    method: "POST",
    body: {
      name: "Smoke Test Character",
      avatar: "",
      prefix: "Stay in character for the API smoke test.",
      prompt: "A concise original test persona.",
      suffix: "Reply plainly."
    }
  });
  created.characterId = character.id;

  const updatedCharacter = await request(`/api/characters/${character.id}`, {
    method: "PUT",
    body: { suffix: "Reply plainly and briefly." }
  });
  if (updatedCharacter.suffix !== "Reply plainly and briefly.") {
    fail("Character update did not persist suffix");
  }

  const lorebook = await request("/api/lorebooks", {
    method: "POST",
    body: {
      name: "Smoke Test Lorebook",
      description: "Temporary lorebook created by API smoke test"
    }
  });
  created.lorebookId = lorebook.id;

  const entry = await request(`/api/lorebooks/${lorebook.id}/entries`, {
    method: "POST",
    body: {
      keys: ["smoke"],
      content: "Smoke tests should leave no lasting data.",
      priority: 1,
      triggerMode: "assistant",
      alwaysActive: false,
      enabled: true
    }
  });

  const updatedEntry = await request(`/api/lorebooks/entries/${entry.id}`, {
    method: "PUT",
    body: { priority: 2, triggerMode: "both", alwaysActive: true }
  });
  if (updatedEntry.priority !== 2 || updatedEntry.triggerMode !== "both" || updatedEntry.alwaysActive !== true) {
    fail("Lore entry update did not persist trigger fields");
  }

  const chat = await request("/api/chats", {
    method: "POST",
    body: {
      title: "Smoke Test Chat",
      mode: "single",
      characterIds: [character.id],
      lorebookIds: [lorebook.id],
      memoryTurns: 3
    }
  });
  created.chatId = chat.id;
  if (!chat.lorebookIds.includes(lorebook.id)) {
    fail("Chat did not persist lorebook binding");
  }

  const message = await request("/api/messages", {
    method: "POST",
    body: {
      chatId: chat.id,
      role: "user",
      content: "Hello from smoke test",
      variants: ["Hello from smoke test"],
      activeVariantIndex: 0
    }
  });
  created.messageId = message.id;

  const updatedMessage = await request(`/api/messages/${message.id}`, {
    method: "PUT",
    body: { content: "Edited smoke test message" }
  });
  if (updatedMessage.content !== "Edited smoke test message") {
    fail("Message update did not persist content");
  }

  const backup = await request("/api/backups/export");
  if (backup.schemaVersion !== 1 || !Array.isArray(backup.characters)) {
    fail("Backup export did not return the expected schema");
  }
  const exportedChat = backup.chats.find((item) => item.id === chat.id);
  const exportedEntry = backup.lorebooks
    .flatMap((item) => item.entries ?? [])
    .find((item) => item.id === entry.id);
  if (!exportedChat?.lorebookIds?.includes(lorebook.id)) {
    fail("Backup export did not include chat lorebook bindings");
  }
  if (exportedEntry?.alwaysActive !== true || exportedEntry?.triggerMode !== "both") {
    fail("Backup export did not include lore trigger fields");
  }

  await cleanup();
  console.log("API smoke test passed.");
} catch (error) {
  await cleanup();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
