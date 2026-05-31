# Local Roleplay Platform

本地优先的 AI 角色聊天平台 MVP。项目采用原创实现，不复制 TavernAI / SillyTavern 的源码、UI、素材、默认角色或品牌命名。

## 当前状态

项目已完成 MVP 主体，并补充了多轮打磨功能：

- React + TypeScript + Vite 前端，Tailwind CSS 暗色 RPG 面板风格。
- Express + TypeScript 后端，所有模型请求通过后端代理。
- SQLite + Prisma 本地数据库，默认数据保存在本机。
- WebSocket 流式输出，支持停止生成、重新生成和角色回复状态。
- 角色卡使用 `前置词 / 提示词 / 后置词` 三段结构，并保留头像。
- 聊天支持单人私聊和多角色群聊。
- 消息支持复制、编辑、删除、重新生成和 variants 切换。
- 世界书支持关键词触发、用户触发、AI 触发、共同触发、持续触发。
- 聊天可绑定指定世界书，未绑定时不会自动注入世界书。
- 设置页支持主流供应商模板、多模型预设、任意模型 ID 批量导入、API Key 本地加密、数据备份导入导出。
- 聊天设置中支持根据用户消息自动整理“用户信息摘要”。
- 已有 API smoke test 和 Playwright E2E 测试。

## 目录结构

```text
apps/
  web/       React 前端
  server/    Express 后端与 Prisma
packages/
  shared/    前后端共享类型
scripts/
  smoke-api.mjs
docs/
  AVAILABLE_SKILLS.md
```

## 环境要求

需要 Node.js 20+。当前项目使用 npm workspaces。

后端环境变量示例在 `apps/server/.env.example`：

```powershell
Copy-Item apps/server/.env.example apps/server/.env
```

关键环境变量：

```text
DATABASE_URL="file:./dev.db"
SERVER_PORT=4000
CORS_ORIGIN="http://localhost:5173"
API_KEY_ENCRYPTION_SECRET="replace-with-a-long-local-random-secret"
```

`API_KEY_ENCRYPTION_SECRET` 用于加密本地 SQLite 中保存的 API Key。更换该值后，旧的已加密 API Key 需要重新填写。

## 安装与启动

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

默认地址：

- Web: http://localhost:5173
- Server: http://localhost:4000
- Health check: http://localhost:4000/api/health

前端页面：

- Chat: http://localhost:5173/
- Characters: http://localhost:5173/characters
- Lorebooks: http://localhost:5173/lore
- Settings: http://localhost:5173/settings

旧的 hash 地址如 `#/characters` 仍兼容，但新开发和文档以真实路由为准。

## 常用脚本

```bash
npm run dev
npm run build
npm run lint
npm run test:server
npm run test:api
npm run test:e2e
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
```

说明：

- `npm run build` 会依次构建 shared、server、web。
- `npm run lint` 会检查 shared、server、web。
- `npm run test:server` 会运行后端单元/集成测试，覆盖 prompt 组装、世界书注入和用户信息摘要 helper。
- `npm run test:api` 会运行非 LLM 的 API 冒烟测试。
- `npm run test:e2e` 会运行 Playwright 前端测试。

首次运行 Playwright 前可安装浏览器：

```bash
npm exec --prefix apps/web playwright install chromium
```

## 数据库

SQLite 数据库默认路径：

```text
apps/server/prisma/dev.db
```

本地协作建议使用 migration：

```bash
npm run db:migrate
```

部署或 CI 使用：

```bash
npm run db:migrate:deploy
```

`npm run db:push` 保留给快速原型同步使用。

## 核心数据模型

- `UserSettings`: 模型供应商、API Base URL、加密 API Key、模型 ID、流式输出开关、模型参数、界面语言、模型预设、用户信息摘要。未识别供应商默认按 OpenAI-compatible 调用，`anthropic` 和 `google-gemini` 使用原生适配。
- `Character`: 名称、头像、前置词、提示词、后置词。
- `Chat`: 标题、私聊/群聊模式、绑定角色、绑定世界书、记忆轮数。
- `Message`: 角色、内容、variants、当前 variant、token 使用量、命中的世界书。
- `Lorebook`: 世界书名称与描述。
- `LoreEntry`: 关键词、内容、优先级、触发方式、持续触发、启用状态。

## 聊天生成流程

用户发送消息后，后端会组装 prompt：

1. 全局系统约束。
2. 当前用户信息摘要，如果已启用并存在内容。
3. 当前角色的前置词、提示词、后置词。
4. 当前聊天绑定世界书中命中的条目。
5. 最近 N 轮聊天记录。
6. 当前用户消息。

所有 LLM 请求都通过后端代理，前端不会直接持有或调用 API Key。

模型代理默认兼容 OpenAI Chat Completions 格式；Anthropic Claude 会转换为 Messages API，Google Gemini 会转换为 `generateContent` / `streamGenerateContent`。设置页可以从已保存的供应商配置拉取模型列表，也可以粘贴任意模型 ID 批量生成预设。


## 世界书规则

世界书条目支持四类控制：

- 用户触发：只匹配最近用户消息。
- AI 触发：只匹配最近 AI 消息。
- 共同触发：同时匹配用户和 AI 上下文。
- 持续触发：不需要关键词命中，只要条目启用且聊天绑定了对应世界书，就会注入。

持续触发条目不会计入用户触发、AI 触发、共同触发的统计。

## 用户信息自动总结

聊天设置中可以启用“自动总结”。生成完成后，后端会把最近用户消息交给当前配置的模型，整理为简短的本地用户信息摘要，并保存在 SQLite。

注意：

- 摘要请求会使用当前模型供应商配置，因此用户消息会发送给该模型服务。
- 摘要只应记录稳定偏好、称呼、互动习惯、明确边界等信息。
- 系统提示会要求不要记录 API Key、凭证、地址、无依据推断或一次性请求。
- 用户可以在聊天设置中关闭自动总结或清空摘要。

## API Key 安全

API Key 只通过设置页写入本地 SQLite。后端保存前会使用 `API_KEY_ENCRYPTION_SECRET` 做 AES-256-GCM 加密；旧明文 Key 仍可兼容读取，下一次保存会转为密文。

设置接口不会返回 API Key 明文，完整备份导出也不会包含 API Key。不要把 `.env`、真实 Key 或本地数据库提交到远程仓库。

## 导入导出

设置页支持完整备份：

- 导出包含 settings 参数、characters、chats、messages、lorebooks、lore entries。
- 导出不包含 API Key。
- 导入支持 `merge` 合并和 `replace` 替换。
- `replace` 会清空角色、聊天、消息和世界书，但保留本地 API Key。
- 导入请求通过 Zod 校验，避免破坏数据库结构。

## 基础 API 示例

健康检查：

```bash
curl http://localhost:4000/api/health
```

创建角色：

```bash
curl -X POST http://localhost:4000/api/characters \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"原创旅人\",\"avatar\":\"\",\"prefix\":\"你正在扮演原创旅人。\",\"prompt\":\"一个谨慎、好奇、擅长记录线索的旅人。\",\"suffix\":\"保持第一人称角色口吻，回复简洁。\"}"
```

创建世界书条目：

```bash
curl -X POST http://localhost:4000/api/lorebooks/替换为世界书ID/entries \
  -H "Content-Type: application/json" \
  -d "{\"keys\":[\"王都\"],\"content\":\"王都是大陆北方的贸易中心。\",\"priority\":10,\"triggerMode\":\"both\",\"alwaysActive\":false,\"enabled\":true}"
```

更新用户信息摘要：

```bash
curl -X PUT http://localhost:4000/api/settings/user-profile \
  -H "Content-Type: application/json" \
  -d "{\"userProfileSummary\":\"用户偏好简洁回答。\",\"autoSummarizeUser\":false}"
```

导出完整备份：

```bash
curl http://localhost:4000/api/backups/export
```

导入完整备份：

```bash
curl -X POST http://localhost:4000/api/backups/import \
  -H "Content-Type: application/json" \
  -d "{\"schemaVersion\":1,\"mode\":\"merge\",\"characters\":[],\"chats\":[],\"messages\":[],\"lorebooks\":[]}"
```

## 验证状态

最近一次检查：

- `npm run build`: 通过
- `npm run lint`: 通过
- `npm run test:server`: 通过
- `npm run test:api`: 通过
- `npm run test:e2e`: 通过
- `npm run db:migrate:deploy`: 无待执行迁移

## 后续建议

优先级较高的补充项：

- 给消息重新生成 variants 增加 E2E 覆盖。
- 给备份导入增加冲突预览。
- 增加生产部署路由 fallback 说明和配置。
- 增加更完整的可访问性检查。
