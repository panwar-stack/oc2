# Redesign Release Verification

This matrix closes only evidence that can be produced from the repository. It does not sign off manual release events or infer team-member data that the APIs do not return.

## Automated Gates

Run package commands from their package directory.

| Scope                             | Command                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web visual and interaction matrix | `CI=1 PLAYWRIGHT_WORKERS=1 VITE_OC2_TEAM_BOARD=false PLAYWRIGHT_HTML_OUTPUT_DIR=e2e/playwright-report/redesign-release bunx playwright test e2e/redesign/release-verification.spec.ts --project=chromium --output=e2e/test-results/redesign-release` from `packages/app` | Dark and light M1-M5 captures at 390px, 900px, and 1280px; Chromium 200% browser-zoom captures; keyboard, focus, overflow, semantic-state, and essential-text contrast assertions |
| M6 default gate                   | `CI=1 PLAYWRIGHT_WORKERS=1 VITE_OC2_TEAM_BOARD=false PLAYWRIGHT_HTML_OUTPUT_DIR=e2e/playwright-report/board-gate-off bunx playwright test e2e/redesign/team-board-gate.spec.ts --project=chromium --output=e2e/test-results/board-gate-off` from `packages/app`          | Board tabs absent without the environment flag                                                                                                                                    |
| M6 opt-in contracts               | `CI=1 PLAYWRIGHT_WORKERS=1 VITE_OC2_TEAM_BOARD=true PLAYWRIGHT_HTML_OUTPUT_DIR=e2e/playwright-report/board-gate-on bunx playwright test e2e/redesign/team-board-gate.spec.ts --project=chromium --output=e2e/test-results/board-gate-on` from `packages/app`             | Explicit 400 degraded, empty-task, and 5xx error states; no worker-card acceptance claim                                                                                          |
| Web typecheck                     | `bun run typecheck` from `packages/app`                                                                                                                                                                                                                                  | App source TypeScript contracts                                                                                                                                                   |
| Web unit tests                    | `bun run test:unit` from `packages/app`                                                                                                                                                                                                                                  | Component, theme preload, font, and model contracts                                                                                                                               |
| Web build                         | `bun run build` from `packages/app`                                                                                                                                                                                                                                      | Production bundle                                                                                                                                                                 |
| UI checks                         | `bun run typecheck`, `bun test src`, and `bun run check:redesign` from `packages/ui`                                                                                                                                                                                     | Token schema, contrast, CSS variables, hardcoded-color guard, and redesign policy                                                                                                 |
| TUI checks                        | `bun run typecheck` and `bun test` from `packages/tui`                                                                                                                                                                                                                   | Theme fallback, renderer, decision, keybind, and reduced-motion contracts                                                                                                         |
| Repository guards                 | `bun run lint`, `bun run check:generated`, `bun run check:packages`, `bun run check:product-copy`, and `bun run docs:check` from the repository root                                                                                                                     | Lint, freshness, package boundaries, copy, and docs                                                                                                                               |

Playwright writes transient evidence to `packages/app/e2e/test-results/redesign-release/`, `packages/app/e2e/test-results/board-gate-off/`, and `packages/app/e2e/test-results/board-gate-on/`. Matching HTML reports are under `packages/app/e2e/playwright-report/`. Screenshot attachments use these stable names:

- `m1-welcome-{dark|light}-{mobile|tablet|desktop}`
- `m2-m5-session-{dark|light}-{mobile|tablet|desktop}`
- `m4-sidebar-{dark|light}-{mobile|tablet|desktop}`
- `m5-composer-working-{dark|light}-{mobile|tablet|desktop}`
- `m3-decision-{dark|light}-{mobile|tablet|desktop}`
- `m1-welcome-{dark|light}-zoom-200`
- `m2-m5-session-{dark|light}-zoom-200`
- `m6-board-{gate-off|degraded|empty|error}`

These are review artifacts, not platform-specific pixel baselines. Retain the Playwright report when release evidence must be archived.

## Screenshot Review Checklist

For every named attachment:

- No blank page, crash dialog, clipped essential action, or document-level horizontal overflow.
- The recorded `data-color-scheme` matches the attachment name and essential text remains readable.
- Focus is visible after the exercised keyboard action; state color is paired with a glyph and text.
- Mobile is below 760px, tablet is 760-1099px, and desktop is at least 1100px.
- M1 shows identity, in-card composer controls, recent resume, and zoned status.
- M2 shows transcript rails/rows and turn metadata; M3 shows live selection and waiting state.
- M4 shows the four session-detail sections and truncation rather than wrapping overflow.
- M5 shows idle and working/interrupt states. Queue presentation is model-tested only because shipped settings currently normalize legacy queue delivery to steer; do not claim a live queued capture.

## Manual Release Checks

Record environment, build, terminal, and observed result. These items remain unsigned until a person runs them:

- TUI: OC2 default, picker live preview/revert, three legacy themes, and a custom theme from `~/.config/oc2/themes/`.
- TUI: dark, light, auto tracking, and lock/unlock persistence.
- TUI: truecolor, 256-color, and 16-color state differentiation; ANSI hues must retain glyph/text equivalents.
- TUI: narrow sidebar overlay, composer, unified/split diff threshold, and the keybind audit, especially `ctrl+o` and scoped `ctrl+e`.
- TUI: `OC2_TUI_REDUCE_MOTION=true` freezes the spinner while labels and live regions still update.
- Web: throttled cold load with a cached non-default theme has no FOUC; old unversioned cache keys clear; switching all 36 themes remains usable.
- Web: fonts render with the network offline and no font request leaves the app origin.
- Web: inspect all named screenshots for obvious blank, crash, clipping, or overflow failures.

## Blocked And Release Criteria

- M6 authoritative worker-card acceptance is P2-blocked. Current team/task APIs do not provide authoritative member role, elapsed time, mailbox count, or permission count. The opt-in tests deliberately stop at gate and state contracts.
- Do not claim commit, mailbox, member, manual TUI, color-depth, FOUC, offline, release, or soak evidence unless the corresponding event was actually run and archived.
- PR K remains a release-soak prerequisite. Remove `newLayoutDesigns` and the legacy token bridge only after the redesign has shipped behind the flag, the release matrix is reviewed, manual TUI/web checks are recorded, and the agreed soak interval completes without a rollback signal.
