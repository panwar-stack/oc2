# Complete OC2 Rebrand

## Goal

Move canonical product branding from `opencode` / `OpenCode` to `oc2` / `OC2` across user-facing surfaces, package metadata, docs, workflows, desktop/app/web copy, and generated SDK artifacts.

The implementation strategy is incremental: first define the allowed compatibility exceptions, then remove stale branding from each surface in reviewable slices. Legacy `opencode` identifiers must remain only where they are explicit compatibility shims, external repo references, or persisted-user-data migration paths.

## Current State

- Root `package.json` is already named `oc2`, but repository URL still points to `https://github.com/panwar-stack/oc2`.
- `packages/opencode/package.json` is named `oc2`, but still publishes both `bin.oc2` and `bin.opencode`.
- `packages/core/package.json` is still named `@opencode-ai/core` and exposes `bin.opencode`.
- Many workspace packages still depend on `@opencode-ai/*`, including `packages/opencode/package.json`, `packages/app/package.json`, `packages/desktop/package.json`, and `packages/web/package.json`.
- `sdks/vscode/package.json` has `displayName: "oc2"` but still uses package name `opencode` and command IDs like `opencode.openTerminal`.
- Docs and README surfaces still contain OpenCode/opencode references, including `README.md`, localized `README.*.md`, `sdks/vscode/README.md`, `packages/desktop/README.md`, and `packages/slack/README.md`.
- GitHub automation still contains legacy names in `.github/workflows/*`, including `/opencode`, `OPENCODE_*`, and `opencode` command references.
- `github/action.yml` is mostly rebranded to `oc2`, but still fetches releases from `anomalyco/opencode` and keeps `/opencode` as a trigger.
- `install` now installs `oc2`, but still downloads from `github.com/panwar-stack/oc2`.
- Desktop metadata is partially rebranded in `packages/desktop/package.json`, but app IDs/updater paths and localized strings still reference OpenCode/opencode in desktop sources.
- App/web/console user-facing copy still includes OpenCode/opencode references in files such as `packages/opencode/src/session/prompt/*.txt`, `packages/app/src/pages/*.tsx`, `packages/web/src/components/Lander.astro`, and console email/auth files.
- Server/config code supports both OC2 and OPENCODE forms, including `.oc2`/`.opencode`, `oc2.json`/`opencode.json`, `OC2_*`/`OPENCODE_*`, and `x-oc2-*`/`x-opencode-*`.
- `packages/sdk/openapi.json` still contains generated OpenCode/opencode descriptions and must be regenerated after source changes.
- PR history found OC-2 theme/UI work, not a comprehensive product rename. OAuth callback branding was recently standardized to “OpenCode”, so it needs explicit correction.

## Non-Negotiables

- Canonical user-facing product name must be `OC2`; lowercase CLI/package brand must be `oc2`.
- Do not remove legacy config/env/header/file compatibility in the first pass unless reviewers explicitly approve the breaking change.
- Legacy `opencode` may remain only in an allowlist with a reason: compatibility shim, historical migration, external repository URL, third-party package name, or test fixture covering legacy compatibility.
- New docs, examples, help text, emails, UI copy, OpenAPI descriptions, and workflow examples must use `oc2`.
- Do not rename persisted app IDs, extension command IDs, package scopes, or release repositories without a migration/compatibility decision.
- Generated artifacts must be regenerated from canonical sources, not hand-edited.
- Each implementation slice must include a fresh read-only adversarial review before it is considered complete.

## Rebrand Policy

Allowed legacy references should be tracked explicitly in a deterministic check.

Proposed allowlist entry shape:

```ts
type LegacyBrandAllowlistEntry = {
  path: string
  pattern: string
  reason: "compatibility" | "migration" | "external-repo" | "third-party" | "test-fixture"
  owner: "core" | "desktop" | "app" | "docs" | "release" | "vscode"
}
```

The check must fail on unallowlisted occurrences of:

```txt
OpenCode
opencode
opencode.ai
api.opencode.ai
app.opencode.ai
docs.opencode.ai
@opencode-ai/
OPENCODE_
x-opencode-
.opencode
opencode.json
```

The check must ignore generated dependency noise such as lockfiles, vendored artifacts, `node_modules`, `dist`, and release history unless the slice intentionally updates them.

## Compatibility Decisions

Default first-pass behavior:

- Keep `oc2` as the canonical CLI binary.
- Keep `opencode` binary aliases temporarily, but stop documenting them.
- Keep `.opencode`, `opencode.json`, `OPENCODE_*`, and `x-opencode-*` support as deprecated compatibility.
- Prefer `.oc2`, `oc2.json`, `OC2_*`, and `x-oc2-*` in docs, help, errors, tests, and examples.
- Keep GitHub repo URLs pointing to `anomalyco/opencode` until repository ownership/name migration is decided.
- Keep VS Code `opencode.*` command IDs until a migration plan for user keybindings is approved, but change package/readme/display copy to OC2.

## Implementation Slices

### PR 1: Add Deterministic Legacy Brand Check

- Add a repo script that scans tracked source/docs/config files for legacy brand terms.
- Add an allowlist with reasoned exceptions for compatibility and external repo references.
- Add a root script entry such as `check:brand`.
- Seed allowlist only with current unavoidable compatibility references.
- Do not change product copy in this PR except where needed to make the check runnable.

Verification:

- `bun run check:brand`
- `bun run lint`

Review:

Use a fresh read-only reviewer to compare the check and allowlist against the rebrand policy. The reviewer must flag broad globs, unexplained exceptions, or allowlist entries that hide user-facing copy.

### PR 2: Docs And Public Copy

- Update `README.md` and localized `README.*.md` to use OC2/oc2 as the canonical brand.
- Update `sdks/vscode/README.md`, `packages/desktop/README.md`, and `packages/slack/README.md`.
- Update install examples to prefer `curl -fsSL https://oc2.ai/install | bash` and `oc2`.
- Remove or rewrite stale `opencode.ai` links where an `oc2.ai` equivalent exists.
- Leave GitHub repository URLs unchanged if they still point to the real repository.

Verification:

- `bun run check:brand`
- `rg -n 'OpenCode|opencode\.ai|api\.opencode\.ai|app\.opencode\.ai|docs\.opencode\.ai' README.md packages sdks github .github`

Review:

Use a fresh read-only reviewer focused on docs accuracy. The reviewer must confirm all remaining legacy terms are allowlisted external links or compatibility notes.

### PR 3: CLI, Config, Server, And Tests Canonical Wording

- Update CLI help, error messages, config docs, and test snapshots to prefer `oc2`, `.oc2`, `oc2.json`, `OC2_*`, and `x-oc2-*`.
- Keep legacy support paths in `packages/core/src/naming.ts`, `packages/opencode/src/config/config.ts`, and `packages/opencode/src/server/**`.
- Ensure tests cover both canonical OC2 behavior and deprecated legacy compatibility.
- Update snapshots under `packages/opencode/test/cli/help/__snapshots__`.

Verification:

- `bun typecheck` from `packages/opencode`
- `bun test test/cli test/config test/server --timeout 30000` from `packages/opencode`
- `bun typecheck` from `packages/core`
- `bun test` from `packages/core`
- `bun run check:brand`

Review:

Use a fresh read-only reviewer to verify no compatibility behavior was removed accidentally. The reviewer must inspect changed tests and confirm legacy references are compatibility assertions, not promoted defaults.

### PR 4: App, Web, Console, OAuth, And Generated SDK

- Update user-facing copy in `packages/opencode/src/session/prompt/*.txt`.
- Update app pages in `packages/app/src/pages/home.tsx`, `packages/app/src/pages/layout.tsx`, and `packages/app/src/pages/error.tsx`.
- Update website copy in `packages/web/src/components/Lander.astro`.
- Update console email/auth copy in `packages/console/mail/emails/templates/InviteEmail.tsx` and `packages/console/function/src/auth.ts`.
- Update OAuth callback branding introduced around the OAuth callback pages to say OC2.
- Regenerate OpenAPI and JS SDK artifacts after source copy changes.

Verification:

- `bun typecheck` from `packages/app`
- `bun run test:unit` from `packages/app`
- `bun run build` from `packages/web`
- `./packages/sdk/js/script/build.ts`
- `bun typecheck` from `packages/sdk/js`
- `bun run check:generated`
- `bun run check:brand`

Review:

Use a fresh read-only reviewer focused on user-visible strings and generated artifacts. The reviewer must confirm `packages/sdk/openapi.json` changes are generated from source updates.

### PR 5: Package Metadata And Internal Workspace Imports

- Rename private workspace package names from `@opencode-ai/*` to `@oc2-ai/*` where safe.
- Update dependent workspace references in `packages/opencode/package.json`, `packages/app/package.json`, `packages/desktop/package.json`, `packages/web/package.json`, and other package manifests.
- Update internal import specifiers only where package names changed.
- Do not rename third-party packages such as `opencode-gitlab-auth` unless replacement packages exist.
- Decide whether `packages/core/package.json` should keep or remove `bin.opencode`; default to keep as compatibility and stop promoting it.

Verification:

- `bun install`
- `bun typecheck` from `packages/opencode`
- `bun typecheck` from `packages/core`
- `bun typecheck` from `packages/app`
- `bun typecheck` from `packages/desktop`
- `bun run check:packages`
- `bun run check:brand`

Review:

Use a fresh read-only reviewer focused on package boundary and dependency correctness. The reviewer must verify no third-party package was renamed by mistake.

### PR 6: VS Code Extension Branding

- Update `sdks/vscode/package.json` package/readme metadata to OC2 where Marketplace compatibility allows.
- Keep `opencode.*` command IDs by default unless a command migration is approved.
- If command IDs are renamed, provide compatibility command registrations for old IDs and document the migration.
- Update extension source in `sdks/vscode/src/extension.ts` to execute `oc2` and show OC2 copy.

Verification:

- `bun run check-types` from `sdks/vscode`
- `bun run lint` from `sdks/vscode`
- `bun run package` from `sdks/vscode`
- `bun run check:brand`

Review:

Use a fresh read-only reviewer focused on VS Code compatibility. The reviewer must check command IDs, keybindings, README examples, and marketplace metadata.

### PR 7: Desktop Identity, Updater Copy, And Release Workflows

- Update desktop user-facing strings under `packages/desktop/src/renderer/i18n/*.ts`.
- Update desktop main/updater copy in `packages/desktop/src/main/**`.
- Review `packages/desktop/electron-builder.config.ts` app IDs, artifact names, and updater repositories.
- Keep app IDs stable by default unless a migration/reinstall plan is approved.
- Update `.github/workflows/*` examples and action names to prefer `oc2`, `OC2_*`, and `/oc2`.
- Keep `/opencode` trigger and `OPENCODE_*` secrets only as deprecated compatibility if still needed.

Verification:

- `bun typecheck` from `packages/desktop`
- `bun run build` from `packages/desktop`
- `bun run check:brand`
- `rg -n '/opencode|OPENCODE_|OpenCode|opencode\.ai' .github packages/desktop`

Review:

Use a fresh read-only reviewer focused on release safety. The reviewer must confirm app identity, updater channels, and workflow secrets are not broken by cosmetic renames.

## Future Work

- Rename the GitHub repository from `anomalyco/opencode` if release assets, installer URLs, and external links can be migrated safely.
- Remove deprecated `opencode` CLI/config/env/header compatibility after a published deprecation window.
- Rename VS Code command IDs from `opencode.*` to `oc2.*` after providing telemetry or migration guidance.
- Publish under only `@oc2-ai/*` once downstream consumers and release automation are confirmed.
- Add release-note automation that rejects new user-facing `OpenCode`/`opencode` branding.

## Open Questions

- Should `opencode` CLI/config/env/header compatibility remain for one major release? Default: yes, keep compatibility but stop documenting it.
- Should the VS Code extension command IDs remain `opencode.*`? Default: yes, because users may have keybindings and settings bound to those IDs.
- Should package scopes move from `@opencode-ai/*` to `@oc2-ai/*` in the first pass? Default: yes for private workspace packages, defer public package migration until release ownership is confirmed.
- Should GitHub repository URLs remain `anomalyco/opencode`? Default: yes until repository rename and release asset redirects are planned.
