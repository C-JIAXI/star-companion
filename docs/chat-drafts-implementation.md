# Complete chat drafts — implementation checkpoints

Status: **in progress**, not release-complete. Updated 2026-09-09. The full goal remains text + ordered images across switching, refresh and backend restart, clear save/error/expiry states, protected migration, CAS conflicts, recoverable send/queue handoff, privacy, and platform parity.

## 1. Reproduction and contract

- Read current AGENTS.md; starting worktree was clean after `cfcfb38` (regression test only).
- `npx playwright test e2e/drafts.spec.ts --project=chromium` failed at line 91: switch A → B → A preserved text but returned zero images instead of two. Test uses isolated SQL-replayed SQLite and controlled PNG fixtures, no provider calls.
- At reproduction time `ChatPage.tsx` saved text to localStorage, actively discarded image drafts on chat switch, cleared text before user-message acknowledgement, and could clear later images on a delayed acknowledgement. The integration below replaces those paths.

## 2. Protected persistence checkpoint

- Desktop `ChatDraft` table / mobile `chatDraft` record. Raw text, metadata manifest, ordered reference IDs, version, save timestamp, last mutation identity/hash.
- `GET /api/chats/:id/draft` is read-only. `PUT` validates `expectedVersion`, `mutationId`, raw `content` (maximum 200,000 characters), unique ordered `attachmentIds` (maximum 4).
- Saving a stale version returns 409 `draft_conflict`; retrying exactly the last mutation returns its current acknowledgement without incrementing version. Reusing that identity with different content is rejected.
- Upload to an ephemeral legacy draft, then adopt references through CAS. `draft_composer_` is reserved; legacy upload/delete/reorder/edit/send cannot mutate managed references. No binary copying on keystrokes.
- Metadata retains unavailable placeholders; reads never extend original 24-hour upload lifetime. Media endpoints recheck live references even on thumbnail cache hits.
- Privacy epoch checks reject requests crossing a lock boundary; mobile persists to a temporary sibling and renames only after the guard passes. Failed mobile writes roll back in-memory state and do not poison later retries.
- Trash preserves drafts and rejects edits; permanent deletion releases composer references. Shared assets remain protected. Current replace deletes local drafts with replaced chats (desktop/mobile parity); draft contents are not in recovery or sync envelopes.
- Historical message editing stages independent references with a fresh edit lifetime, without changing the sent attachment timestamp.

## Verified evidence (not a completion claim)

- `npm run test:server`: 228 passed at the persistence checkpoint (7 new draft service tests, including simultaneous writers).
- `npm run build`: passed after shared types and API client additions.
- `npm run test:api`: passed including the shared HTTP draft contract, after correcting a fixture missing its required character.
- `npm run mobile-backend:smoke`: passed including the same HTTP contract, after removing an accidental Prisma dependency from the portable ownership guard.
- `node --test scripts/mobile/chat-drafts.test.mjs`: 3 passed (database reopen, disk failure/rollback/retry, stale writes and privacy guard).
- Mobile smoke now runs those 3 persistence tests before starting its isolated backend; full smoke passed after updating its migration assertion to `006_chat_drafts`.
- `npm run lint`: passed, including `version:check` for `20260909000000_chat_drafts`.
- Desktop tests and API smoke replayed all migration SQL into fresh isolated databases, including `20260909000000_chat_drafts`. Mobile adds `006_chat_drafts` through protected migrations.
- Later changes still require reruns; none of this proves the UI or send lifecycle is complete.

## Integration checkpoint (2026-09-09)

- Added `DraftHandoff` / mobile `draftHandoff`: immutable pending snapshots, transactional consumption and content-free committed receipts; API create/read/list/restore/discard. Desktop migration: `20260909010000_draft_handoffs`.
- Added frontend `useChatDraft.ts`: chat-scoped debounced CAS saves, acknowledgement retries, legacy text migration, save/conflict/clear controls, image persistence and unavailable placeholders; lock clears sensitive memory. Queue scheduling now stays in memory; persisted handoffs are restored manually after reload.
- Original two-viewport multi-image regression is green. Extended `e2e/drafts.spec.ts`: **8 passed** (switch/reload/order/removal, failed-save retry, multi-tab conflict, legacy save acknowledgement).
- Server suite: **231 passed**. Desktop API smoke and mobile smoke passed with shared handoff HTTP checks; mobile persistence suite has **4 passed**, including handoff restart/single consumption.
- The earlier full E2E run finished with 144 passed / 4 failed (two obsolete image-send/queue mock contracts in both viewports). These contracts were updated without removing the original behavior checks.

## Sending, concurrency and UI checkpoint (after local commit `6f59ceb`)

- Fixed a startup regression: backup message schemas must derive from unrefined message fields, omitting both `draftId` and `handoffId`. New schema-boundary test reproduced the Zod `.omit()` startup error before fixing it.
- HTTP message creation now consumes the same durable handoff as WebSocket generation. Shared desktop/mobile smoke ignores a receipt and replays through both HTTP and a fresh socket: exactly one user message, original image, no model request, newer composer unchanged.
- Actual desktop backend process restart preserves exact raw text, ordered images, version and original timestamps. Mobile closes/reopens its independent SQLite store in persistence tests.
- Fixed a deterministic queue race: reply completion during handoff saving no longer strands the newly queued snapshot; only a successfully completed (or explicitly interrupted-for-queue) request permits session dispatch.
- Fixed restore acknowledgement loss: retain restore mutation identity, disable conflicting edits while the outcome is unknown, and retry exactly that operation. Recovery stays manual and never sends.
- Fixed image-load failures remaining labelled ready: unavailable placeholders preserve text and block send. Browser expiry timers are tested against the original upload lifetime.
- Fixed budget retries in both backend receipt handling and frontend status handling. Only an explicit budget override for a previously blocked/no-output/latest-message handoff resumes generation. The same request replay does not create another user message or provider call.
- Both smoke backends use local mock providers to verify first-token failure preserves the sent user message and incomplete assistant reply, does not refill the composer, and does not call the provider on receipt replay.
- Added count/UTF-8 metadata-size estimates to Storage & health, using SQL aggregates rather than returning draft text. Shared smoke runs orphan/expired cleanup while live drafts exist and proves their references remain readable; all draft/handoff routes are checked for locked `423` responses.
- Updated README, local AGENTS.md (already ignored by repository rules), bilingual in-app docs, mobile docs and the asset inventory. They describe local-only storage, 24-hour image lifetime, explicit recovery, conflict handling, queue scheduling and replace deletion.

### Verification in this checkpoint

- `npm run lint`: passed, including version check.
- `npm run build`: passed, including initial-bundle guard. Existing lazy Markdown-editor chunk-size warning remains non-fatal.
- `npm run test:server`: **232 passed**, zero failures/skips; includes both migrations replayed into isolated SQLite.
- `npm run test:api`: passed with backend restart, cleanup protection, lock, HTTP/WS receipt replay, budget resume and partial-output assertions.
- `npm run mobile-backend:smoke`: passed with the same HTTP/WS contract and **4** isolated store durability/failure tests.
- `npm run version:check`: passed for `20260909010000_draft_handoffs`.
- Expanded draft E2E covers exact multi-image recovery, order/removal, failed save, CAS, legacy acknowledgement, delayed A/B saves, late send acknowledgement with newer images, lost queue/restore acknowledgements, expiry/unavailable media, legacy conflict and lock/unlock, explicit budget retry. Historical edit isolation was added to the late-ack scenario.
- Full 158-case E2E: **157 passed / 1 failed**, unrelated persona-preset prefix assertion at `app.spec.ts:5830`; captured request had an empty prefix but other fields. Isolated repeat: **5 passed**. The subsequent full **160-case run passed**. The earlier intermittent failure is recorded, not claimed fixed.

## Final audit fixes (after local commit `23471fc`)

- Reproduced and fixed pending-list failures masquerading as save failures. Composer loading/saving and pending-list loading now have separate state, cancellation and retry. Both viewport tests cover failed refresh, retry, and an initial list failure with a usable saved composer.
- Added clear/cancel/reload checks in both viewports: cancellation retains raw text/images; confirmed clear persists and does not remove a pending handoff.
- Reproduced image preparation resuming after lock/unlock (one unexpected upload). FileReader, image decoding and upload now share a composer-owned cancellation signal; lock and explicit clear abort them. Both viewport regressions prove no resumed upload after unlock.
- Reproduced mobile draft rollback erasing a separately acknowledged concurrent chat update. Public record mutation entry points now share the async-context write queue; nested writes defer disk persistence until the outer commit. Draft/handoff HTTP reads wait for that durability boundary. Regression verifies memory and a reopened database after injected disk failure.
- Mobile shared-media test proves protection by another composer, a sent message, and a recovery point after all message/draft references disappear, including reopen. Removal occurs only after the last recovery reference is explicitly removed in the isolated fixture.
- Old session queues now appear only for manual recovery after protected loading. Original image order is preserved; failed saves retain the old copy. Missing images leave the current composer unchanged and require explicit text-only recovery/discard. Compatibility storage writes only acknowledgement IDs, never prepared text or image metadata. Both viewport tests cover recovery, failure/retry, reload, unavailable images, and zero generation requests.
- SQL catalog test reproduced its stale schema-version assertion; it now verifies both draft migrations, both tables, ownership columns and foreign-key integrity. `test:release-tools`: **14 passed**.
- Shared API smoke now checks both backup and chat-archive output against quoted/escaped draft text and reference IDs, before and after handoff. Desktop recovery-media regression also inspects the actual recovery snapshot and verifies replace/restoration do not recover local-only drafts. Sync uses the same backup export functions (`lanSync.ts` and mobile `index.mjs`).
- Focused checks: **8 E2E passed** for list/clear/lock/multi-image paths plus **2 old-queue E2E passed**; **6 mobile store tests passed**; desktop API and full mobile smoke passed with the expanded exclusion contract. Full **168-case E2E** and final gates subsequently passed; see the completion audit below.

## Completion audit (2026-09-09)

The original requirement set was checked against the source and the evidence map below. All required gates passed; no implementation or verification item remains open for this goal.

Final results: `npm run lint`, `npm run build`, `npm run test:server` (**232 passed**), `npm run test:api`, `npm run mobile-backend:smoke` (including **6** persistence tests), `npm run test:e2e` (**168 passed**), `npm run version:check`, and `npm run test:release-tools` (**14 passed**, including new SQL migration replay). After the last cancellation-signal addition, all **28** draft E2E tests passed again in desktop/mobile viewports. No skipped assertion or environment exemption was used to pass these gates.

The user explicitly requested checkpoint commits `6f59ceb` and `23471fc`; subsequent changes remain uncommitted unless separately requested. No real user database or paid model is used for validation.

## Requirement evidence map

Number references below use the seven sections of the original goal (UX, persistence, concurrency, sending, safety/platform/docs, required tests, and workflow). This map was checked against the final source, not just test names.

| Requirements | Implementation and direct verification |
| --- | --- |
| UX 1–3; persistence 1–3 | `ChatDraft`/mobile `chatDraft`, `ChatDraftDTO`, versioned raw `content`, ordered reference IDs and `updatedAt`. `chatDrafts.test.ts` verifies raw whitespace, identity/order/timestamps and database reconnect. Shared API smoke actually restarts the desktop process; mobile tests close/reopen SQLite. Both-view E2E switches A/B and reloads ordered multi-image drafts. |
| UX 4–5; concurrency 8 | `useChatDraft.ts` uses separate loaded/saving/saved/error/conflict and pending-list states. Failed PUT preserves local edits and mutation identity; retry must receive acknowledgement. E2E injects 503 and tests exact text, images, order/removal, and independent list-read retry. |
| UX 6; persistence 7 | Confirmed clear affects only composer text/references, cancels pending image processing and persists an empty version. Cancel + reload retains content; confirm + reload clears it while pending handoffs remain. Ordinary switch/unmount flushes instead of discarding media. |
| UX 7; persistence 6 | Backend and browser use original upload time + 24 hours, never renewal on read. Missing/expired manifest entries retain text and a removable placeholder. Server fault/clock injection and both-view image-load/clock tests verify status, preservation and reselect. |
| UX 8–9; sending 7 | `DraftHandoff` stores pending snapshots; session queue scheduling stays in memory. Reloaded handoffs and old session queues require explicit restore/discard and do not send. E2E counts generation requests, loses queue/restore acknowledgements and verifies recovery with images. |
| Persistence 4 | Legacy localStorage text is read after successful protected GET, retained until acknowledged save, and conflicts are user-selected with a visible preview. Both-view tests cover save failure, initial lock/unlock and competing backend content. Old session queues likewise use explicit recovery and only write ID acknowledgements. |
| Persistence 5; safety 3 | Backup/recovery/archive exports explicitly enumerate product records and message-owned media. Shared API checks quoted raw text/ref IDs before and after handoff; `backupMediaLifecycle.test.ts` inspects the actual recovery snapshot. LAN sync consumes those same exports. No draft-service logger or sensitive browser persistence was introduced; new storage writes in the compatibility helper contain only IDs. |
| Persistence 8–9; sending 9 | Trash preserves drafts and rejects save/send; permanent delete cascades composer/handoff references. Shared API tests actual trash/restore/permanent/cleanup routes. Server expiry/shared-reference tests and mobile recovery-only media test prove removal respects remaining owners. |
| Concurrency 1–2 | 350 ms debounce plus hook cleanup flush; beforeunload is a warning, not the persistence mechanism. Tests exercise autosave before reload and immediate A/B switching while PUT is delayed. |
| Concurrency 3–7 | Entry identity scopes results to chat; revision and `expectedVersion` CAS prevent stale overwrites. Exact mutation retries avoid duplicate versions. Simultaneous server writers and two-tab E2E expose one conflict; explicit keep/reload resolves it. Saves change reference ownership/order without duplicating asset bytes. |
| Concurrency 9; safety 1–2 | Privacy epoch guards around transaction/commit, protected 423 routes, aborted save/list/image requests and cleared text/manifest/legacy/handoff caches. Shared API tests every draft/handoff route under lock; E2E verifies no visible text, image or filename and no abandoned upload after unlock. Mobile failure tests cover lock during persistence and durability-barrier reads. |
| Sending 1–5 | Transactional handoff first preserves the outgoing snapshot, consumption creates one user message and content-free receipt. Replayed HTTP and fresh WS requests return the original message without another provider call. E2E delays acknowledgement while newer text/images are saved and confirms they survive. Deleted-message receipt replay is rejected rather than recreated. |
| Sending 6 | Shared desktop/mobile mock-provider smoke emits one token then fails: sent user message and incomplete assistant reply remain, composer stays cleared, and replay makes no additional model call. Explicit budget-only resumption is separately checked. |
| Sending 8 | Historical edit stages independent media references/lifetime. Server test and the late-ack E2E edit a sent message while checking the newer composer remains unchanged through reload. |
| Safety 4–6 | Prisma models + both SQL migrations + Zod fields + DTO serialization + shared/web types + API methods + mobile record migration/ownership agree. Server compilation, HTTP contract parity, mobile persistence smoke and migration catalog replay verify them. `test:release-tools` checks new tables, columns, foreign keys, checksums and rollback. |
| Safety 7–8 | README, local ignored AGENTS.md, bilingual DocsPage, mobile docs and storage inventory describe local-only scope, original 24-hour expiry, confirmations and session-only scheduling. No promptBuilder/product-boundary changes; model calls still use the attempt/budget lifecycle. |
| Required tests; workflow gates | Controlled PNGs, isolated databases and mock models only. Latest full gates: 232 server tests, 168 desktop/mobile E2E, API smoke, mobile smoke (6 storage tests), lint, build, version check, 14 release/migration tests. The final 28-test draft subset passed after the last cancellation-signal addition. |

### Limits retained by design

- Only acknowledged saves are durable; forcibly terminating the app while it says Saving/Save failed cannot guarantee the latest unacknowledged edit. Failed saves remain visible and retryable while the page is open.
- Images expire 24 hours after original upload; metadata/text remain, but removed binary data must be reselected.
- Drafts and pending sends stay on this device and are deliberately excluded from data transfer/recovery protocols; replacing or permanently deleting their chat removes them.
- Queue scheduling never survives restart as automatic sending. Invalid old queue payloads are reported and kept rather than silently dropped.
- Existing non-fatal Markdown-editor chunk-size warning remains. The earlier persona-preset intermittent E2E failure did not recur in subsequent full 160/168 runs; it is recorded above, not attributed to the environment or claimed fixed.
