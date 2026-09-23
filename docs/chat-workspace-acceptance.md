# Chat workspace acceptance audit

Scope: chat and its necessary application shell only. Settings categories and the
character editor are not part of this goal. This audit records evidence, not intent.

| Requirement group | Current evidence | Final result |
| --- | --- | --- |
| Baseline and five target viewports | Synthetic captures under `chat-workspace-layout/before/chromium` and `after`; `workspace-layout.spec.ts` visits 1440×900, 1280×720, 1024×768, 390×844 and 320×568 | Passed; captures inspected |
| One header, collapsible sidebar, central area, dock/drawer | Chat-only App shell; `ChatWorkspacePanel`, `ChatToolSurface`; width measured by ResizeObserver; tests assert one header, docking and non-overlap | Passed |
| Shared reading width and scrolling | `#chat-message-list`, `#chat-composer` and quick replies share `--chat-reading-width`; independent message/list/tool scroll areas | Same-width and composer-focus assertions passed |
| Reading anchor, bounded history, pagination/search | `useChatLayoutAnchor` compensates layout changes; layout test checks tool/sidebar/font changes within 3px; app tests exercise history pagination and search | Passed |
| Header/menu paths and destructive actions | Model/search/Tools/More, mobile menu/title/search/More; legacy selectors retained; separate archive/trash confirmations | Passed |
| Unified tools, edits and Agent draft | Layout test preserves memory-turn edits and Agent focus input; Agent app test preserves generated draft across tool changes and reopening, asserts one request, then applies candidate explicitly | Passed, including tool-content lock assertion |
| Composer order, quick replies, images, queue, status/cost | Quick replies hide their options by default and render eight stable-ID items when expanded; ordered images above text and toolbar; queue/cost disclosures; draft suites cover failure/conflict/expiry/handoffs | Passed, including large-font queue and low-height cost disclosure |
| Small viewport and dynamic height | Stress test uses 320px, large font, two images, long draft and simulated 360px visualViewport; verifies bounds, retained draft and image reordering | Real keyboard unavailable; see limitation below |
| Actual desktop zoom | Extension sets/reads tab zoom 2; verifies innerWidth 1440→720, visible composer and drawer; explicit desktop context in both test projects | Passed |
| Themes, contrast, reduced motion and character CSS | Light/dark extra-large high-contrast/reduced-motion captures, axe controls/labels/contrast; hostile structural CSS fixture cannot hide composer | Passed |
| Draft/handoff/model/lock invariants | No backend/shared/protocol changes; app and draft suites retain original business assertions for generation, reconnect, queue, media, model switching, lock and recovery | Passed |
| Documentation and deliverables | README, bilingual DocsPage, AGENTS and chronological layout record updated; synthetic before/after screenshots saved | Updated, including low-height operating instructions |
| Commands | `npm run lint`, `npm run build`, `npm run test:e2e` | All passed; final E2E 174 passed (4.4m), exit 0 |

## Platform limitation

The user confirmed no real Android/iPhone is available for this task. Mobile Chrome
emulation, a mocked visualViewport reduction, and desktop browser zoom are separate
forms of evidence. None demonstrates an actual OS keyboard, browser chrome motion,
or device safe-area behavior. A later device check should focus the long composer,
open the keyboard, rotate the device, reorder images, and exercise queue/stop and
status recovery controls without losing draft content. No real-device pass is claimed.

## Supplemental verification

The first clean full run after the low-height fix passed all 174 tests. Further
explicit assertions then passed in both projects:

- Shared message-list/composer width differs by less than 2px at every target
  viewport. Collapsing and reopening the desktop sidebar retains composer focus.
- Locking with Agent open removes both the tool surface and Agent content from
  the DOM. Generated drafts survive tool changes/reopening without another call.
- Queue count starts collapsed; at 320px with extra-large text, expansion, edit,
  discard confirmation and eventual sending retain the existing assertions.
- At simulated 360px visible height, cost details can be opened and closed, the
  budget warning remains outside the collapsed details, image order can change,
  and the exact draft survives. The composer remains within the visible height.

Source review confirms Enter/Shift+Enter/touch-composition handlers were moved
without changing their send rules. Close/switch-tool handlers only change display
flags, not generation or candidate application. The privacy-lock App boundary
unmounts ChatPage and its tool state. Navigation opening closes the tool surface;
confirmations remain separate layered dialogs. Safe-area padding and dynamic
height are retained without disabling browser zoom. No backend/shared/mobile
backend or database protocol files differ from the layout baseline.

All screenshots contain synthetic fixtures. The 1440px before/after Agent view,
1280px, 1024px, 390px, 320px, large-font theme views, low-height image view and actual
200% zoom view were visually inspected. Baseline screenshots intentionally show
the original duplicate header and overlay. Later captures include quick replies
after the fixture-ID omission was found and corrected; this limitation is recorded
in the chronological log rather than regenerating a false baseline.

Final run on 2026-09-15: lint passed, build passed, full E2E 174 passed in 4.4 minutes
(exit 0). Vite still reports the existing lazy Markdown-editor chunk size warning;
the enforced initial-bundle check passed at 357.3 kB. No server/API/mobile smoke
rerun was required because those implementations and shared protocols were not
modified. Real-device keyboard testing remains the explicitly stated platform
limitation, not a claimed pass. No further feature work is included in this goal.

Key implementation files: `apps/web/src/App.tsx`, `pages/ChatPage.tsx`,
`components/ChatWorkspacePanel.tsx`, `ChatToolSurface.tsx`, `ChatToolContent.tsx`,
`ChatActionsMenu.tsx`, `lib/useChatLayoutAnchor.ts`, `lib/useMobileViewport.ts`,
`lib/characterHtmlCss.ts`, and `styles.css`. The diagnose feedback loop identified
the low-height image/composer issue; the permanent stress test guards that case.

## Screenshot comparison

| State | Before | After |
| --- | --- | --- |
| Desktop with Agent | [before](chat-workspace-layout/before/chromium/1440x900-agent.png) | [after](chat-workspace-layout/after/chromium/1440x900-agent.png) |
| Narrow mobile | [before](chat-workspace-layout/before/chromium/320x568.png) | [after](chat-workspace-layout/after/chromium/320x568.png) |
| Simulated keyboard + images + large font | Not part of original baseline | [after](chat-workspace-layout/after/chromium/320px-images-large-font-simulated-keyboard.png) |
