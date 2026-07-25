# Star Companion / 星伴

LLM front end

Local-first AI character chat workspace with web, desktop, and Android builds.

Current scope:

- Single-user, single-character chat with backend-proxied model requests.
- A unified New Chat flow is available from the desktop sidebar, mobile header, and empty chat workspace, with paginated character search ordered by recent use plus an inline quick-create path that can create a minimal character and enter chat without leaving the dialog.
- Character cards with local or remote cover images, embedded prompt segments, HTML/CSS presentation, quick replies, embedded lore entries, local favorites, multi-mode library sorting, batch tag organization, safe duplication that preserves private-card encryption, and unsaved-change protection for long-form editing.
- Chat-scoped long-term memory with automatic maintenance, hybrid semantic-vector and keyword retrieval, visible index status, reusable local persona presets, user profile summaries, local backup import/export, and manual LAN sync.
- In-chat AI Agent drafts for scene summaries, next-step suggestions, reply drafts, and memory/lore candidates. The Agent is read-only in v1 and does not modify local data automatically.
- Per-module model preferences for chat, AI Agent, memory maintenance, memory embeddings, user profile summaries, voice transcription, text-to-speech, and image generation, with capability-filtered model choices and server-side validation.
- Voice input/transcription, per-reply narration, configurable speech voice and playback speed, optional automatic playback for new replies, and OpenAI-compatible image generation through backend-proxied media endpoints, with an image preview before insertion into a chat draft.
- Chat branching from any user or assistant message, creating a new chat that preserves the conversation up to that point without copying long-term memories. The Story paths navigator shows ancestry and direct child branches, and returning to the source highlights the original split message.
- Save a checkpoint at any message to keep a story snapshot without leaving the active chat; checkpoints remain linked to their source and appear alongside branches in Story paths.
- Chat-scoped message search with result jump across long paginated conversations.
- The sidebar and mobile drawer expose six pinned/recent active chats for one-step switching. Full History rows show the latest user/assistant message preview, message count, and recent activity time; global search opens directly from the mobile header or `Ctrl/Cmd+K` on desktop, can switch between chat titles and message content across every chat, then opens the matching conversation at the exact turn.
- Pin frequently used chats so they stay above newer history entries; pin state is included in backups and LAN sync.
- Archive completed chats to remove them from active history without deleting messages or memories, then restore them individually or in batches from History management mode.
- Move unwanted chats to Trash without losing messages or long-term memories, restore them later, or permanently delete them through a separate confirmation. Trash state is retained in backups and LAN sync.
- Queue messages while a reply is generating, then edit, delete, or send them immediately; queued items are combined and sent automatically after the current response and remain session-only.
- Persistent message bookmarks with a chat-local list that jumps to saved turns across paginated conversations; bookmarks never affect model context.
- Export or import an individual structured chat archive with its bound character, messages, and long-term memories; imports always create a separate chat.
- Preview, copy, or download readable chat transcripts as Markdown or plain text, with optional per-message timestamps; structured JSON archives remain available for complete restoration.
- Restore the last selected chat after a refresh or app restart, while clearing stale local selections if the chat no longer exists.
- Message-level context control: retain a message in the transcript while excluding it from future model and AI Agent context.
- Optional per-message timestamps help track long-running chat chronology without changing the default chat layout.
- Dialogs, destructive confirmations, and the mobile navigation drawer keep keyboard focus inside the active surface, close with Escape, and restore focus to the originating control.
- Chat readiness checks deep-link missing provider, API key, and model items into a focused three-step setup guide, with save/test actions kept available after long provider forms; the real generation test catches connection issues before chat generation fails.
- Character opening generation for empty chats, stored as a normal assistant message that can be edited or regenerated.
- Continue the latest assistant reply in place when a response is truncated or the scene needs to carry on; continuation keeps the current message and variant instead of creating a fake user turn.
- Generate a concise AI title draft from included chat messages, then review and save it explicitly; title suggestions never overwrite chat history automatically.
- Default `New Chat` conversations receive one automatic AI title after the first user/assistant exchange; manually named chats are never overwritten.

# License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
