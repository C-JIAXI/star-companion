const API = "http://localhost:4000";

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  return data.data;
}

async function main() {
  const character = await api("/api/characters", {
    method: "POST",
    body: JSON.stringify({
      name: "分页测试角色",
      description: "用于测试聊天分页功能的角色",
      prompt: "你是一个测试角色，专门用于验证分页功能。",
      openingHtml:
        '<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}.container{max-width:600px;padding:2rem}h1{font-size:2.5rem;background:linear-gradient(135deg,#79c0ff,#a371f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}p{color:#8b949e;font-size:1.1rem;line-height:1.6}.badge{display:inline-block;margin-top:1.5rem;padding:.5rem 1rem;border-radius:999px;background:rgba(163,113,247,.15);color:#a371f7;font-size:.875rem;border:1px solid rgba(163,113,247,.3)}</style></head><body><div class="container"><h1>分页测试</h1><p>这是一个开场 HTML 的预览页面。当你发送第一条消息后，这个 iframe 会自动消失。</p><div class="badge">🎬 开场动画</div></div></body></html>'
    })
  });
  console.log(`✅ Created character: ${character.id}`);

  const chat = await api("/api/chats", {
    method: "POST",
    body: JSON.stringify({ title: "分页测试对话", characterId: character.id })
  });
  console.log(`✅ Created chat: ${chat.id}`);

  const totalMessages = 35;
  for (let i = 1; i <= totalMessages; i++) {
    const role = i % 2 === 1 ? "user" : "assistant";
    const content =
      role === "user"
        ? `这是第 ${i} 条用户消息。请确认你收到了这条消息。`
        : `好的，我已收到你的第 ${i} 条消息。这是第 ${i} 条助手回复，用于测试分页功能。当消息总数超过 30 条时，聊天界面会自动启用分页。当前是第 ${i} 条消息。`;
    const characterId = role === "assistant" ? character.id : null;
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        chatId: chat.id,
        role,
        characterId,
        content
      })
    });
    process.stdout.write(`\r  Message ${i}/${totalMessages}`);
  }
  console.log(`\n✅ Created ${totalMessages} messages`);
  console.log(`\n🎉 Done! Open http://localhost:5173 and start chatting with "${character.name}" to see pagination.`);
}

main().catch((error) => {
  console.error("❌ Failed:", error.message);
  process.exit(1);
});
