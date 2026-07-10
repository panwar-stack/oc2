# Packages Onboarding

`packages/` contains OC2's minimal coding-agent harness, its user interfaces, public extension surfaces, shared libraries, and build/test helpers. Most hosted websites, account services, sharing services, deployment projects, and social integrations are intentionally excluded; the current browser asset fallback is documented below.

Use this guide to find the package that owns a change. Before editing, inspect that package's `package.json`, source, tests, and nearest `AGENTS.md`. Package scripts are the source of truth for commands.

## Product Runtime

| Folder     | Package          | Responsibility                                                                                                                                                               | Change it when                                                                                                                      |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `opencode` | `oc2`            | Primary product package and `oc2` entrypoint. Integrates sessions, agents, tools, providers, permissions, local persistence, commands, TUI, and server modes.                | Changing end-to-end product behavior, the primary CLI, orchestration, tool execution, provider wiring, or local server integration. |
| `core`     | `@oc2-ai/core`   | Shared domain and runtime services for sessions, projects/workspaces, config, auth, providers/models, permissions, tools, filesystem, git, storage, PTY, and system context. | Adding reusable behavior shared by the CLI, TUI, app, server, or product runtime.                                                   |
| `llm`      | `@oc2-ai/llm`    | Provider-neutral model request, protocol, route, transport, streaming event, prompt-caching, and typed tool-dispatch model.                                                  | Implementing or fixing model protocols, provider request/response conversion, streaming, routing, or LLM schemas.                   |
| `server`   | `@oc2-ai/server` | Typed Effect HTTP API groups and handlers for local health, agents, sessions/messages, models/providers, permissions, filesystem, commands, skills, events, and questions.   | Changing local API schemas, handlers, authorization, middleware, or route composition.                                              |

`packages/opencode` is the integration layer. Put reusable domain behavior in `packages/core`, provider-neutral protocol behavior in `packages/llm`, and typed HTTP contracts in `packages/server` rather than duplicating them in the product package.

## User Interfaces And Commands

| Folder | Package       | Responsibility                                                                                                                                 | Change it when                                                                                     |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cli`  | `@oc2-ai/cli` | Effect-based CLI framework with default, service/daemon, serve, migrate, debug, and TUI handlers.                                              | Changing this command runtime, local service management, migration commands, or CLI-to-TUI wiring. |
| `tui`  | `@oc2-ai/tui` | Solid/OpenTUI terminal interface, including prompt/editor UI, dialogs, keymaps, contexts, plugin slots, notifications, and terminal utilities. | Changing terminal UX, rendering, keybindings, dialogs, editor integration, or TUI plugins.         |
| `app`  | `@oc2-ai/app` | Solid/Vite browser interface for local sessions, prompts, terminals, files, settings, and server selection.                                    | Changing browser UX or the local app's interaction with the local backend.                         |
| `ui`   | `@oc2-ai/ui`  | Shared Solid components, themes, styles, icons, rendering helpers, fonts, and audio used by the app and TUI.                                   | Changing reusable visual primitives, shared renderers, theming, or assets.                         |

`oc2 web` and `bun dev web` use the server's browser route. It serves embedded browser assets locally when the generated asset bundle is available. If the bundle is unavailable, or `OC2_DISABLE_EMBEDDED_WEB_UI=true`, the server proxies browser asset requests to `app.oc2.ai`. That fallback requires network access and forwards most incoming request headers, including authorization headers and cookies.

For fully local browser-interface development, run `bun dev serve --port 4096` from the root and `bun run --cwd packages/app dev -- --port 4444` in another terminal. Vite serves the browser assets locally, and the app targets the local server by default.

## SDK And Extensions

| Folder   | Package          | Responsibility                                                                                                                  | Change it when                                                                                |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sdk/js` | `@oc2-ai/sdk`    | JavaScript clients and server helpers generated from the OpenAPI document at `sdk/openapi.json`, plus v2 client/server exports. | Changing generated API types, client behavior, or server helpers used by local API consumers. |
| `plugin` | `@oc2-ai/plugin` | Plugin authoring API for hooks, tools, provider/auth integration, shell helpers, and TUI extensions.                            | Changing what plugins can implement or how extensions interact with OC2.                      |

When an API route or schema changes, regenerate the JavaScript SDK with:

```bash
./packages/sdk/js/script/build.ts
```

Then run `bun run check:generated` from the root and `bun typecheck` from `packages/sdk/js`.

## Shared Infrastructure

| Folder                  | Package                         | Responsibility                                                                                              | Change it when                                                                |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `http-recorder`         | `@oc2-ai/http-recorder`         | Deterministic recording and replay of Effect HTTP and WebSocket traffic for provider and integration tests. | Adding or fixing cassette recording, matching, redaction, or replay behavior. |
| `effect-drizzle-sqlite` | `@oc2-ai/effect-drizzle-sqlite` | Generic vendored Drizzle adapter for Effect SQLite and Effect-yieldable SQLite query builders.              | Changing the generic Drizzle/Effect/SQLite bridge; keep product logic out.    |
| `effect-sqlite-node`    | `@oc2-ai/effect-sqlite-node`    | Node `node:sqlite` implementation used by Node-compatible database paths.                                   | Changing Node SQLite client behavior.                                         |
| `script`                | `@oc2-ai/script`                | Shared build/version/release metadata helpers used by repository scripts.                                   | Changing reusable script metadata or build-target selection.                  |

`runtime` contains local generated dependency/cache artifacts, not maintained source. Do not edit it as a normal package.

## Common Workflows

### Run The Product

From the repository root:

```bash
bun dev .
bun dev serve --port 4096
bun dev web --port 4096
```

### Verify A Package

Run package tests and typechecks in that package, not at the repository root:

```bash
cd packages/<package>
bun typecheck
bun test
```

Not every package defines `test`; check its `package.json` first. Do not run `tsc` directly.

For repository-wide structural verification:

```bash
bun run lint
bun run check:packages
bun run check:generated
bun run typecheck
```

The root `test` script intentionally rejects root-level test runs.

### Choose The Right Layer

1. Start with the package that presents the behavior.
2. Move shared domain rules into `core` only when multiple retained surfaces need them.
3. Keep model protocol and transport concerns in `llm`.
4. Keep HTTP contracts and handlers in `server`.
5. Regenerate the SDK when public API shapes change.
6. Test the real package boundary with minimal mocking.

Do not add or expand hosted fallbacks or external service dependencies. The existing browser asset proxy described above is current compatibility behavior, not a precedent for new owner-service dependencies. Other external network access should be limited to user-configured model providers or integrations.
