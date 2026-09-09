# Mobile packaging

The product target is a local-first mobile app: the phone should carry its own
local backend and local data store. A WebView client that depends on a desktop
or LAN backend is only a development fallback, not the product direction.

## Current state

Mobile migration `006_chat_drafts` uses the existing SQLite record store for `chatDraft` and `draftHandoff`; the protected draft GET/PUT and handoff create/read/list/restore/discard endpoints match desktop CAS, receipt replay, and lock semantics. The composer saves raw text and ordered image metadata, with visible saving/failure/conflict states and manual recovery. Image bytes never enter browser storage. Disk writes use a temporary sibling plus rename and roll back after failure. Images retain their original 24-hour upload lifetime; reads do not renew them and expired/missing images leave removable placeholders alongside preserved text. Drafts, handoffs and receipts are local-only, excluded from backups/recovery/archives/sync; replace removes them with replaced chats. Queue scheduling is session-only, and recovery after reload/restart never auto-sends. See [the implementation and verification checkpoints](../chat-drafts-implementation.md).

This repository now has a Capacitor Android project and scripts that can package
the Vite web app into an Android shell.

The repository also has a mobile-runnable backend at `apps/mobile-backend`. It
is a Node/Express/WebSocket backend that avoids Prisma native query engines and
uses an app-private SQLite database through a WASM SQLite runtime.

Android packaging uses `capacitor-nodejs` with:

```json
{
  "plugins": {
    "CapacitorNodeJS": {
      "nodeDir": "nodejs",
      "startMode": "auto"
    }
  }
}
```

`npm run mobile:sync` builds the web app with `VITE_API_BASE_URL` defaulting to
`http://127.0.0.1:4110`, prepares `apps/web/dist/nodejs`, and syncs the web app
plus mobile backend into Android assets. The Node runtime is therefore part of
the Android build graph and is configured to start automatically with the app.

The existing desktop/server backend is still Node/Express with Prisma + SQLite,
and that stack cannot be treated as a simple copy-into-APK artifact:

- Capacitor runs the app in a platform WebView and talks to native code through
  plugins.
- Node.js-on-mobile options run a separate embedded runtime with mobile-specific
  limitations.
- The current Prisma runtime depends on generated native query engines and is
  the main compatibility risk for Android-local execution.

The mobile backend currently covers the core local API surface:

- health
- settings, including local API key encryption
- authoritative first-use/readiness status, static saved-configuration diagnostics, metadata-first connection checks, and separately confirmed minimal inference checks
- characters CRUD, public/private import/export, private-card unlock, batch fetch/delete
- chats CRUD, archive, recoverable Trash, restore, and separately confirmed permanent deletion
- messages CRUD, including transactional timeline cleanup that writes audited memory-disable revisions
- chat memories CRUD plus immutable revisions, source references, restore/purge, bounded maintenance operations, conflict-aware transactional undo, and per-chat profile-summary history
- backup import/export with read-only preflight and bounded local recovery points; memory revisions, operations, and profile history travel with current records
- two-phase LAN sync preview/execute through the same backup envelope, with explicit conflict resolution
- WebSocket generation through the same model-provider proxy helpers
- provider-neutral safe errors, stable request IDs, explicit cancellation, reconnectable status, bounded transient retries, and explicit per-module fallback chains
- a device-local request/attempt usage ledger with atomic budget reservation/settlement, price snapshots, usage summaries, and backend-enforced daily/monthly hard budgets
- application, schema, platform, build, commit, and migration-state reporting
- the same process-memory session privacy lock contract as desktop: protected HTTP APIs return 423 and active/new WebSockets are closed/rejected while locked

Private character-card export/unlock is implemented in the mobile backend with
the same AES-256-GCM envelope and password verifier protocol as the desktop
backend, but without importing Prisma-coupled server modules.

## Intended local architecture

Android-first target:

```text
Capacitor WebView
  -> http://127.0.0.1:<port>/api and ws://127.0.0.1:<port>/ws
  -> embedded local backend
  -> app-private SQLite database
  -> LLM provider APIs through the local backend proxy
```

The local backend must keep the existing product boundary:

- single user + single character reply
- no group chat
- no standalone lorebook page/API/model
- character context through embedded `loreEntries`
- API keys stored in app-private local storage, never in frontend state

The shared WebView also uses the same global appearance and accessibility contract as desktop: system/light/dark theme, reading size and spacing, high contrast, motion preference, chat background masking, and full/restricted/off character CSS. Only an allow-listed, non-sensitive appearance mirror is read before first paint. Android's browser zoom remains enabled, theme color follows the resolved theme, and the embedded mobile backend persists and transfers these non-key settings through backup/recovery/LAN sync exactly like the desktop backend.

The first-use guide is also device-local UI state: it is not backed up or synchronized and does not contain readiness results, API keys, content, or diagnostics. `/api/readiness` recomputes the same desktop contract from the embedded database and saved settings after character/chat changes, imports, restores, sync, and model edits. The privacy lock protects this endpoint with `423`, so the WebView unmounts the workspace instead of rendering onboarding behind the lock.

The default connection check uses provider model metadata and does not create a usage attempt or inference charge. The optional minimal inference test uses a fixed neutral instruction containing no user content, a four-token output cap, explicit cost confirmation, and the embedded request/attempt budget lifecycle. All OpenAI-compatible, Anthropic, and Gemini paths return only stable safe codes and opaque diagnostic IDs. Local unauthenticated HTTP(S) endpoints remain supported; URLs with unsafe protocols, embedded credentials, sensitive query parameters, fragments, or unsafe redirects are rejected. These local estimates and diagnostics are not provider billing records or official status pages.

The mobile smoke suite and server contract tests use isolated loopback mock providers only. They never call a paid endpoint or load real API keys, conversations, profiles, or user images.

LAN sync remains explicitly previewed. The settings page lets a user enter a peer
backend address on the same local network and choose pull or push with either
merge or replace mode. A device-local switch may also run one automatic
pull-and-merge from the last successfully used peer after backend startup. That
automatic path stops without writing when the peer is unavailable, the payload
is invalid, or any conflict needs a user choice; it never runs replace mode.
The sync payload is the existing full backup envelope,
so model API keys are not included. Both directions first return an impact
preview. A different record with the same ID is a conflict and cannot be
silently overwritten: the user chooses local, peer, or skip before execution.
Replace mode keeps a separate danger confirmation. Before an import overwrites
or deletes data, the embedded backend creates a local recovery point containing
characters, chats, messages, memories, memory revisions/operations, chat-profile
history, and non-key settings. Recovery points
are capped at 10 and older-than-30-day entries are pruned; restore uses an
atomic SQLite transaction and creates a pre-restore safety point.

Backup and sync JSON bodies use the same 256 MB ceiling as desktop. Peer export
and preview have a three-minute request timeout and execute has a ten-minute
timeout; schema/media validation, free-space checks, conflict handling, and
transactions still apply. The deterministic Mobile-large fixture verified a
30.3 MB envelope with 60,000 messages through preview, replace, automatic
recovery point, safety point, and exact restore. The WASM database and envelope
are visible in process RSS, so large operations should keep the app foregrounded.

Message-level generation summaries (actual provider/model, token usage, local
cost estimate, fallback state, and incomplete state) use the existing
schemaVersion 1 backup envelope and follow messages through LAN sync. The global
request/attempt ledger, active budget reservations, recovery points, and API
keys remain device-local and never enter backup or sync payloads.

Chat image attachments use the same desktop/mobile contract. Android uses the
system gallery/file picker; the shared web UI also supports paste and drag/drop
where the platform exposes them. A message accepts at most four images, each
source file is capped at 10 MB, normalized message data at 20 MB total, and
decoded content at 25 megapixels. JPEG/PNG are signature-checked, decoded,
oriented, and metadata-stripped. Browser-decodable WebP/GIF/AVIF inputs are
converted to a static PNG/JPEG; SVG, remote URLs, and arbitrary files are
rejected. Sending requires a model explicitly marked `vision_input`, and the UI
warns that selected bytes pass through the local backend to the third-party
provider selected for chat.

Normalized binary assets stay in app-private, content-addressed storage rather
than WebView local/session storage. Drafts expire after 24 hours and orphaned
assets are collected without deleting content still referenced by another
message or recovery point. Attachments follow edit, resend, branch, checkpoint,
Trash, permanent deletion, chat archive, full backup, recovery, pull, and push.
Archive/backup media manifests contain each binary once and validate SHA-256,
byte length, MIME, dimensions, and references before a transaction writes. App
lock unmounts previews and returns `423` from the protected media route.

The mobile backend exposes the same `/api/storage-health` summary, deep-scan,
cleanup-plan, and one-use execution contract as desktop. Counts and logical
sizes come from the app-private WASM SQLite store; app-private `temp` and
`cache` directories are inspected without following links. Mobile explicitly
reports upgrade-recovery cleanup and `VACUUM` as unsupported because this
runtime cannot guarantee the same atomic file replacement and exclusive-access
semantics as desktop. It never claims those bytes were released. Privacy lock
returns `423` for the health API and cancels an active deep scan. Low free space
blocks backup imports and image uploads, while safe diagnostic export remains
available.

Memory history is bounded to 30 revisions per memory and 100 operations per
chat. Snapshots keep only the memory fields needed for diff/restore and source
message IDs; they do not copy embeddings, prompts, model responses, API keys,
personas, or profile summaries. Deleted memories remain tombstones outside
prompt and retrieval until restored or separately purged. Old schemaVersion 1
payloads without history receive one explicit baseline for the imported current
state rather than invented past events.

The embedded backend applies the same reliability boundary as desktop to chat,
Agent, memory maintenance, memory embeddings, user-profile summaries,
connection tests, transcription, speech, and image generation. Each real
provider attempt is recorded separately. Only transient connection, timeout,
rate-limit, and temporary availability failures are eligible for bounded
retry/fallback, and no automatic retry or model switch occurs after streaming
has produced output. Interrupted partial text is persisted as incomplete. On
startup, unfinished requests are marked interrupted and their budget
reservations are released atomically.

Usage and cost values are local estimates, not provider billing records. Price
snapshots use user-configured micro-USD rates per million tokens; provider token
counts are preferred and local estimates are labeled. Work that cannot be
priced reliably remains `unknown`, never zero. The mobile and desktop APIs share
the same summary/filter/preview/delete contract and the same explicit
one-request hard-budget override. Deleting local usage history requires
confirmation and cannot change a provider bill.

Large mobile collections use indexed cursor pages for chats, messages,
bookmarks, message search, and memories. The embedded backend stores searchable
message text in a migration-managed column so global search does not deserialize
the complete message corpus. Prompt context reads only the configured recent
window. Memory-vector rebuilds run in 64-item batches with status polling and
cancellation; app lock cancels an active rebuild and clears protected thumbnail
caches. The repeatable Mobile-large benchmark is described in
[`docs/performance.md`](../performance.md).

Schema upgrades use a separate database-level safety layer. Before changing an
existing WASM SQLite file, the backend runs `PRAGMA integrity_check`, verifies
the ordered migration catalog and checksums, records the previous app/schema
version, and copies the complete database into the local `upgrade-recovery`
directory. The in-memory migration is transactional and the file is replaced
only after commit and a second integrity check. A checksum mismatch, failed
migration, or database from a newer unsupported app is rejected without
overwriting the original file. Upgrade safety copies are capped at five.

The same settings section also displays backend addresses reported by
`/api/sync/info`. The loopback URL is for the current device only; LAN URLs can
be copied into another device's peer address field. The embedded mobile backend
listens on `0.0.0.0` by default so the phone can expose a LAN sync endpoint
while the WebView still talks to `http://127.0.0.1:4110`.

## Migration plan

1. Keep the Capacitor Android shell and URL resolver in place.
2. Continue extracting a backend storage boundary so route/service logic stops
   importing Prisma directly.
3. Keep Android emulator/device smoke coverage in sync with mobile backend API
   changes.
4. Keep the mobile private-card protocol covered by smoke tests whenever the
   desktop character-card protocol changes.

## Website-first sync status

The final embedded-backend synchronization pass now covers:

- provider model `contextWindow` settings;
- assistant-message `promptBreakdown` data for normal generation, opening
  messages, continuation, guided regeneration, branches, archives, backups, and
  LAN sync;
- the dedicated `POST /api/chats/:id/memories/reindex` endpoint, separate memory
  organization and vector rebuilding, plus partial-batch failure handling;
- v1 and v2 serialized user custom config, with only prefix/prompt/suffix sent to
  the model while v2 `displayName` remains UI-only;
- chat-scoped `userAvatar` snapshots and persona-preset avatars, while keeping
  avatars out of the lightweight `/api/chats` response;
- shared rolling-context, manual-exclusion, Persona, vector-index, and prompt
  debugging UI in the rebuilt Android Web assets.

`npm run mobile-backend:smoke` exercises these contracts against the embedded
backend. The frozen website pass was packaged successfully with
`npm run desktop:build` and `npm run mobile:build:android`; release builds should
continue running both commands so shipped resources cannot drift from source.

## Development fallback

The default Android build starts the embedded backend automatically. For
debugging only, the Android shell can still point at a developer backend with
`VITE_API_BASE_URL`:

```powershell
$env:VITE_API_BASE_URL="http://10.0.2.2:4000"
npm run mobile:sync
```

Use `http://10.0.2.2:4000` for the Android emulator when the backend is running
on the host machine. For a physical phone, use the host machine LAN address,
for example `http://192.168.1.23:4000`.

Allow the mobile WebView origin in backend CORS configuration when using this
fallback:

```powershell
$env:CORS_ORIGIN="http://localhost:5173,https://localhost,capacitor://localhost"
npm run dev
```

## Commands

```bash
npm run mobile:sync
npm run mobile:open:android
npm run mobile:build:android
npm run mobile:release:preflight
npm run mobile:build:release
npm run mobile-backend:smoke
```

The debug APK is generated at:

```text
android/app/build/outputs/apk/debug/Star-Companion-<version>-android-debug.apk
```

The root `package.json` supplies Android `versionName`. `versionCode` is derived
as `major * 1,000,000 + minor * 1,000 + patch`, providing a deterministic,
monotonic store value for normal semantic-version releases.

Release builds require either these environment variables or an untracked
`android/signing.properties` file with the equivalent four keys:

```text
STAR_COMPANION_ANDROID_KEYSTORE_PATH
STAR_COMPANION_ANDROID_STORE_PASSWORD
STAR_COMPANION_ANDROID_KEY_ALIAS
STAR_COMPANION_ANDROID_KEY_PASSWORD
```

The release preflight deliberately fails if any value or the keystore file is
missing. `npm run mobile:build:release` builds both APK and AAB and copies them
to `dist/android` with versioned names. The repository never contains a
keystore or password. Store delivery remains external: the app may open a
configured HTTPS store listing, but it does not download and silently install
replacement APKs. Supply that public listing URL at build time with
`STAR_COMPANION_ANDROID_STORE_URL`.

Android Studio or a local Android SDK is required to assemble the APK.

Draft persistence and all public record mutations now share a reentrant, async-context-scoped write queue. Nested writes persist only at the outer commit; a failed draft disk write cannot roll back a different acknowledged chat update. Draft and handoff HTTP reads wait for the durability barrier. Isolated tests exercise simultaneous updates, failed disk writes, restart, shared media and recovery-point-only references.

Old session queues are read only after unlocking and recovered only by explicit choice. Their valid image order is preserved; unavailable images require explicit text-only recovery. Failed saving retains the old copy. Image preparation and upload are cancelled on lock and are not resumed on unlock.

Current Windows machine note: the local command-line Android SDK is installed
under the user's local Android SDK directory, `android/local.properties` points
Gradle at that SDK, and `npm run mobile:build:android` successfully assembles
the debug APK.

Runtime verification was performed on the Android Studio emulator
`StarCompanion_API36`: the debug APK installs, the app launches, the embedded
backend is reachable from the WebView at `127.0.0.1:4110`, `/api/health`
reports the app-private SQLite store, and the chat, characters, and settings
pages load from the mobile backend.
