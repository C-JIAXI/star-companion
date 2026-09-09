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
- Full 158-case E2E: **157 passed / 1 failed**, unrelated persona-preset prefix assertion at `app.spec.ts:5830`; captured request had an empty prefix but other fields. Isolated repeat of that test: **5 passed**. This is recorded, not claimed fixed. A new full **160-case** run is in progress after the budget retry and historical-edit assertions.

## Remaining completion audit

The goal is still active; a green focused subset is not full completion.

1. Collect the running full 160-case E2E result and resolve any failures. Investigate the persona editor race if it recurs; do not remove assertions or claim an environmental cause without evidence.
2. `refreshHandoffs` still shares `markError` with composer saving. A handoff-list failure after an otherwise saved composer can produce a save-error label whose ordinary save retry does not actually retry the failed list. Separate these states and test recovery.
3. Audit pending upload/save/restore operations crossing lock/unlock and rapid switching, including mobile disk-failure interleaving with other record writes. Current tests cover CAS, draft persistence guards and frontend lock clearing, but do not prove every interleaving.
4. Audit old `star-companion:chat-queue:*` sessionStorage records: new scheduling no longer writes them, but existing old-session entries are not surfaced by the new in-memory queue. Do not silently discard prepared text/images or auto-send compatibility recovery.
5. Finish targeted clear/cancel/reload checks and cross-platform shared-media/recovery-reference cleanup tests. Existing server tests protect other live drafts and sent messages, but explicit mobile recovery-reference parity should be proved.
6. Inspect cache lifecycle and all backup/recovery/archive/sync exclusion paths against the actual final source. Reconcile docs/checkpoint statements and run final gates on the final tree before marking complete.

The user explicitly requested the checkpoint commit `6f59ceb`; subsequent changes remain uncommitted unless separately requested. No real user database or paid model is used for validation.
