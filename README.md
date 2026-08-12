# Star Companion / 星伴

LLM front end

Local-first AI character chat workspace with web, desktop, and Android builds.

Current scope:

- Single-user, single-character chat with backend-proxied model requests.
- A unified New Chat flow is available from the desktop sidebar, mobile header, and empty chat workspace, with paginated character search ordered by recent use plus an inline quick-create path that can create a minimal character and enter chat without leaving the dialog.
- Character cards with local or remote cover images, embedded prompt segments, HTML/CSS presentation, quick replies, embedded lore entries, local favorites, multi-mode library sorting, batch tag organization, safe duplication that preserves private-card encryption, and unsaved-change protection for long-form editing.
- Chat-scoped long-term memory with automatic maintenance, hybrid semantic-vector and keyword retrieval, source- and dimension-validated index status, keyword fallback while an index is stale or unavailable, and a dedicated index rebuild action with ready/stale/failed progress. Every memory content/status change has immutable, source-ID-only history; automatic maintenance is grouped into bounded operations with conflict-aware preflight and transactional undo. Memory and chat-profile revisions can be diffed, source-jumped across pagination, restored as new revisions, tombstoned, and explicitly purged. Reusable local persona presets, user profile summaries, preflighted local backup import/export, bounded recovery points, and conflict-safe manual LAN sync are also included. A persona preset can retain the visible user name and an optional local avatar for that chat; a stable placeholder is generated when no avatar is uploaded, while model-facing identity remains explicit in the preset prompt fields.
- In-chat AI Agent for scene summaries, next-step suggestions, reply drafts, memory/lore candidates, continuity checks, and character-consistency checks. Reply drafts can be inserted individually; memory and embedded-lore candidates require an explicit user confirmation before they are written.
- Per-module model preferences for chat, AI Agent, memory maintenance, memory embeddings, user profile summaries, voice transcription, text-to-speech, and image generation, with capability-filtered model choices and server-side validation.
- Provider-neutral safe model errors, request IDs, explicit cancellation, reconnectable request status, bounded transient retries, and opt-in per-module fallback chains. Streaming never retries or switches models after output begins; interrupted partial replies remain visible and are marked incomplete instead of being duplicated or discarded.
- A local per-attempt usage ledger and price snapshots for every real model call, including retries and fallbacks. Settings shows token/cost summaries by module, provider, model, and chat, plus soft warnings and backend-enforced daily/monthly hard budgets. Cost values are local USD estimates, unknown pricing is never treated as free, and a lightweight session privacy lock unmounts the workspace, blocks protected HTTP APIs, and closes/rejects WebSockets while active.
- Each model can store an optional context-window limit. Chat settings estimate the next prompt plus reserved response tokens, warn near the configured limit, and never silently trim story history.
- Generated assistant replies retain a token-only Prompt composition breakdown. The prompt debugger itemizes character instructions, user configuration, profile summary, matched embedded lore, recalled memory, included chat history, and turn-specific generation instructions without duplicating the full prompt text or making another model request.
- Voice input/transcription, per-reply narration, configurable speech voice and playback speed, optional automatic playback for new replies, and OpenAI-compatible image generation through backend-proxied media endpoints, with an image preview before insertion into a chat draft. Unconfigured media tools remain actionable and deep-link to the exact compatible-model setting instead of becoming dead controls.
- Chat branching from any user or assistant message, creating a new chat that preserves the conversation up to that point without copying long-term memories. The Story paths navigator shows ancestry and direct child branches, and returning to the source highlights the original split message.
- Save a checkpoint at any message to keep a story snapshot without leaving the active chat; checkpoints remain linked to their source and appear alongside branches in Story paths.
- Chat-scoped message search with result jump across long paginated conversations.
- The sidebar and mobile drawer expose six pinned/recent active chats for one-step switching. Full History rows show the latest user/assistant message preview, message count, and recent activity time; global search opens directly from the mobile header or `Ctrl/Cmd+K` on desktop, can switch between chat titles and message content across every chat, then opens the matching conversation at the exact turn.
- Pin frequently used chats so they stay above newer history entries; pin state is included in backups and LAN sync.
- Archive completed chats to remove them from active history without deleting messages or memories, then restore them individually or in batches from History management mode.
- Organize long-running story lines with lightweight chat folders. Filter any History scope by folder, create or clear a folder from a chat action menu, rename or clear an entire folder from its filter control, and keep folder metadata in backups, LAN sync, branches, and JSON chat archives.
- Move unwanted chats to Trash without losing messages or long-term memories, restore them later, or permanently delete them through a separate confirmation. Trash state is retained in backups and LAN sync.
- Queue messages while a reply is generating, then edit, delete, or send them immediately; queued items are combined and sent automatically after the current response and remain session-only.
- Persistent message bookmarks with a chat-local list that jumps to saved turns across paginated conversations; bookmarks never affect model context.
- Export or import an individual structured chat archive with its bound character, messages, current long-term memories, immutable memory/operation history, and chat-profile history; imports always create a separate chat.
- Preview, copy, or download readable chat transcripts as Markdown or plain text, with optional per-message timestamps; structured JSON archives remain available for complete restoration.
- Restore the last selected chat after a refresh or app restart, while clearing stale local selections if the chat no longer exists.
- Message-level context control: retain a message in the transcript while excluding it from future model and AI Agent context. Long timelines mark the exact rolling-window boundary for the next reply and label manual exclusions separately from older messages that merely fall outside the window.
- Guided regeneration lets users revise an assistant reply with one-time feedback while preserving the current response as a switchable variant; the guidance is never stored as chat history, character data, or memory.
- The chat composer reports local-service connection state, retries dropped WebSocket connections, offers an immediate reconnect action, restores drafts that were not acknowledged, and refreshes the active conversation after recovery. Closing one browser tab only stops generation started by that tab.
- Optional per-message timestamps help track long-running chat chronology without changing the default chat layout.
- Dialogs, destructive confirmations, and the mobile navigation drawer keep keyboard focus inside the active surface, close with Escape, and restore focus to the originating control. Message deletion previews the target and states whether one reply or the selected user turn plus every following message will be removed; timeline deletion is committed atomically by the server. Resending a historical user turn previews the following path it will replace, preserves the selected turn, and only switches the UI after the atomic server-side replacement starts. The confirmation can instead create a branch with the full original path and resend in that branch. Both operations disable enabled long-term memories sourced from removed messages, preventing a retired story path from returning through retrieval.
- Chat readiness checks deep-link missing provider, API key, and model items into a focused three-step setup guide, with save/test actions kept available after long provider forms; the real generation test catches connection issues before chat generation fails.
- Character opening generation for empty chats, stored as a normal assistant message that can be edited or regenerated.
- Continue the latest assistant reply in place when a response is truncated or the scene needs to carry on; continuation keeps the current message and variant instead of creating a fake user turn.
- Generate a concise AI title draft from included chat messages, then review and save it explicitly; title suggestions never overwrite chat history automatically.
- Default `New Chat` conversations receive one automatic AI title after the first user/assistant exchange; manually named chats are never overwritten.

## Local Development

```bash
npm install
npm run db:generate
npm run dev
```

`npm run dev` creates the default local SQLite database from the checked-in SQL migrations only when it does not already exist. It never overwrites an existing database. Open `http://localhost:5173` after the server is ready.

For a manual first-time database initialization, run `npm run db:init`. This avoids relying on Prisma's SQLite migration engine in Windows development environments.

## Data protection and recoverable sync

Backup import and LAN pull/push use a two-phase preview/execute contract. Preflight validates schemaVersion 1, ISO dates, duplicate IDs, and character–chat–message–memory references without writing data. The preview reports additions, updates, skips, conflicts, invalid records, and replace-mode deletions. Merge never overwrites a different record with the same ID until every conflict has an explicit keep-existing, use-incoming, or skip choice. Replace remains a separately confirmed danger operation.

Before an import overwrites or deletes existing data, the backend stores a local recovery point containing characters, chats, messages, long-term memories, and non-key settings. Recovery points are transactionally restorable, capped at 10, and pruned after 30 days. A restore creates its own pre-restore safety point, and a failed restore leaves the current dataset unchanged. API keys are excluded from backup, recovery-transfer, and LAN-sync payloads; provider keys already stored on a target device are preserved.

Assistant messages keep a compact generation summary with the actual provider/model, token usage, local cost estimate, fallback state, and incomplete state. That summary follows the message through schemaVersion 1 backups, LAN sync, and structured chat archives. The global `ModelRequest`/`ModelUsageAttempt` ledger and active budget reservations remain device-local and are excluded from those payloads. Clearing the local ledger requires confirmation and does not remove messages or change the provider's bill.

## Model reliability and local cost guardrails

OpenAI-compatible, Anthropic, and Gemini failures are normalized into a safe, provider-neutral error contract. Stored and user-facing diagnostics contain lifecycle IDs, safe categories, model identity, and retry hints, but never provider response bodies, API keys, chat text, prompts, persona text, or profile summaries. Retrying is disabled by default and only applies to transient connection, timeout, rate-limit, and provider-availability failures. A model candidate permits at most two retries (three actual calls), with `Retry-After` honored when available. Authentication, invalid request, missing model, context overflow, safety, and quota failures are not retried. Once streaming emits output, the request is never automatically retried or switched; partial output is persisted as incomplete.

Fallback chains are explicit, serial, capability-checked, and limited to three candidates per AI module. Chat fallback additionally requires user consent because changing models can change character performance. Every attempt reserves budget before contacting a provider and atomically settles the reservation afterward. Stale queued or streaming requests are marked interrupted and release reservations on backend restart.

Pricing is user-supplied per model as integer micro-USD rates per million input/output tokens. The ledger snapshots the prices used for each attempt, so later price edits do not rewrite history. Provider-reported token counts are preferred; otherwise a local estimate is labeled as estimated. Media or special token classes that cannot be priced reliably remain unknown. Soft budgets warn, while hard budgets are enforced locally before every retry or fallback and support an explicit one-request override. These controls cannot account for requests made outside Star Companion and are not a substitute for provider-side billing limits.

## Versioned installation and safe upgrades

The root `package.json` is the application version source. Web/server build metadata and Android `versionName` are derived from it; Android `versionCode` uses `major * 1,000,000 + minor * 1,000 + patch`, so a semantic-version increase cannot silently roll the store version backward. `npm run version:check` rejects generated metadata or Android configuration that drifts from this source. `/api/app/info` and Settings → About & Updates report the application version, migration version/checksum, platform, build type, optional commit, and latest migration result.

Windows remains an NSIS installation. Packaged Windows builds use `electron-updater` with electron-builder publish metadata, manual check/download/install controls, `autoDownload=false`, and `autoInstallOnAppQuit=false`. Development and unpackaged builds cannot contact the update source. The default source is this repository's GitHub Releases provider; set the public `STAR_COMPANION_UPDATE_URL` at build time to produce metadata for a generic HTTPS update host. Never put a release token in source or builder configuration.

Unsigned local artifacts remain available:

```bash
npm run desktop:pack
npm run desktop:build
npm run mobile:build:android
```

Formal Windows release builds require a trusted Authenticode code-signing certificate, commonly a password-protected `.pfx`/`.p12`, through electron-builder's standard `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` variables (or their `CSC_*` equivalents). `WIN_CSC_LINK` may be a protected certificate file path or a certificate value supported by electron-builder. `npm run desktop:release:preflight` and `npm run desktop:release` fail before producing a formal artifact when credentials are absent. Verify the final executable's Authenticode signer and signature status with `Get-AuthenticodeSignature`; do not rely on its filename.

Android release signing uses either the four environment variables below or an untracked `android/signing.properties` with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. No keystore or password belongs in Git.

```text
STAR_COMPANION_ANDROID_KEYSTORE_PATH
STAR_COMPANION_ANDROID_STORE_PASSWORD
STAR_COMPANION_ANDROID_KEY_ALIAS
STAR_COMPANION_ANDROID_KEY_PASSWORD
```

`npm run mobile:release:preflight` fails clearly without all four inputs. `npm run mobile:build:release` produces a signed release APK and store-oriented AAB, then copies versioned artifacts to `dist/android`. Android update UX only opens the HTTPS store/listing URL supplied at build time through `STAR_COMPANION_ANDROID_STORE_URL`; it does not replace APKs silently.

After a credentialed build, verify the APK with Android SDK `apksigner verify --print-certs <apk>` and verify the AAB with `jarsigner -verify -verbose -certs <aab>` before upload.

Before either desktop SQLite or mobile WASM SQLite applies a new schema, it checks database integrity and migration checksums, rejects data created by a newer unsupported app/schema, records prior app/schema versions, and creates a bounded full-database safety copy when an existing database needs migration. Migrations run in a transaction and schema state is published only after success. A failure preserves the original database and the `upgrade-recovery` copy instead of starting on a half-migrated schema.

Release automation is split from ordinary CI. Pull requests never receive signing secrets. The release workflow only builds signed artifacts from an explicit tag/manual dispatch and does not create or publish a GitHub Release. Useful local gates are:

```bash
npm run test:release-tools
npm run release:check
npm run release:verify:windows
npm run release:verify:android
npm run release:checksums
```

Release configuration follows the official [electron-builder auto-update](https://www.electron.build/docs/features/auto-update/), [electron-builder code-signing](https://www.electron.build/docs/features/code-signing/), [Electron update](https://www.electronjs.org/docs/latest/tutorial/updates), and [Android app-signing](https://developer.android.com/studio/publish/app-signing) guidance.

# License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
