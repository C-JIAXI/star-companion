# Native-inspired visual system

## Scope

Star Companion uses an original Apple-inspired visual language, not a copy of an Apple application. No Apple logos, proprietary fonts, or downloaded assets are included. The existing product logo, routes, single-character model, dialogs, and data contracts are retained.

- Mist-white and graphite surfaces replace the green-tinted foundation. Blue is reserved for primary actions and selection; warning/error/success colors remain semantic.
- Platform system fonts, rounded controls and panels, subtle surface separation, and compact aligned page headers establish consistent hierarchy.
- Settings have a persistent desktop category column and a horizontally scrollable mobile category row. The compact save state remains available outside model sections. Runtime/provider diagnostics no longer precede unrelated appearance, backup, storage, or update content.
- Character cards have more breathing room, a lower desktop column density, and 44px primary/edit actions. Editor, import, favorite, batch management, and private-character behavior remain unchanged.
- Chat retains its tested three-column/drawer structure and draft lifecycle, with blue user bubbles, readable white message controls, rounded message surfaces, and a grouped composer.
- Docs use grouped reading surfaces with the existing section index.
- The composer is a floating rounded glass card with a borderless growing text area and circular send action. Only image attachment, More tools and Send stay visible; transcription, speech and image generation live in a keyboard-accessible popover. Active recording/playback still exposes a direct Stop action. Draft status and costs sit below the card; errors and budget warnings remain explicit.
- Settings put editable configuration first, with a compact save bar and collapsed model overview; diagnostics follow the configuration. Character search stays visible while filters, sort and batch controls expand on demand.
- Subtle entry/press/hover motion and selective glass add depth. Reduced motion disables nonessential animation; high contrast removes glass. Popovers are portaled to avoid clipping or transformed containing blocks.
- The chat sidebar places branding, search and collapse in one header row aligned with the chat header. Chat title and character identity share one compact rename control. The unified tool surface owns the only close button; Agent content no longer repeats its title/close controls.
- All four routes now share the same sidebar brand row and desktop collapse/reopen behavior. Headers use a common 64px minimum height. The root respects actual safe-area insets without imposing an extra 12px minimum on desktop; mobile headers do not apply the root inset twice. Cross-route geometry tests reproduced the previous 76px header and 12px top gap before the fix.

## Implementation boundaries

`styles.css` and `tailwind.config.ts` own semantic colors and the platform font stack. `ui.tsx` owns common surfaces and controls. The initial HTML theme color and runtime appearance application use the same neutral backgrounds. Existing appearance persistence, reduced motion, high contrast, privacy locking, and restricted/off character CSS are not replaced.

No schema, backup envelope, prompt, API client, or third-party model request changed. Existing local modifications were preserved; no commit or push was performed for this redesign.

## Verification

`native-design.spec.ts` checks light/dark settings selection contrast, desktop category placement, and horizontal overflow at 1440px, 390px, and 320px. It captures Settings, Characters, and Docs using the isolated E2E database; screenshots are under `docs/native-design/{chromium,mobile-chrome}`. Chat layout screenshots remain under `docs/chat-workspace-layout/after`.

Commands used:

- `npm run lint`
- `npm run build`
- `npm run test:e2e --prefix apps/web -- workspace-layout.spec.ts workspace-stress.spec.ts workspace-zoom.spec.ts`
- `npm run test:e2e --prefix apps/web -- native-design.spec.ts`
- `npm run test:e2e`

The first full run passed 174 tests and failed the two expected old appearance screenshot comparisons. The four appearance baselines were visually checked and regenerated; the focused appearance tests then passed on both projects. A subsequent full run passed 175 tests and timed out once while waiting for the historical message editor to close. The mobile test passed three isolated repetitions. Its remove-image step now explicitly waits for the asynchronous removal to become visible before filling/saving, avoiding a dialog reflow race without changing application behavior or weakening assertions. The focused native-design and late-acknowledgement run passed all four tests. Final complete-suite results are recorded below after the rerun.

The intermediate complete suite passed 176 tests. Follow-up structural changes added composer keyboard/menu/fallback coverage. A low-height regression caused the expanded cost region to overlap the input; the card now reserves its measured input height plus toolbar/context space, and both stress projects pass again. Final verification is recorded below.

User-reported sidebar/header regressions were reproduced with a dedicated geometry test: the collapse and brand centers differed by 54px. Moving the control into the brand row, grouping the title identity, and removing the inner Agent close action made both browser projects pass. This follows the diagnose skill's reproduce/fix/regression loop without creating remote issues or changing repository issue-tracker configuration. The subsequent full run passed 173 and failed five: two collapsed-filter test entry points, two composer/list width mismatches, and one asynchronous image-editor removal race. These are addressed before the final rerun.

Real Android/iPhone software keyboards remain unverified because no physical device is available. Mobile browser projects and simulated visualViewport tests are not physical-device evidence. Vite continues to warn about the existing lazy Markdown editor chunk; the initial bundle budget remains enforced separately.

## Final verification

- `npm run lint`: passed.
- `npm run build`: passed; initial JavaScript 357.6 kB, existing lazy editor chunk warning only.
- Cross-route/sidebar/title/unique-close, native visuals, keyboard menu and accessibility fallback subset: 8 passed.
- Layout, low-height, Agent, image editing and paged character subset: 12 passed.
- Final `npm run test:e2e`: 181 passed, one outdated mobile appearance baseline failed after a Windows `UNKNOWN: unknown error, open` interrupted its earlier update. The actual image was visually reviewed (277px vs the old 278px height), then the mobile baseline update passed. A normal, non-update rerun of the appearance test passed in both projects (2 passed). Thus every test has passing final coverage; a second full-suite run after the baseline-only correction was not performed.
- `git diff --check`: passed. No data model/backend/prompt changes; no commit or push.
