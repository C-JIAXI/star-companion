# Complete chat drafts — implementation checkpoints

Status: **in progress**, not release-complete. Updated 2026-09-09. The full goal remains text + ordered images across switching, refresh and backend restart, clear save/error/expiry states, protected migration, CAS conflicts, recoverable send/queue handoff, privacy, and platform parity.

## 1. Reproduction and contract

- Read current AGENTS.md; starting worktree was clean after `cfcfb38` (regression test only).
- `npx playwright test e2e/drafts.spec.ts --project=chromium` failed at line 91: switch A → B → A preserved text but returned zero images instead of two. Test uses isolated SQL-replayed SQLite and controlled PNG fixtures, no provider calls.
- Current `ChatPage.tsx` saves text to localStorage, actively discards image drafts on chat switch, clears text before user-message acknowledgement, and can clear later images on a delayed acknowledgement. It still needs integration.

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
- Lint passed. Full E2E (148 tests) is running: old image-send mock requires the new handoff contract; queue assertions need the new explicit restore/discard confirmations. Preserve their original behavioral coverage while updating mocks.

Remaining audit concerns: HTTP message creation should consume handoffs too; verify actual WS lost-ACK replay, resume blocked-budget calls without duplicating the user message, refresh handoff receipts after terminal/reconnect, test rapid switching/lock and upload races/missing-image fetches/pending HTTP handoff failure/late ACK/first-token failure. Audit old sessionStorage queue compatibility, cache bounds, storage-health draft byte measurement, and replace semantics. Current README/in-app docs still contain the earlier backend-only warning and need updating after regression fixes.

## Remaining work, in order

1. Immutable send/queue handoffs and durable user-message receipts: same-transaction consume, lost ACK dedup independent of usage-ledger retention, explicit manual recovery/discard, late ACK cannot clear new edits. Apply desktop/mobile together.
2. Frontend controller/hook: chat-scoped debounce + switch flush, robust async/version ownership, explicit save/retry/conflict status; no sensitive browser persistence. Safely migrate old localStorage text after unlock and acknowledged saves, with old/new conflict choices.
3. Integrate image staging/adoption/order/removal, unavailable placeholders/reselect, confirmed clear; retain pending failed data; lock abort/clear; independent historical edits.
4. Queue remains session-only scheduling; reliable handoff and manual recovery after failure/restart, never automatically send restored drafts.
5. Cross-platform tests for rapid switching, failed saves, true backend restart, old/new migration, multi-tab conflicts, missing/expired media, lost/delayed ACK, first-token failure, queue failure, lock races, cleanup and backup exclusion. Existing UI regression remains RED until this is done.
6. Finish bilingual UI and user docs, storage health measurement/inventory, mobile documentation; replace this checkpoint warning with accurate completed behavior only when verified.
7. Final gates: lint, build, server tests, API smoke, mobile smoke, full desktop/mobile Playwright E2E, version check, migration replay. Audit every goal item against actual source and tests; no completion until all pass.

Do not commit this work without another explicit user request. No real user database or paid model is used for validation.
