# Modern README And User Documentation

## Goal

Refresh `README.md` into a concise, modern entry point for OC2 and document the shipped `oc2` CLI, TUI, and configuration surfaces comprehensively.

Keep the README visually restrained and task-oriented. Move detailed reference material into focused `docs/` pages with one canonical owner for each fact.

## Current State

- `README.md` covers installation, startup, browser behavior, source development, and workspaces, but lacks a structured CLI, TUI, or configuration reference.
- The shipped CLI is registered in `packages/opencode/src/index.ts` and `packages/opencode/src/cli/cmd/`.
- `packages/cli` contains the separate preview `lildax` CLI and must not be presented as the primary product.
- The shipped `oc2` runtime uses the V1 configuration surface from `packages/opencode/src/config/config.ts` and `packages/core/src/v1/config/`.
- TUI configuration and canonical bindings live in `packages/opencode/src/config/tui.ts` and `packages/tui/src/config/keybind.ts`.
- `oc2.example.json` is not currently a valid canonical example:
  - `command.*.prompt` must be `command.*.template`.
  - Local MCP `env` must be `environment`.
- Existing browser documentation conflicts. Runtime code in `packages/opencode/src/server/shared/ui.ts` returns a local `503` when embedded assets are unavailable and does not proxy to a hosted application.
- Existing visual assets are limited. `packages/app/public/social-share.png` is the strongest current README hero candidate; favicons must not be enlarged into branding.
- There is no Markdown lint, internal-link checker, or executable documentation-example validation gate. Documentation-only PRs skip most existing CI checks through `script/ci-scope.ts`.

## Non-Negotiables

- Document only behavior verified from current source, tests, or executable help output.
- Clearly distinguish the shipped `oc2` CLI from preview or internal packages.
- Describe V1 only as the configuration surface used by the shipped CLI. Do not imply that all repository configuration is V1.
- New examples must use `tui.json` or `tui.jsonc` for TUI settings while documenting compatibility with deprecated TUI keys in `oc2.json[c]`.
- Do not claim that npm installation is available unless the package and version are verified from the registry during implementation.
- Do not claim Docker sandboxing as a shipped security boundary.
- Do not include removed `/fast`, Logu, or supervisor behavior.
- Attribute recent work humbly as additions authored in this fork. Git authorship must not be presented as sole conceptual ownership.
- Do not add decorative stock imagery, animated GIFs, large badge collections, or custom HTML that renders poorly on mobile.
- Every implementation slice requires a fresh read-only review against its todo, plan, and `origin/master` before completion.

## README Design

Use this order in `README.md`:

1. Centered product name, short value statement, and one restrained visual.
2. Installation and a minimal first-run example.
3. Six compact feature highlights.
4. Common CLI workflows.
5. Links to TUI, configuration, and extension documentation.
6. Browser and source-development behavior.
7. Contribution and license links.

Visual constraints:

- Default to `packages/app/public/social-share.png` as the single hero image after checking light and dark GitHub themes.
- Use meaningful alt text and a repository-relative path.
- Use no more than three factual badges.
- Prefer whitespace, short headings, compact code blocks, and native Markdown.
- Avoid a large table of contents in the README.
- Verify the layout at narrow and desktop widths using GitHub-compatible Markdown rendering.

## Feature Highlights

The README should use six short bullets under wording such as "Recent additions in this fork include":

- **Agent teams:** persistent shared tasks, dependency-aware workers, plan approval, daemon teammates, and `/use-team` or `/spawn` workflows. Mark the feature experimental or opt-in where appropriate. Sources include `packages/opencode/src/team/` and `packages/opencode/src/command/template/`.
- **Multi-model orchestration:** Local Fusion and the optional Fugu virtual model. Sources include `packages/opencode/src/session/compound/`, `packages/opencode/src/session/llm/fugu.ts`, and `packages/core/src/config/local-fusion.ts`.
- **Repository memory:** opt-in commit and file-summary indexing with CLI and tool access. Source: `packages/opencode/src/memory/`.
- **Multi-root sessions:** attach multiple repository roots while preserving file-tool boundaries. Sources include `packages/opencode/src/session/session.ts` and `packages/tui/src/routes/session/dialog-roots.tsx`.
- **Structural search:** OpenGrep-compatible structural search when available, with ordinary grep fallback. Sources include `packages/opencode/src/tool/opengrep.ts` and `packages/core/src/filesystem/opengrep.ts`.
- **Scalable TUI:** deferred startup and virtualized session, diff, and selection views. Phrase this as implementation behavior, not an unsupported performance benchmark.

## Documentation Structure

Each fact must have one canonical owner. Other pages should link rather than duplicate tables or defaults.

| File                            | Responsibility                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `README.md`                     | Product overview, verified installation, quick start, feature summary, documentation links    |
| `docs/cli.md`                   | Global flags, default invocation, commands, aliases, input/output behavior, advanced commands |
| `docs/tui.md`                   | Home-to-session workflow, prompt modes, permissions, questions, navigation, command palette   |
| `docs/configuration.md`         | V1 CLI configuration files, source order, merge rules, substitutions, managed configuration   |
| `docs/providers.md`             | Provider discovery, authentication, model selection, provider examples                        |
| `docs/agents-permissions.md`    | Agents, permissions, commands, and safe examples                                              |
| `docs/extensions.md`            | MCP, plugins, and skills without repeating configuration precedence                           |
| `docs/reference/environment.md` | Supported environment variables and control flags                                             |
| `docs/reference/keybindings.md` | Complete binding table derived from `packages/tui/src/config/keybind.ts`                      |
| `docs/examples/`                | Executably validated JSON/JSONC and Markdown examples                                         |

Keep V2 configuration architecture or migration notes outside the primary user reference unless users must act on them.

## CLI Documentation

`docs/cli.md` must:

- Derive commands, aliases, and global flags from `packages/opencode/src/index.ts` and `packages/opencode/src/cli/cmd/`.
- Cover the default `oc2 [project]` TUI invocation and common commands including `run`, `attach`, `serve`, `web`, models, provider authentication, agents, sessions, MCP, plugins, memory, import/export, statistics, upgrades, and uninstall.
- Record aliases such as `providers`/`auth` and `plugin`/`plug`.
- Put diagnostic, database, generation, and unstable commands in an Advanced section with a stability warning.
- Document that yargs parsing is strict and help may be written to stderr.
- Cover piped input for `run` and the dependency of `--fork` on `--continue` or `--session`.
- Avoid examples containing literal credentials.

## TUI And Configuration Behavior

The documentation must specify:

- Prompt, shell, configured-command, and slash-command workflows.
- Permission and question interactions.
- Session navigation, multi-root management, and keybinding customization.
- Bindings disabled with `none`.
- New TUI configuration examples use `tui.json[c]`.
- Compatibility behavior for deprecated TUI settings in `oc2.json[c]`.
- The tested configuration source order, including global files, `OC2_CONFIG`, `OC2_TUI_CONFIG`, project files, discovered `.oc2` directories, and `OC2_CONFIG_DIR`.
- JSONC versus JSON selection, root-to-current-directory merging, instruction concatenation, and plugin provenance deduplication.
- `{env:NAME}` and `{file:path}` substitutions.
- Unknown V1 top-level keys fail validation.
- Invalid TUI configuration may be skipped rather than terminating the main configuration load.
- Local and remote MCP examples, including their mutually exclusive URL/command forms.

## Browser And Installation Accuracy

- Release binaries embed browser assets through `packages/opencode/script/build.ts`.
- Missing or disabled embedded assets produce a local `503`; they do not proxy to a hosted application.
- Source development must document the backend plus Vite workflow rather than presenting `bun dev web` as equivalent to a release binary.
- Source installation is the default verified path until npm availability is confirmed with package name and version evidence.

## Documentation Validation

Add a single root command, defaulting to `bun run docs:check`, that:

- Runs Prettier over `README.md` and `docs/**/*.md`.
- Checks repository-relative links and Markdown anchors.
- Parses JSON and JSONC examples.
- Validates `oc2` examples through the shipped V1 schema.
- Validates TUI examples through the real TUI configuration parser.
- Rejects unknown keys and placeholder values that resemble real secrets.
- Handles CLI help output written to either stdout or stderr.

## Implementation Slices

### PR 1: Documentation Validation And Correct Examples

- Add the `docs:check` command and focused validation tooling.
- Correct `oc2.example.json` to use `template` and `environment`.
- Add minimal validated examples:
  - `docs/examples/oc2.minimal.jsonc`
  - `docs/examples/oc2.full.jsonc`
  - `docs/examples/tui.jsonc`
  - Local and remote MCP examples
- Add a repository-relative link and anchor checker.
- Ensure docs-only changes execute the documentation gate in CI.

Verification:

- `bun run docs:check`
- From `packages/opencode`: `bun test test/config/config.test.ts test/config/tui.test.ts`
- `git fetch origin master`
- `git diff --check origin/master...HEAD`

Review:

A fresh read-only reviewer must compare the diff with this slice, confirm examples use real parser paths, and ensure unrelated worktree changes are excluded. Resolve all findings before marking the slice complete.

### PR 2: Canonical CLI, TUI, And Configuration Guides

- Add the documentation structure defined above.
- Generate command and binding tables from source where practical; otherwise add checks that detect drift.
- Resolve browser documentation against `packages/opencode/src/server/shared/ui.ts`.
- Keep advanced/internal commands separate from normal workflows.
- Cross-link canonical pages instead of repeating precedence, defaults, or keybinding tables.

Verification:

- `bun run docs:check`
- From `packages/opencode`: `bun test test/cli/help/help-snapshots.test.ts test/cli/smokes/read-only.test.ts test/config/config.test.ts test/config/tui.test.ts`
- From `packages/tui`: `bun test test/app-lifecycle.test.tsx test/keymap.test.tsx test/config.test.tsx`
- `git diff --check origin/master...HEAD`

Review:

A fresh read-only reviewer must trace representative CLI, TUI, config, and MCP claims to source or tests and flag duplicated or ambiguous ownership of documentation facts.

### PR 3: README And Visual Refresh

- Rewrite `README.md` after all linked documentation exists.
- Add the restrained hero, minimal quick start, six feature highlights, and documentation navigation.
- Remove contradictory browser and installation claims.
- Check all feature attribution against current implementation and Git history.
- Verify rendering on narrow and desktop layouts.

Verification:

- `bun run docs:check`
- `bun run check:product-copy`
- `bunx prettier --check "README.md" "docs/**/*.md"`
- `git diff --check origin/master...HEAD`

Review:

A fresh read-only reviewer must evaluate factual accuracy, attribution, visual restraint, mobile readability, broken links, and whether the README remains concise.

## Future Work

- Automated generation of the full CLI and keybinding references from runtime metadata.
- Dedicated light and dark product screenshots from a deterministic demo session.
- A user-facing V2 configuration migration guide once that surface becomes relevant to shipped workflows.

## Open Questions

- **Hero asset:** Default to the existing social-share image. Create new artwork only if it is inaccurate or unreadable on GitHub.
- **npm installation:** Default to omission until registry availability and the current published version are verified during implementation.
- **Attribution heading:** Default to "Recent additions in this fork" with a modest link to `panwar-stack`, rather than claiming exclusive ownership.
