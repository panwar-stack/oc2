# HttpApi Route Patterns

## Endpoint Ownership

Default new endpoints to `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}` when they depend on opencode app/runtime services, instance state, workspace routing, PTY/TUI/UI behavior, MCP, config, project control, or legacy public API shaping.

Use `packages/server/src/{groups,handlers}` only for endpoints that belong to the reusable `@oc2-ai/server` API surface: core-backed, standalone-mountable, and not dependent on `@/` opencode app imports.

When a domain exists in both places, choose by dependency ownership and lifecycle rather than domain name. `server.ts` mounts both the local `RootHttpApi`/`InstanceHttpApi` routes and `@oc2-ai/server` `Api`/`handlers`; do not duplicate an endpoint in both trees.

## Handler Patterns

Use `HttpApiBuilder.group(...)` for normal HTTP endpoints, including streaming HTTP responses such as server-sent events. Handlers should yield stable services once while building the handler layer, then close over those services in endpoint implementations.

```ts
export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("list", () => session.list())
  }),
)
```

For SSE endpoints, stay in `HttpApiBuilder.group(...)` and return `HttpServerResponse.stream(...)` from the handler. Annotate the endpoint success schema with `HttpApiSchema.asText({ contentType: "text/event-stream" })` so OpenAPI documents the stream content type.

Use `HttpApiBuilder.group(...)` with `handleRaw(...)` for declared endpoints that need the raw request or response, including WebSocket upgrade routes. This keeps endpoint middleware, routing context, and OpenAPI metadata on one typed route tree.

```ts
export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service

    return handlers.handleRaw("connect", (ctx) => connectPty(ctx.request, pty))
  }),
)
```

Use raw `HttpRouter.use(...)` only for routes outside the declared API surface, such as a catch-all UI fallback.

Avoid `Effect.provide(SomeLayer)` inside request handlers or raw route callbacks. Stable layers should be provided once at the application/layer boundary, not rebuilt or scoped per request.

Avoid `HttpRouter.provideRequest(...)` unless the dependency is intentionally request-level. Prefer `HttpRouter.use(...)` for stable app services.

Use `Effect.provideService(...)` in middleware only for request-derived context, such as `WorkspaceRouteContext`, `InstanceRef`, or `WorkspaceRef`. Do not use it to smuggle stable services through request effects when they can be yielded at layer construction.

Public JSON errors should be explicit `Schema.ErrorClass` contracts declared on each endpoint. Use built-in `HttpApiError.*` classes only when their empty/tagged body is the intended wire shape; for SDK-visible errors with messages, define an API error schema such as `ApiNotFoundError` and fail with that exact declared error. Keep domain and storage services free of HttpApi types, and translate expected domain errors at the handler boundary.

When adding middleware, declare endpoint-contract middleware on the owning `HttpApiGroup` and provide its implementation layer at the assembly boundary in `server.ts`. Keep router middleware for truly raw fallback routes or global transport policy.
