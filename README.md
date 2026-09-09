# Star Companion / 星伴

LLM front end

Local-first AI character chat workspace with web, desktop, and Android builds.

Development checkpoint: protected chat-draft persistence is being implemented. Desktop and mobile now expose versioned draft read/save APIs with metadata-only ordered image references, original 24-hour expiry, and lock protection. Composer UI, browser-text migration, and reliable send/queue handoff are not connected yet; do not rely on complete image-draft recovery in the current UI. See [implementation progress](docs/chat-drafts-implementation.md).

Current scope:

- Single-user, single-character chat with backend-proxied model requests.
- A unified New Chat flow is available from the desktop sidebar, mobile header, and empty chat workspace, with paginated character search ordered by recent use plus an inline quick-create path that can create a minimal character and enter chat without leaving the dialog.
- Character Studio with a guided Basic mode and a lossless Advanced mode over the same Character fields. Basic creation covers identity, the existing `prompt` field as the core definition, opening presentation, quick replies, and pre-save review; Advanced keeps `prefix`, `prompt`, `suffix`, scoped HTML/CSS, embedded `loreEntries`, quick replies, and private-card operations.
- Deterministic local character quality checks and character/token budget estimates run without a model. The optional drafting assistant uses the configured Agent module through the normal request ledger, retry/fallback, and budget lifecycle; it sends task-minimal draft fields, returns reviewable structured suggestions, never saves automatically, and supports apply/discard/undo.
- Character cards retain local or remote cover images, local favorites, multi-mode library sorting, batch tag organization, safe duplication that preserves private-card encryption, and unsaved-change protection. Editor mode, wizard position, checks, AI suggestions, and undo snapshots never enter character-card, backup, recovery, or sync protocols.
- Chat-scoped long-term memory with automatic maintenance, hybrid semantic-vector and keyword retrieval, source- and dimension-validated index status, keyword fallback while an index is stale or unavailable, and a dedicated index rebuild action with ready/stale/failed progress. Every memory content/status change has immutable, source-ID-only history; automatic maintenance is grouped into bounded operations with conflict-aware preflight and transactional undo. Memory and chat-profile revisions can be diffed, source-jumped across pagination, restored as new revisions, tombstoned, and explicitly purged. Reusable local persona presets, user profile summaries, preflighted local backup import/export, bounded recovery points, and conflict-safe manual LAN sync are also included. A persona preset can retain the visible user name and an optional local avatar for that chat; a stable placeholder is generated when no avatar is uploaded, while model-facing identity remains explicit in the preset prompt fields.
- In-chat AI Agent for scene summaries, next-step suggestions, reply drafts, memory/lore candidates, continuity checks, and character-consistency checks. Reply drafts can be inserted individually; memory and embedded-lore candidates require an explicit user confirmation before they are written.
- Per-module model preferences for chat, AI Agent, memory maintenance, memory embeddings, user profile summaries, voice transcription, text-to-speech, and image generation, with capability-filtered model choices and server-side validation.
- Provider-neutral safe model errors, request IDs, explicit cancellation, reconnectable request status, bounded transient retries, and opt-in per-module fallback chains. Streaming never retries or switches models after output begins; interrupted partial replies remain visible and are marked incomplete instead of being duplicated or discarded.
- A local per-attempt usage ledger and price snapshots for every real model call, including retries and fallbacks. Settings shows token/cost summaries by module, provider, model, and chat, plus soft warnings and backend-enforced daily/monthly hard budgets. Cost values are local USD estimates, unknown pricing is never treated as free, and a lightweight session privacy lock unmounts the workspace, blocks protected HTTP APIs, and closes/rejects WebSockets while active.
- Each model can store an optional context-window limit. Chat settings estimate the next prompt plus reserved response tokens, warn near the configured limit, and never silently trim story history.
- Generated assistant replies retain a token-only Prompt composition breakdown. The prompt debugger itemizes character instructions, user configuration, profile summary, matched embedded lore, recalled memory, included chat history, and turn-specific generation instructions without duplicating the full prompt text or making another model request.
- Voice input/transcription, per-reply narration, configurable speech voice and playback speed, optional automatic playback for new replies, and OpenAI-compatible image generation through backend-proxied media endpoints. Chat messages can also carry up to four locally selected, dropped, or pasted images for vision-capable models. JPEG/PNG are re-decoded and metadata-stripped; browser-supported WebP/GIF/AVIF inputs are converted to a safe static PNG/JPEG first. Every image is previewed before send, and an incompatible chat model explains why it cannot be used instead of silently dropping the image.
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
- Authoritative chat readiness and a recoverable first-use guide derive character, chat, provider, key-presence, model capability, budget, and connection state from the local backend. Settings separates read-only static validation from an explicit metadata connection check and a separately confirmed minimal inference test.
- Character opening generation for empty chats, stored as a normal assistant message that can be edited or regenerated.
- Continue the latest assistant reply in place when a response is truncated or the scene needs to carry on; continuation keeps the current message and variant instead of creating a fake user turn.
- Generate a concise AI title draft from included chat messages, then review and save it explicitly; title suggestions never overwrite chat history automatically.
- Default `New Chat` conversations receive one automatic AI title after the first user/assistant exchange; manually named chats are never overwritten.
- Large collections use stable, filter-scoped pagination. A chat opens with the latest 50 messages and keeps at most 250 rendered turns while older pages preserve the visible anchor; bookmarks and memory panels page independently. Vector-index rebuilds run in cancellable 64-item batches with content-free progress, and timeline images use protected lazy thumbnails before loading an original preview.
- Optional automatic LAN sync can pull-and-merge from the last successfully used peer at startup. It always performs the ordinary read-only preview first and writes only when the preview is valid and conflict-free; conflicts pause for manual review, replace mode is never automatic, and API keys remain device-local.

## Local Development

```bash
npm install
npm run db:generate
npm run dev
```

`npm run dev` creates the default local SQLite database from the checked-in SQL migrations only when it does not already exist. It never overwrites an existing database. Open `http://localhost:5173` after the server is ready.

For a manual first-time database initialization, run `npm run db:init`. This avoids relying on Prisma's SQLite migration engine in Windows development environments.

## First use and model diagnostics

On a fresh installation, the closable five-step guide explains local data storage, backend-only encrypted API keys, third-party provider requests, and the absence of a bundled cloud account or free quota. It then links to original-character creation or card import, the existing provider templates/custom OpenAI-compatible/Anthropic/Gemini controls, the saved chat-model capability selection, an explicit connection check, and New Chat. The guide never creates default content or calls a model automatically. Closing it does not mark the product ready; it can be reopened from Settings or in-app Docs, and it stops opening automatically after the first successful streamed reply.

`GET /api/readiness` is the desktop/mobile authority for ordinary text-chat readiness. It recomputes character/chat availability, saved provider and key presence, active/chat model references, text and optional `vision_input` capabilities, fallback references, unknown pricing, local hard-budget state, and the most recent matching connection result. A provider, base URL, encrypted key, model, or capability change invalidates the process-memory connection result. Readiness and connection results are device-local and do not enter backups or LAN sync.

Settings → Model configuration diagnostics validates saved configuration without contacting a provider. The default explicit connection check calls the provider's model-list/metadata endpoint and normally incurs no inference charge. The optional inference check sends only a fixed neutral instruction containing no user content, requests at most four output tokens, requires a cost confirmation, and uses the normal `ModelRequest`/`ModelUsageAttempt`, budget, retry, cancellation, and settlement lifecycle. Neither check sends character, chat, persona, profile, memory, or lore content. Diagnostics expose only safe error codes, an opaque diagnostic ID, provider kind, time, retryability, and suggested action—never keys, headers, sensitive URLs, test input, or provider response bodies.

Automated server contracts and the desktop/mobile API smoke suites use loopback mock providers. They do not contact paid model services and never require real API keys, real chat content, or image fixtures containing user data.

Deterministic Small, Medium, Large, and Mobile-large performance fixtures and repeatable server/browser/mobile benchmarks are documented in [Performance and scale verification](docs/performance.md). The scripts accept only explicit temporary data paths, capture p50/p95/max latency and memory evidence, and provide report and like-for-like regression comparison commands.

Common safe codes include `configuration_incomplete`, `invalid_url`, `connection_failed`, `tls_failed`, `timeout`, `authentication`, `permission_denied`, `model_not_found`, `unsupported_capability`, `rate_limited`, `quota_exceeded`, `budget_blocked`, `cancelled`, `provider_unavailable`, and `malformed_response`. Fix URL/key/model/capability errors in Provider Management, budget errors in Usage & Budgets, and transient failures by retrying the explicit connection check. Local unauthenticated services may use localhost, loopback, RFC1918, or `.local` HTTP(S) endpoints; other URLs still require safe HTTP(S) syntax and cannot embed credentials, secret query parameters, or fragments. A plain text chat needs text-generation capability; image attachment additionally requires `vision_input`. Local estimates and diagnostics are not provider billing records or an official provider status page.

## Data protection and recoverable sync

Backup import and LAN pull/push use a two-phase preview/execute contract. Preflight validates schemaVersion 1, ISO dates, duplicate IDs, and character–chat–message–memory references without writing data. The preview reports additions, updates, skips, conflicts, invalid records, and replace-mode deletions. Merge never overwrites a different record with the same ID until every conflict has an explicit keep-existing, use-incoming, or skip choice. Replace remains a separately confirmed danger operation.

Before an import overwrites or deletes existing data, the backend stores a local recovery point containing characters, chats, messages, long-term memories, and non-key settings. Recovery points are transactionally restorable, capped at 10, and pruned after 30 days. A restore creates its own pre-restore safety point, and a failed restore leaves the current dataset unchanged. API keys are excluded from backup, recovery-transfer, and LAN-sync payloads; provider keys already stored on a target device are preserved.

Large schemaVersion 1 backup/sync JSON bodies are accepted up to 256 MB on desktop and mobile, while record/media validation and free-space checks still apply. Peer export/preview may run for up to three minutes and execute for up to ten minutes. A deterministic 200,000-message server fixture verified a 156 MB replace preview, automatic recovery point, transactional replace, safety point, and exact restore; these operations can take several minutes and temporarily use substantial memory, so keep the app open. Measured evidence and reproducible commands are in [Performance and scale verification](docs/performance.md).

Assistant messages keep a compact generation summary with the actual provider/model, token usage, local cost estimate, fallback state, and incomplete state. That summary follows the message through schemaVersion 1 backups, LAN sync, and structured chat archives. The global `ModelRequest`/`ModelUsageAttempt` ledger and active budget reservations remain device-local and are excluded from those payloads. Clearing the local ledger requires confirmation and does not remove messages or change the provider's bill.

Chat image attachments use app-private, content-addressed storage and are never kept as Base64 blobs in browser storage. Limits are four images per message, 10 MB per source image, 20 MB total normalized data, and 25 megapixels per decoded image. SVG, remote-image URLs, arbitrary files, damaged data, MIME/signature mismatches, and extreme dimensions are rejected. EXIF orientation is applied before metadata is removed. Draft images expire after 24 hours; unreferenced assets are garbage-collected, while shared assets remain until the last message or recovery point releases them. App lock removes image previews from the workspace and protects media endpoints with the same `423` boundary as chat data.

Settings includes a responsive **Storage & health** center backed by the same desktop/mobile contract. It reports exact, estimated, or unavailable measurements for the SQLite database, core records, memory/history, sent/draft/recovery media references, local data-URL images, embeddings, recovery and upgrade copies, trash/tombstones, usage ledger, and app-private temporary files. Fast checks and cancellable deep checks are read-only. Cleanup is always per action: the backend creates a five-minute, one-use plan, revalidates targets immediately before execution, skips active/referenced data, and reports partial results. `VACUUM` is separate and mobile reports it unsupported when it cannot guarantee the operation safely. Low disk space blocks imports and image uploads while leaving safe diagnostic export available. See [the storage inventory](docs/storage-data-inventory.md).

## Global appearance and accessibility

Settings → Appearance & accessibility controls system/light/dark theme, four font sizes, reading line height, chat width, message spacing, standard/high contrast, system/reduced/full motion, chat-background overlay and limited blur, plus full/restricted/off character CSS. The same semantic tokens apply to Chat, Characters, Settings, Docs, dialogs, forms, media, and status surfaces. Changes preview live and are saved in ordinary non-key settings, so schemaVersion 1 backups, recovery points, and LAN sync retain them without changing the backup protocol.

A small allow-listed local mirror applies appearance before React starts to prevent a theme flash. It contains only display enums and numeric overlay strength—never API keys, chat backgrounds, character CSS, chat text, personas, or profile summaries. The session privacy lock keeps this non-sensitive appearance active while unmounting all protected workspace content. OS theme and reduced-motion changes are followed live when their preference is set to System. At 200% zoom and narrow mobile widths the workspace remains reflowable; browser pinch zoom is not disabled.

Restricted character styling preserves stored `htmlCss` unchanged but filters rules that can hide controls or focus, force tiny text, trap overflow, create fixed overlays, extreme stacking, pointer blocking, or custom/keyframe animation. Off mode omits character CSS entirely. High contrast and reduced motion remain authoritative over character styles in every mode.

Images are part of message lifecycle rather than loose uploads: image-only user turns, edit/reorder/remove, regenerate/resend, branches, checkpoints, deletion, Trash, permanent deletion, readable-export placeholders, JSON chat archives, full backups, recovery points, and manual LAN sync all preserve or clean up their attachment references transactionally. Binary content appears once per archive/backup media manifest with hash, byte-length, type, and dimension checks. API keys never enter these payloads. When a vision request is sent, the selected provider receives the image bytes through the backend; that third party may retain or process them under its own policy. Image token/cost estimates are conservative when supported and remain explicitly unknown when they cannot be priced safely.

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
