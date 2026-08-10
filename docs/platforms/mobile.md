# Mobile packaging

The product target is a local-first mobile app: the phone should carry its own
local backend and local data store. A WebView client that depends on a desktop
or LAN backend is only a development fallback, not the product direction.

## Current state

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
- characters CRUD, public/private import/export, private-card unlock, batch fetch/delete
- chats CRUD, archive, recoverable Trash, restore, and separately confirmed permanent deletion
- messages CRUD
- chat memories CRUD
- backup import/export with read-only preflight and bounded local recovery points
- two-phase LAN sync preview/execute through the same backup envelope, with explicit conflict resolution
- WebSocket generation through the same model-provider proxy helpers
- application, schema, platform, build, commit, and migration-state reporting

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

LAN sync is intentionally manual. The settings page lets a user enter a peer
backend address on the same local network and choose pull or push with either
merge or replace mode. The sync payload is the existing full backup envelope,
so model API keys are not included. Both directions first return an impact
preview. A different record with the same ID is a conflict and cannot be
silently overwritten: the user chooses local, peer, or skip before execution.
Replace mode keeps a separate danger confirmation. Before an import overwrites
or deletes data, the embedded backend creates a local recovery point containing
characters, chats, messages, memories, and non-key settings. Recovery points
are capped at 10 and older-than-30-day entries are pruned; restore uses an
atomic SQLite transaction and creates a pre-restore safety point.

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

Current Windows machine note: the local command-line Android SDK is installed
under the user's local Android SDK directory, `android/local.properties` points
Gradle at that SDK, and `npm run mobile:build:android` successfully assembles
the debug APK.

Runtime verification was performed on the Android Studio emulator
`StarCompanion_API36`: the debug APK installs, the app launches, the embedded
backend is reachable from the WebView at `127.0.0.1:4110`, `/api/health`
reports the app-private SQLite store, and the chat, characters, and settings
pages load from the mobile backend.
