你是我的全栈高级工程师。请从零开发一个“本地优先的 AI 角色聊天平台”，功能定位类似 TavernAI / SillyTavern，但必须是原创实现，不复制任何现有项目代码、UI、素材、品牌名或受版权保护内容。

项目目标：
开发一个可在本地运行，也可部署到服务器的 AI 角色扮演聊天系统。用户可以创建角色卡、导入角色、管理聊天记录、配置模型 API、使用世界书、进行多角色群聊，并获得接近“酒馆类 AI 前端”的体验。

技术栈要求：
- 前端：React + TypeScript + Vite
- UI：Tailwind CSS
- 状态管理：Zustand
- 后端：Node.js + Express + TypeScript
- 本地数据库：SQLite + Prisma
- 实时能力：WebSocket，用于流式输出和多角色响应状态
- API 接入：OpenAI-compatible API 为主，后续可扩展 OpenRouter、Claude、Gemini、本地 KoboldCpp、Ollama
- 项目结构清晰，前后端分离，但可以放在同一个 monorepo 中
- 必须提供 README、环境变量示例、启动脚本、数据库初始化脚本

重要约束：
1. 不要复制 SillyTavern / TavernAI 的源码、样式、文件结构、默认角色、默认背景或命名。
2. 只实现相似产品类型和通用功能，所有代码必须原创。
3. API Key 必须只保存在本地配置中，不要上传到远程服务。
4. 所有 LLM 请求必须通过后端代理，前端不能直接暴露 API Key。
5. 数据默认本地存储，用户可导入/导出。
6. UI 要移动端友好，适配手机浏览器。
7. 代码必须可运行，每完成一个阶段都要运行测试或至少运行构建检查。
8. 不要只写伪代码，要创建真实文件和可运行项目。

请先完成 MVP，而不是一次性实现所有功能。

MVP 功能范围：

一、基础框架
- 创建 monorepo：
  - apps/web：React 前端
  - apps/server：Express 后端
  - packages/shared：共享类型
- 配置 TypeScript、ESLint、Prettier
- 配置 pnpm workspace
- 提供统一启动命令：
  - pnpm install
  - pnpm dev
  - pnpm build

二、数据模型
使用 Prisma + SQLite 设计以下模型：
- UserSettings
  - id
  - activeProvider
  - apiBaseUrl
  - apiKeyEncrypted 或 apiKey，本地 MVP 可先明文但代码中标注后续加密
  - model
  - temperature
  - maxTokens
  - topP
  - createdAt
  - updatedAt

- Character
  - id
  - name
  - avatar
  - description
  - personality
  - scenario
  - firstMessage
  - exampleDialog
  - systemPrompt
  - tags
  - createdAt
  - updatedAt

- Chat
  - id
  - title
  - mode: single | group
  - characterIds
  - createdAt
  - updatedAt

- Message
  - id
  - chatId
  - role: user | assistant | system
  - characterId 可为空
  - content
  - variants，用于消息 swipe
  - activeVariantIndex
  - createdAt
  - updatedAt

- Lorebook
  - id
  - name
  - description
  - createdAt
  - updatedAt

- LoreEntry
  - id
  - lorebookId
  - keys
  - content
  - priority
  - enabled
  - createdAt
  - updatedAt

三、前端页面
实现以下页面：
1. 首页 / 聊天页
   - 左侧：聊天列表
   - 中间：消息流
   - 右侧：当前角色信息和生成参数
   - 移动端改为底部导航或抽屉布局
   - 支持新建聊天、选择角色、发送消息

2. 角色管理页
   - 创建角色
   - 编辑角色
   - 删除角色
   - 导入/导出角色 JSON
   - 角色卡字段包括：名称、头像、描述、性格、场景、首条消息、示例对话、系统提示词、标签

3. 世界书页面
   - 创建 lorebook
   - 添加 lore entry
   - 每个 entry 包含关键词、内容、优先级、启用状态
   - 发送消息时根据最近上下文匹配关键词，自动注入相关世界书内容

4. 设置页
   - 配置 API Base URL
   - 配置 API Key
   - 配置模型名称
   - 配置 temperature、maxTokens、topP
   - 测试连接按钮

四、聊天功能
- 用户输入消息后，后端组装 prompt：
  1. 全局系统提示词
  2. 角色 systemPrompt
  3. 角色 personality / scenario
  4. 匹配到的世界书内容
  5. 最近 N 条聊天记录
  6. 当前用户消息
- 调用 OpenAI-compatible Chat Completions API
- 支持流式输出
- 保存 assistant 回复
- 支持停止生成
- 支持重新生成
- 支持编辑、删除、复制消息
- 支持 message variants：
  - 重新生成时不要覆盖原消息，而是添加一个 variant
  - 用户可以左右切换 variant

五、群聊模式
先做简单版本：
- 一个 Chat 可以包含多个 Character
- 用户发送消息后，系统按顺序让角色回复
- 每个角色回复前要注入该角色的人设
- UI 显示不同角色名称和头像
- 后续预留“自动判断谁该回复”的扩展点

六、导入导出
- 导出完整数据为 JSON：
  - settings 不导出 apiKey
  - characters
  - chats
  - messages
  - lorebooks
- 支持导入角色 JSON
- 支持导入备份 JSON
- 导入时做 schema 校验，避免破坏数据库

七、安全与健壮性
- 后端接口做 Zod 校验
- 处理 API 错误、网络错误、模型错误
- 不在日志中打印 API Key
- 前端显示清晰错误提示
- 所有关键操作有确认弹窗
- 数据库操作要有错误处理

八、UI 风格
- 暗色主题为默认
- 风格：沉浸式、卡片化、类似 RPG 聊天面板，但不要抄现有项目
- 支持自定义背景图
- 支持角色头像
- 聊天气泡要清晰区分用户、系统、角色
- 移动端优先考虑易用性
- 不要使用复杂动画，保持流畅

九、开发顺序
请按以下阶段开发，每个阶段完成后提交清晰说明：

阶段 1：项目初始化
- 创建 monorepo
- 前后端基础启动成功
- Prisma + SQLite 配置成功
- README 写明启动方式

阶段 2：数据库和基础 API
- 完成 Prisma schema
- 完成 CRUD API：
  - characters
  - chats
  - messages
  - settings
  - lorebooks
- 使用 Zod 校验
- 提供基础 API 测试方式

阶段 3：前端基础 UI
- 完成路由
- 完成聊天页、角色页、世界书页、设置页
- 前端能调用后端 CRUD API

阶段 4：LLM 接入
- 完成 OpenAI-compatible API 调用
- 支持流式输出
- 支持停止生成
- 支持错误处理
- 设置页可测试连接

阶段 5：角色聊天体验
- 实现 prompt 组装
- 实现角色首条消息
- 实现消息编辑、删除、复制、重新生成
- 实现 variants / swipe

阶段 6：世界书
- 实现关键词匹配
- 实现 lore 注入
- 在 UI 中显示本次命中的 lore entries

阶段 7：群聊
- 实现多角色顺序回复
- UI 显示不同角色身份
- 保存群聊消息

阶段 8：导入导出和打磨
- 实现角色导入导出
- 实现全量备份导入导出
- 优化移动端
- 补充 README
- 修复构建错误

十一、后续扩展功能建议
以下能力作为 MVP 完成后的长期路线，不影响前述阶段 1-8 的交付边界：

高优先级扩展：
- Prompt / 上下文调试面板：显示本次请求实际注入的角色提示词、世界书、用户信息摘要、历史记忆轮数和 token 估算，方便定位角色表现问题。
- 备份导入冲突预览：导入前显示将新增、覆盖、冲突的数据，降低误操作风险。
- 消息 variants / 重新生成 E2E 覆盖：确保重新生成不会覆盖旧回复，切换 variant 后刷新仍能保持正确状态。
- 聊天分支 / 时间线快照：允许用户从任意消息分叉出新的聊天路线，适合尝试不同剧情发展。

产品体验扩展：
- 角色卡预设模板：提供温柔陪伴、严肃旁白、群聊主持、世界观 NPC 等原创模板，帮助用户快速创建角色。
- 世界书批量导入和条目分组：支持按地点、人物、组织、规则、剧情线等维度管理长世界书。
- 群聊发言策略：在顺序回复之外，扩展手动指定、轮流发言、模型判断谁该回复、只让被点名角色回复等策略。
- 用户记忆管理页：集中查看、编辑、删除、锁定用户信息摘要，避免自动总结误差长期累积。

模型与部署扩展：
- 更多模型供应商适配：扩展 OpenRouter、Ollama、KoboldCpp、Claude、Gemini 等供应商，但仍保持所有请求通过后端代理。
- 本地模型连接向导：自动检测 Ollama、LM Studio、KoboldCpp 等本地服务，并生成推荐 API Base URL 和模型名。
- Docker / 生产部署文档：补充容器化、反向代理、数据卷、环境变量和路由 fallback 说明。

质量与安全扩展：
- 可访问性检查：覆盖键盘导航、焦点状态、移动端弹窗滚动、表单 label、颜色对比度等。
- 数据库维护工具：提供备份、恢复、压缩、迁移状态检查、孤儿消息清理等能力。
- 备份文件可选密码加密：导出完整备份时允许用户设置密码，进一步保护本地数据。

十二、完成标准
最终项目必须满足：
- pnpm install 可安装
- pnpm dev 可同时启动前后端
- pnpm build 成功
- 可以创建角色
- 可以配置 API
- 可以与角色聊天
- 可以流式显示回复
- 可以保存聊天记录
- 可以编辑/删除/重新生成消息
- 可以创建世界书并注入上下文
- 可以导入导出角色和备份
- README 清楚说明如何使用

请现在开始执行阶段 1。每完成一个阶段，请：
1. 简要说明完成了什么
2. 列出创建/修改的关键文件
3. 说明如何运行
4. 说明下一阶段要做什么
