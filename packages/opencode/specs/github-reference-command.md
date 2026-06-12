# GitHub Reference Command

## Goal

Add a `/reference` command that lets users add a GitHub repository as reusable read-only context from the prompt UI, similar to the existing `/roots` add-directory UX but accepting a GitHub URL instead of a local directory path.

The first pass should reuse the existing reference and repository cache systems. A valid GitHub repo URL such as `https://github.com/Effect-TS/effect` must become a configured reference, clone into the global repo cache once, and be available across sessions through existing `@reference` prompt resolution, read/search tooling, and read-only reference context for lead and teammate sessions.

## Current State

- `/roots` is implemented as a TUI keymap slash command in `packages/tui/src/routes/session/index.tsx` via `SessionRootsCommand()`.
- The roots dialog in `packages/tui/src/routes/session/dialog-roots.tsx` prompts for “Absolute path to directory”, calls `sdk.client.session.root.add(...)`, refreshes roots, and shows success/error toasts.
- TUI slash commands are derived from palette commands in `packages/tui/src/keymap.tsx` through `useCommandSlashes()`.
- References already exist in config:
- `packages/core/src/config/reference.ts` supports `references: Record<string, Entry>`.
- Entries can be `{ repository, branch? }` or `{ path }`.
- `ConfigReference.validateAlias` rejects empty aliases and aliases containing `/`, whitespace, comma, or backtick.
- Existing repository parsing/cache code lives in:
- `packages/core/src/repository.ts`
- `packages/core/src/repository-cache.ts`
- `RepositoryCache.Service.ensure({ reference, branch?, refresh? })` clones to `Global.Path.repos` and reuses cached clones when the remote identity matches.
- `packages/core/src/global.ts` defines `Global.Path.repos` as the durable global clone location under the opencode data directory.
- Existing reference resolution lives in `packages/core/src/project-reference.ts` and `packages/opencode/src/reference/reference.ts`.
- Existing `@reference` UX is in `packages/tui/src/component/prompt/autocomplete.tsx`.
- Prompt submission resolves reference mentions in `packages/opencode/src/session/prompt.ts`.
- V2 model turns load system context through `SystemContextRegistry.Service` in `packages/core/src/session/runner/llm.ts`, so automatically advertised references should be implemented as system context rather than injected into individual prompts.
- Teammate sessions are created from `packages/opencode/src/tool/team_spawn.ts`; the teammate prompt currently includes team goal, member list, communication guidance, dependency results, and the lead-provided role prompt.
- Existing reference API only lists references:
- `packages/opencode/src/server/routes/instance/httpapi/groups/reference.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/reference.ts`

## Non-Negotiables

- `/reference` must accept only GitHub HTTPS repo URLs in the first pass, for example `https://github.com/Effect-TS/effect`.
- `/reference` must reject non-GitHub hosts, local paths, `file:` URLs, SCP-style remotes, and shorthand like `Effect-TS/effect` unless explicitly added later.
- Clones must go under `Global.Path.repos`; do not add project/session DB rows, workspace rows, or a new cache directory.
- Clone reuse must be handled by existing repository cache identity and locking; do not add a second clone tracker.
- References must be durable across sessions by persisting them in config-backed references, not session-local state.
- Reference roots must remain read-only managed context. Do not allow edit/write tools to modify cached repos.
- Configured references must be advertised to both lead sessions and teammate sessions as read-only reference context.
- Teammate sessions must inherit visibility of configured references from the same project/location as the lead session; do not copy clone state or create teammate-specific reference records.
- Existing configured references and `@reference` behavior must continue working.
- Leave branch selection, refresh controls, delete/rename UI, and non-GitHub hosts out of the first pass unless needed by implementation.

## Command UX

Add a TUI slash command:

```text
/reference
```

Expected first-pass flow:

- User types `/reference`.
- TUI opens a dialog similar to `/roots`.
- Dialog lists existing configured references.
- Dialog includes an “Add reference” action.
- “Add reference” prompts for:

```text
GitHub repository URL
```

- Empty input closes back to the reference dialog without mutation.
- Invalid input shows a toast with a clear validation error.
- Valid input creates or updates a configured reference and triggers clone/cache materialization.
- Success toast should say `Reference added`.
- The new reference should become available through existing `@alias` autocomplete and prompt attachment behavior.

Alias default:

- Derive the default alias from the GitHub repo name.
- `https://github.com/Effect-TS/effect` defaults to alias `effect`.
- If alias conflicts, reject with a message like `Reference already exists: effect`.
- Do not auto-generate `effect-2` in the first pass.

## API And Data Shape

Add a mutation endpoint beside the existing reference list endpoint.

Suggested route:

```http
POST /reference
```

Payload:

```ts
{
  url: string
  alias?: string
}
```

Response:

```ts
{
  alias: string
  repository: string
  path: string
}
```

Behavior:

- Validate `url` as a GitHub HTTPS URL with exactly an owner and repo path.
- Normalize trailing `.git` away for alias derivation and cache identity only if existing repository utilities already support it.
- Persist config entry as:

```ts
{
  references: {
    [alias]: {
      repository: "https://github.com/Effect-TS/effect"
    }
  }
}
```

- Call existing repository cache materialization after persisting or as part of the same domain operation.
- If clone fails, return a mutation error and do not leave a broken reference entry in config.
- If config write succeeds but cache materialization fails due to network, prefer returning the error and rolling back the config entry in the first pass.

## Validation

GitHub URL validation must reject:

- `https://gitlab.com/owner/repo`
- `https://github.com/owner`
- `https://github.com/owner/repo/issues`
- `git@github.com:owner/repo.git`
- `github:owner/repo`
- `/tmp/repo`
- `file:///tmp/repo`

Accepted shape:

```text
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>.git
```

Recommended parser behavior:

- Use `new URL(input)` for first-pass GitHub URL shape checks.
- Then pass the normalized URL into existing repository parsing/cache code.
- Use existing alias validation from `ConfigReference.validateAlias`.

## Storage

- Use existing `Global.Path.repos` from `packages/core/src/global.ts`.
- Use existing `Repository.cachePath(...)` and `RepositoryCache.Service.ensure(...)`.
- Do not store cloned repository paths in session rows.
- Do not create `project`, `project_directory`, `workspace`, or `session_root` records for references.
- The durable record is the config `references` entry; the clone cache is an implementation detail.

## Session Reference Context

Configured references must be available to model sessions even when the user does not explicitly type `@alias` in the prompt.

Implement this as a read-only system context source:

- Register a context source through the existing system context registry used by `packages/core/src/session/runner/llm.ts`.
- Load configured references for the active project/location.
- Include only small metadata in the prompt context, not repository file contents.
- Include alias, repository URL, optional branch, and the managed read-only access pattern.
- Materialize missing GitHub references before advertising them when possible; if materialization fails, include the alias with an invalid/unavailable reason instead of failing the whole session turn.
- Keep context deterministic by sorting aliases lexicographically.
- Keep the context concise and bounded; do not enumerate files or run searches during context loading.

Suggested context shape:

```text
Configured read-only references:
- effect: https://github.com/Effect-TS/effect, use @effect or read/search tools with reference "effect"
```

Lead session behavior:

- Lead sessions must see configured references in system context for the active project/location.
- Lead sessions may use read/search tools against managed reference paths without external-directory approval when existing reference containment checks allow it.
- Lead sessions must not receive write/edit permissions for cached reference repos.

Teammate session behavior:

- Teammate sessions spawned through `packages/opencode/src/tool/team_spawn.ts` must see the same configured reference context as the lead session.
- Teammate prompts should not duplicate the full reference list if the system context source already provides it.
- Teammates may read/search configured references as read-only context.
- Plan-mode teammates must still be blocked from mutation tools by the existing plan-mode tool restrictions.
- Teammates must not be able to mutate cached reference repos even when not in plan mode.

Failure behavior:

- If a configured reference is invalid, keep the model-facing context entry short and actionable, for example `effect: unavailable, invalid repository URL`.
- If clone materialization is slow or offline, do not block unrelated configured local references from being advertised.
- Do not wake or spawn teammates only to materialize references.

## Implementation Slices

### PR 1: Reference Mutation API

- Add a reference mutation domain function that accepts `{ url, alias? }`.
- Validate GitHub HTTPS URL shape.
- Derive alias from repo name when `alias` is omitted.
- Reject duplicate aliases.
- Persist the entry to config-backed `references`.
- Materialize the repo through the existing repository cache.
- Add `POST /reference` to `packages/opencode/src/server/routes/instance/httpapi/groups/reference.ts`.
- Add handler logic in `packages/opencode/src/server/routes/instance/httpapi/handlers/reference.ts`.
- Add tests for valid GitHub URL, invalid host, invalid path depth, duplicate alias, and clone/cache reuse.

Verification:

- From `packages/opencode`: `bun test test/reference/reference.test.ts`
- From `packages/opencode`: `bun test test/server/httpapi-reference.test.ts test/server/httpapi-public-openapi.test.ts`
- From `packages/opencode`: `bun test test/config/config.test.ts`
- From `packages/opencode`: `bun typecheck`
- If SDK types change: `./packages/sdk/js/script/build.ts`

Review:

A fresh read-only reviewer must compare the diff against this slice and verify that no new cache directory, session DB table, or custom Git clone tracker was introduced.

### PR 2: TUI `/reference` Command And Dialog

- Add a TUI command beside `SessionRootsCommand()` in `packages/tui/src/routes/session/index.tsx`.
- Register it with `slashName: "reference"` and title `Manage references`.
- Add a dialog modeled after `packages/tui/src/routes/session/dialog-roots.tsx`.
- List existing references from `sdk.client.reference.list(...)`.
- Add an “Add reference” action that prompts for `GitHub repository URL`.
- Call the new `sdk.client.reference.add(...)` endpoint.
- Show success and error toasts.
- Refresh reference data after successful add.

Verification:

- From `packages/tui`: `bun test test/keymap.test.tsx test/config.test.tsx test/cli/tui/dialog-prompt.test.tsx`
- From `packages/tui`: `bun typecheck`
- From `packages/opencode`: `bun test test/cli/cmd/tui/session-roots-command.test.tsx`
- From `packages/opencode`: `bun typecheck`

Review:

A fresh read-only reviewer must verify that the UX follows the existing `/roots` dialog pattern and that validation failures are surfaced without submitting prompt text.

### PR 3: Prompt Integration And Regression Coverage

- Verify that newly added references appear in existing `@reference` autocomplete through `packages/tui/src/component/prompt/autocomplete.tsx`.
- Verify prompt submission resolves the new reference through `packages/opencode/src/session/prompt.ts`.
- Add or extend tests to cover a reference added by the mutation endpoint being available through list and prompt resolution.
- Confirm read/search tools can access the managed reference path through existing reference containment checks.
- Confirm write/edit tools still cannot modify cached reference repos.

Verification:

- From `packages/opencode`: `bun test test/session/prompt.test.ts`
- From `packages/opencode`: `bun test test/tool/read.test.ts test/tool/glob.test.ts`
- From `packages/opencode`: `bun test test/reference/reference.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

A fresh read-only reviewer must verify that reference repos remain read-only context and that no prompt-resolution behavior regressed for existing configured local or Git references.

### PR 4: Lead And Teammate Reference Context

- Add a system context source for configured references using the registry loaded by `packages/core/src/session/runner/llm.ts`.
- Include configured reference aliases and GitHub repository URLs in lead session context without embedding repository contents.
- Ensure teammate sessions created by `packages/opencode/src/tool/team_spawn.ts` receive the same reference context through normal session system context loading.
- Avoid duplicating the reference list in teammate role prompts when system context already supplies it.
- Add tests that a lead session with configured references receives the reference context.
- Add tests that a spawned teammate session receives the same configured reference context.
- Add tests that invalid or unavailable references are advertised with a short unavailable reason and do not fail the provider turn.
- Add tests that read/search access works for configured references while write/edit access remains denied for cached reference repos.

Verification:

- From `packages/opencode`: `bun test test/reference/reference.test.ts`
- From `packages/opencode`: `bun test test/session/prompt.test.ts`
- From `packages/opencode`: `bun test test/tool/read.test.ts test/tool/glob.test.ts`
- From `packages/opencode`: `bun test test/tool/team_spawn.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

A fresh read-only reviewer must verify that configured references appear in both lead and teammate session context, that no repository contents are eagerly injected into prompts, and that cached reference repos remain read-only.

## Failure Modes

- Invalid URL: return a deterministic validation error before config mutation.
- Duplicate alias: reject before clone.
- Clone failure: return a clear error and avoid leaving a configured reference that points to an unavailable clone.
- Existing cache with same GitHub identity: reuse it and avoid recloning.
- Existing cache with mismatched origin at the same path: rely on existing repository cache stale-cache handling.
- Concurrent adds for the same repo: rely on existing repository cache locking.
- Invalid configured reference during context load: include a concise unavailable entry and continue the session turn.
- Teammate spawn with configured references: inherit reference visibility through session/system context, not copied prompt text or teammate-specific storage.

## Future Work

- Add `/reference remove`.
- Add `/reference refresh`.
- Add explicit alias prompt or `/reference add <alias> <url>`.
- Add branch selection.
- Support GitHub shorthand like `Effect-TS/effect`.
- Support other Git hosts after validation and security rules are explicit.
- Add app/web prompt UI parity if the initial implementation is TUI-only.
- Add per-agent or per-team controls for which configured references are advertised automatically.

## Open Questions

- Should `/reference` be TUI-only in the first pass, or should CLI run prompt and web app also expose it immediately? Default: TUI-only first, because the requested UX matches existing `/roots`.
- Should failed clone roll back the config entry? Default: yes, to avoid showing a broken reference immediately after “add”.
- Should aliases be user-editable during add? Default: not in first pass; derive from repo name and reject conflicts.
