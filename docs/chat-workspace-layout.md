# Chat workspace layout implementation

## Checkpoint 1 — baseline and shell (in progress)

Baseline screenshots use an isolated temporary E2E database and synthetic character,
messages and draft. No model calls or user database are involved.
Canonical baseline images: `chat-workspace-layout/before/chromium/`.

Observed: duplicate application/chat headings, large desktop outer padding,
mobile toolbar crowding, and an Agent overlay covering the conversation on wide screens.

Implemented so far: chat-only panel without the shared card wrapper, removal of
chat's application heading, collapsible desktop sidebar with accessible reopening,
and a common reading-width rule for message list and composer. Other page shells
remain unchanged. Sidebar collapse is session-only and contains no sensitive data.

Verification so far:

- `npm run lint`: passed after correcting JSX nesting.
- `npm run build`: passed after correcting the `zh-CN` language comparison.
- `npm run test:e2e --prefix apps/web -- workspace-layout.spec.ts --project=chromium`:
  1 passed; captures 1440×900, 1280×720, 1024×768, 390×844 and 320×568.
- Visual inspection of the intermediate 320px capture found toolbar crowding
  could squeeze the title away; a temporary wrapping rule preserves the title
  until checkpoint 2 consolidates mobile actions. This follow-up needs recapture.

## Remaining checkpoints

Checkpoint 2 started: Agent now uses a reusable `ChatToolSurface`. A workspace
ResizeObserver docks a 340px tool area when at least 980px is available; otherwise
it uses a drawer with the existing dialog focus/Escape behavior. No generation or
candidate-application handlers were changed. Opening app navigation closes the
Agent presentation without clearing its parent-owned state.

`npm run lint --prefix apps/web` and `npm run build --prefix apps/web` passed.
The Chromium layout test passed with additional assertions for non-overlap,
docked-to-drawer resizing, Escape close, and preservation of composer text and
Agent focus text after reopening. These assertions do not yet prove generated
Agent result retention, memory edit retention or scroll-anchor stability.

The four tools now share the same surface and a wrapping two-column navigation.
Memory and story views render into its scrollable host instead of separate modals;
chat settings exposes the existing persona, profile, context and model dialogs.
Memory editor initialization is now per chat, so switching tools no longer resets
unsaved values. No state is persisted to browser storage by this change.

The updated Chromium layout test passed (1 test, five viewport captures), including
memory-turn edits surviving a story/return switch and Agent focus text surviving
tool switching, drawer resize and close/reopen. Web lint/build passed. A 1440px
capture was visually inspected: the tool column occupies layout space and the
composer remains fully visible. Full memory-operation and generated-Agent-result
regressions remain pending, as do header consolidation and scroll anchoring.

Header consolidation is now implemented: desktop model/search/tools/more and
mobile navigation/title/search/more. Model and tools remain within two actions.
The title is an accessible rename button with a full-name tooltip, accompanied
by the character name. More groups model/tools and chat management, including
existing exports/background/bookmarks/title suggestions; archive and move-to-trash
use independent confirmation dialogs and existing APIs. Auto-profile-summary
control remains in Chat settings. No model-switch scope changes were made.

Web lint/build and the updated five-viewport Chromium capture test passed. New
assertions cover a nonzero narrow title area, 44px search/more targets, a single
header, menu End navigation, Escape and focus restoration. Existing E2E callers
of relocated toolbar controls still need migration to the new user paths; their
business assertions must be retained. Scroll-anchor and composer work remain open.

## Checkpoint 3 — composer and viewport (in progress)

Composer DOM order is now images, textarea, media/send toolbar, draft/recovery
status and cost disclosure; quick replies remain immediately above it, with a
single scrollable row by default and explicit expansion. The queue has a count
disclosure; editing/removal controls remain within its expanded list. Budget
warnings remain outside the collapsed cost details. Existing draft, handoff,
attachment and send handlers were moved without changing their API payloads.

Textarea growth is capped by both six lines and 20% of the available viewport;
resize and appearance changes remeasure it. Chat's shell tracks the visual
viewport only at normal pinch scale and no longer asks the outer window to scroll
the composer into view. This is not evidence of real soft-keyboard behavior.

Validation: Web lint/build passed. Chromium `workspace-layout.spec.ts drafts.spec.ts`
passed all 15 tests, including autosave failure/retry, stale-tab conflict, ordered
image draft switching/reload, lock-crossing image preparation, late acknowledgements,
legacy/manual recovery and budget retry identity. Layout assertions additionally
check composer DOM order, bounded 40-line input, internal input scrolling and a
visible send button across five target sizes. Mobile project/full suite, actual
keyboard, resize reading anchors and final visual/a11y checks are still pending.

## Checkpoint 4 — regression (in progress)

A focused reading-anchor test first reproduced a 175px displacement when changing
font size. `useChatLayoutAnchor` now caches message ID/offset and compensates only
for layout changes, deferring to the existing pagination anchor. The test passes
for opening tools, collapsing/reopening the sidebar and changing font size.
Pointer activation of wide-layout sidebar/tools controls retains composer focus;
modal drawers still use their keyboard focus trap.

Both projects passed all 28 draft tests. The subsequent targeted run passed all
10 existing queue, Agent candidate, memory confirmation, profile history and
pagination/search cases (five per project). New layout tests then passed both
projects, covering all five viewport sizes. One earlier screenshot write failed
with Windows UNKNOWN and did not reproduce. A separate geometry check was made
atomic (same browser evaluation) after asynchronous measurements crossed a layout
update; the layout-order requirement was retained.

Old toolbar tests are being migrated to More/Tools paths without removing business
checks. Full E2E, streaming/lock/theme/CSS audits, 200% zoom, real keyboard limits
and final user documentation still need completion.

The first full `npm run test:e2e` completed with 164 passed / 6 failed. Failures
were stale export/menu roles, the removed chat heading semantics, a mobile global
search entry, and broad persona-menu selectors. The real chat title now has heading
semantics; global search remains reachable from mobile navigation. Targeted reruns
passed exports, mobile section switching, global search and persona persistence.

Additional full/restricted core CSS protection ignores structural declarations
while retaining official paint selectors. A synthetic character attempting to
hide/zero-size/transform the composer and navigation no longer removes them.
Light/dark extra-large high-contrast tool captures were inspected. Axe checks for
button names, labels and contrast passed in both projects after fixing Agent mode
description contrast. The theme fixture now boots actual appearance settings rather
than mutating attributes that settings refresh could overwrite.

README, AGENTS and bilingual in-app guidance now describe the implemented paths.
A final clean full-suite run, extended zoom/keyboard/attachment stress coverage and
completion audit remain required; this is not a completion declaration.

2. Single compact header, model/menu access and unified responsive tools; retain
   Agent drafts and memory edits, coordinate drawers and keyboard focus.
3. Composer order, bounded auto-growth, quick replies, queue disclosure and dynamic
   mobile viewport; preserve drafts/handoffs/attachments and generation semantics.
4. Anchor/pagination regression tests, visual/theme/a11y/privacy/CSS coverage,
   full lint/build/E2E, README/AGENTS and in-app documentation.

Current screenshots are intermediate evidence, not final acceptance. Actual mobile
soft-keyboard behavior and desktop 200% zoom have not yet been verified.
