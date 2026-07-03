- JS SDK make again: `./packages/sdk/js/script/build.ts`.
- Main branch named `master`. No trust local `main`; diff with `master` or `origin/master`.

## Git

- Commit/PR name like `type(scope): words`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

## Big Rules

1. Think first. No guess. Say tradeoff.
2. Small fix best. No future-magic.
3. Touch little. Clean own mess only.
4. Know done. Check until done.

## Code Style

- One function good unless reuse or hard idea needs name.
- No helper for one tiny thing. No `any`. Avoid `try`/`catch`.
- Use Bun stuff, like `Bun.file()`.
- Let types guess. Export types only when need.
- Prefer `map`/`filter`/`flatMap`; use filter guards.
- Inline one-use values. Use dot access, not needless destructure.
- Prefer `const`; use early return/ternary. No `else` if avoidable.
- Comment only weird rule or surprise.
- `src/config` uses self-export: `export * as ConfigAgent from "./agent"`.

## Imports

- No alias. No star import.
- Need namespace? Import real exported namespace, then use it.
- Heavy/branch-only module: dynamic import inside branch; destructure near use.

## Hard Logic

- Main path easy to read; validation/support helpers below if real concept.
- Sync parse/validate/build stays sync.
- For untrusted JSON use `Schema.UnknownFromJsonString` / `Schema.decodeUnknownOption`, not hand `JSON.parse` in `Effect.try`.

## Drizzle

- Field names snake_case. Prefer `project_id: text().notNull()` over renamed camel columns.

## Test

- Mock little. Test real thing.
- No tests from repo root; run in package dir, e.g. `packages/opencode`.
- Run `bun typecheck` in package dir. No direct `tsc`.

## V2 Session Core

- Prompt admission and model run stay separate: `SessionV2.prompt(...)` writes durable `session_input`, then advisory `SessionExecution.wake(sessionID)` unless `resume: false`.
- Same Session ID adopts old Session. Same prompt ID only exact retry if Session, prompt, delivery mode match.
- `SessionExecution` is process-global and Session-ID based; local drain finds placement via `SessionStore` and `LocationServiceMap.get(session.location)`.
- Interrupt only active local owner chain; idle/missing interrupt no-op.
- Runner, model, tools, permissions, filesystem are Location-scoped; no workspace means implicit local.
- One `llm.stream(request)` per provider turn; reload projected history before durable continue.
- No bridge through legacy `SessionPrompt.loop(...)`; no in-memory tool-loop orchestration.
- Local drains stay process-local until clustering design exists. Coordinator joins same-Session resumes, coalesces wakes, lets different Sessions run together.
- Advisory wake drains eligible inbox only; crash retry needs explicit design.
- Delivery words stay clear: default steer/coalesce at safe boundary; `queue` makes FIFO future activity.
- EventV2 replay claims separate from clustered Session execution ownership.
- System Context algebra/registry/built-ins live in `src/system-context`; Context Sources keep domains; Session owns history selection and Context Epoch persistence.
