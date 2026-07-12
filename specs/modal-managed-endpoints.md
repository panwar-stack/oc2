# OC2-Managed Modal Endpoints

## Goal

Add Modal as a legacy TUI LLM provider without asking users for endpoint URLs or endpoint proxy tokens.

`/connect` installs and authenticates the Modal CLI when needed, asks only for the Modal environment, and creates the endpoint proxy token. Selecting a Modal model creates or reuses an OC2-owned endpoint, waits until it serves that model, and selects it only when ready. OC2 also lists and permanently stops endpoints it created.

## Scope

First release supports:

- Legacy TUI `/connect` and `/models`.
- Browser-based `modal setup`.
- Headless `modal token set` as a fallback.
- One Modal environment per connection.
- OC2-created endpoint proxy tokens.
- OC2-created authenticated endpoints.
- A small built-in Modal model catalog plus configured Hugging Face model IDs.
- Durable endpoint reuse across OC2 restarts.
- Explicit stop actions through OC2.
- OpenAI-compatible Chat Completions.

First release does not support:

- User-entered endpoint URLs.
- User-entered endpoint proxy tokens.
- Adopting or stopping endpoints not created by this OC2 installation.
- App, Session V2, or Core V2 provider support.
- Unauthenticated endpoints.
- Custom Hugging Face or Modal Volume weights.
- Automatic stop on process exit.
- Responses API, tools, attachments, reasoning, or non-text modalities.
- Modal sandboxes.

## Current State

- `/connect` opens `DialogProvider` through `packages/tui/src/app.tsx:730-741`.
- `/models` opens `DialogModel` through `packages/tui/src/app.tsx:608-622`.
- Model selection currently commits synchronously in `packages/tui/src/component/dialog-model.tsx:118-130`.
- Provider state is instance-scoped in `packages/opencode/src/provider/provider.ts`.
- Instance disposal occurs during reconnect, configuration reload, and worker shutdown, so it cannot own remote endpoint lifetime.
- Global credentials are persisted in `auth.json` with mode `0600` by `packages/opencode/src/auth/index.ts`.
- TUI model recents and favorites do not contain remote resource ownership data.
- Modal endpoint creation requires only `--model`; name and environment are optional CLI inputs (`tmp/modal endpoint.md:55-74`).
- Creation starts asynchronous provisioning and prints an endpoint ID and dashboard link (`tmp/Endpoints.md:41-51`).
- `modal endpoint list --json` lists provisioning and running endpoints, but its JSON schema is undocumented (`tmp/modal endpoint.md:76-90`).
- `modal endpoint stop -y` permanently terminates an endpoint (`tmp/modal endpoint.md:92-106`).
- Modal account setup is `modal setup`; headless credentials can be entered through `modal token set` (`tmp/modal_setup.md:35-70`).
- HTTP inference requires a workspace proxy-token pair created with `modal workspace proxy-tokens create` (`tmp/Endpoints.md:56-81`).

## Non-Negotiables

- Do not prompt for an endpoint URL.
- Do not prompt for `Modal-Key` or `Modal-Secret`.
- OC2 must create, store, and use endpoint proxy tokens.
- OC2 must use an explicit environment for create, list, allow, and stop commands.
- Selecting the same deployment concurrently must create at most one endpoint.
- Never retry an ambiguous create automatically.
- Never infer ownership from endpoint name, model, URL, or Modal listing.
- Never stop an endpoint without durable local creation provenance and its exact endpoint ID.
- Normal process exit, instance disposal, reconnect, or configuration reload must not stop endpoints.
- Endpoint creation must show that Modal compute may be billed.
- Scale-to-zero is not termination.
- All CLI parsers must be fixture-backed against one pinned Modal version.
- Every slice requires a fresh read-only diff review before completion.

## Minimal `/connect` Flow

`/connect` must not use the generic API-key prompt.

The Modal connection flow is:

1. Resolve the OC2-managed Modal CLI.
2. If absent, ask for installation consent.
3. Check whether the managed CLI has an authenticated Modal profile.
4. If unauthenticated, offer:
   - `Open browser with modal setup` as the default.
   - `Enter Modal token in terminal` using `modal token set`.
5. Ask for one environment:
   - Default to `MODAL_ENVIRONMENT` when set.
   - Otherwise default the prompt to `main`.
6. Verify CLI access using an environment-scoped, non-mutating command.
7. Run `modal workspace proxy-tokens create`.
8. Persist the returned one-time proxy token immediately.
9. Run `modal workspace proxy-tokens allow <token-id> <environment>`.
10. Mark Modal connected and open the Modal-scoped model picker.

The user supplies no endpoint-specific information.

### Prompts

Installation consent:

```text
Install Modal CLI 1.5.2 in OC2's cache?
This uses an isolated Python environment and does not modify system Python or PATH.
```

Authentication method:

```text
Connect your Modal account

1. Open browser with modal setup
2. Enter Modal token in terminal
```

Environment:

```text
Modal environment
Default: main
```

Connection confirmation:

```text
OC2 will create and manage authenticated Modal endpoints in environment "<environment>".
Creating an endpoint may incur Modal compute charges.
```

## Managed Modal CLI

Pin the first supported contract to:

```text
modal==1.5.2
Python >=3.10,<3.15
```

Add `packages/core/src/modal-cli.ts` with:

```ts
type ModalCommand = {
  argv: readonly [python: string, "-m", "modal"]
  env: {
    MODAL_CONFIG_PATH: string
  }
}

resolve(): Effect<Option<ModalCommand>, ModalCliError>
install(): Effect<ModalCommand, ModalCliError>
run(
  command: ModalCommand,
  args: readonly string[],
): Effect<ModalProcessResult, ModalCliError>
```

Managed paths:

```text
Venv:   <Global.Service.cache>/modal-cli/1.5.2/venv
Marker: <venv>/.oc2-ready.json
Config: <Global.Service.data>/modal/config.toml
```

Installation must:

1. Resolve `python3`, then `python` on Unix.
2. Resolve `py -3`, then `python`, then `python3` on Windows.
3. Validate the supported Python range.
4. Acquire a cross-process installation lock.
5. Run `<python> -m venv <venv>`.
6. Run:

```text
<venv-python> -m pip install --disable-pip-version-check --no-input modal==1.5.2
```

7. Verify the installed package version.
8. Verify `<venv-python> -m modal --version`.
9. Write the readiness marker only after verification.

OC2 must not install Python, invoke unqualified `pip`, modify `PATH`, install globally, or write the user's default Modal configuration.

## Modal CLI Contract Fixtures

Before production parsing, capture sanitized output for Modal `1.5.2` under:

```text
packages/opencode/test/fixture/modal-cli/1.5.2/
```

Fixtures must cover:

- `modal --version`
- `modal setup --help`
- `modal token set --help`
- active-profile identification
- `modal workspace proxy-tokens create`
- successful and failed `proxy-tokens allow`
- `modal endpoint create`
- `modal endpoint list --json`
- `modal endpoint stop -y`
- authentication failures
- nonzero exits

Requirements:

- Record stdout, stderr, and exit status.
- Remove account names, tokens, endpoint URLs, and dashboard identifiers.
- Decoders must reject schema drift.
- Do not infer absence or stopped state from an empty endpoint list.
- The create decoder must extract an exact endpoint ID. If it cannot, creation becomes uncertain.

## Credential Model

Modal has two separate credential domains:

1. Modal account credentials used by the managed CLI.
2. Endpoint proxy credentials used for inference.

CLI credentials remain only in the managed Modal configuration.

Persist endpoint proxy credentials through the existing Modal auth entry:

```ts
{
  type: "api",
  key: "",
  metadata: {
    environment: "main",
    proxyTokenID: "wk-...",
    proxyTokenSecret: "ws-...",
    connectionGeneration: "1"
  }
}
```

The structural `key` remains empty so no secret is copied into public `Provider.Info.key`.

Requirements:

- Persist the one-time proxy secret before considering token creation successful.
- Do not include the secret in the endpoint ledger.
- Do not pass the secret through CLI arguments.
- Do not log command environments containing credentials.
- A connection replacement must validate its new proxy token before replacing the old one.
- Proxy-token revocation is future work because the supplied docs do not define it.

## Model Catalog

Modal has no documented programmatic pre-deployment model catalog. `/v1/models` exists only after an endpoint is live.

Add a built-in legacy Modal provider with an initial, reviewed list of model IDs demonstrated by the supplied docs:

```text
Qwen/Qwen3.5-4B
Qwen/Qwen3.6-27B
Qwen/Qwen3.6-27B-FP8
```

Allow additional Hugging Face repository IDs through existing legacy provider model configuration.

Requirements:

- Modal must appear in `/connect` before authentication.
- Modal models must appear in `/models` only after connection succeeds.
- Provider description must be `Modal`.
- Preserve `{ providerID: "modal", modelID }` as selection identity.
- The same model hosted elsewhere remains differentiated by provider.
- Duplicate display names within Modal must include the model ID.
- Do not claim the named Modal model families form a complete discoverable catalog.

## Endpoint Deployment Specification

First-pass deployment input is:

```ts
type ModalDeploymentSpec = {
  model: string
}
```

The deployment fingerprint is:

```text
sha256(
  proxy-token-id +
  NUL +
  environment +
  NUL +
  canonical-json(deployment-spec)
)
```

Future deployment flags such as revision, custom weights, routing region, or colocation must become part of the canonical specification before they are supported.

Every create command must use explicit values:

```text
modal endpoint create \
  --env <environment> \
  --name <oc2-generated-name> \
  --model <hugging-face-repository-id>
```

Do not use a positional name or Modal's derived default name.

Generated names must be unique to the local creation record:

```text
oc2-<installation-id-prefix>-<record-id-prefix>
```

Name length and character constraints must be validated by the pinned CLI fixture before implementation.

## Durable Endpoint Ledger

Add a process-global `ModalEndpoint.Service` in:

```text
packages/opencode/src/provider/modal.ts
```

Do not store endpoint ownership in `InstanceState`, TUI model state, recents, or favorites.

Persist atomically under the global data directory:

```text
<Global.Path.data>/modal/endpoints.json
```

Use a sibling lock file, temporary-file write, filesystem sync, and atomic rename.

```ts
type ModalEndpointState = {
  version: 1
  installationID: string
  endpoints: Record<string, ModalEndpointRecord>
}

type ModalEndpointRecord = {
  recordID: string
  generation: number
  ownershipKey: string
  connectionGeneration: number
  proxyTokenID: string
  environment: string
  specification: {
    model: string
  }
  endpointName: string
  endpointID?: string
  endpointURL?: string
  dashboardURL?: string
  phase:
    | "intent"
    | "create_uncertain"
    | "provisioning"
    | "ready"
    | "unhealthy"
    | "stopping"
    | "stop_uncertain"
    | "stopped"
  createStartedAt: number
  updatedAt: number
  stoppedAt?: number
  lastErrorCode?: string
}
```

The ledger must never contain:

- Proxy-token secrets.
- Modal account credentials.
- Raw CLI output.
- Raw HTTP response bodies.
- Authorization headers.

Stopped tombstones must be retained so an old endpoint ID cannot be mistaken for a new owned resource.

## Creation And Reuse

Selecting a Modal model calls:

```ts
ensureEndpoint({
  modelID,
  environment,
  connectionGeneration
})
```

Algorithm:

1. Compute the deployment fingerprint.
2. Acquire a cross-process lock keyed by the fingerprint.
3. Re-read the ledger.
4. Reuse an exact matching `ready`, `provisioning`, or recoverable record.
5. If no record exists, write an `intent` record before invoking Modal.
6. Run the explicit create command.
7. Persist the exact endpoint ID immediately after parsing it.
8. Mark the record `provisioning`.
9. Release the creation lock before readiness polling.
10. Reconcile only by the recorded exact endpoint ID.
11. Obtain its URL from the pinned `endpoint list --json` decoder.
12. Probe the authenticated `/v1/models`.
13. Verify that the selected model ID is served.
14. Mark the endpoint `ready`.
15. Commit the model selection.

Concurrent callers for the same fingerprint must join the existing operation. Different model fingerprints may provision concurrently.

### Ambiguous Creation

If the CLI times out, exits ambiguously, crashes, or produces output without an exact endpoint ID after remote submission may have occurred:

- Persist `create_uncertain`.
- Do not run create again.
- Do not adopt an endpoint merely because its name or model matches.
- Show the generated name and dashboard information when available.
- Offer reconciliation and explicit user review through the managed-endpoint dialog.

Killing the local CLI process does not prove the remote creation was cancelled.

## Readiness

Create completion is not readiness.

Poll with bounded exponential backoff and jitter:

1. Run `modal endpoint list --json --env <environment>`.
2. Find the locally recorded exact endpoint ID.
3. Extract its URL using the pinned decoder.
4. Request:

```http
GET <endpoint-url>/v1/models
Modal-Key: <proxy-token-id>
Modal-Secret: <proxy-token-secret>
```

5. Verify the selected model ID is returned.

Defaults:

- Individual CLI and HTTP timeout: 30 seconds.
- Initial delay: 2 seconds.
- Maximum delay: 15 seconds.
- Overall provisioning wait: 10 minutes.

Retry:

- Network failures.
- Cold-start failures.
- `429`.
- Transient `5xx`.
- Documented provisioning statuses from the pinned fixture.

Do not retry:

- `401` or `403`.
- Malformed CLI output.
- Malformed `/v1/models`.
- A ready endpoint serving the wrong model.

A readiness timeout leaves the endpoint recoverable as `provisioning` or `unhealthy`. It must not cause another create or automatic stop.

## Model Selection UX

Modal model selection must not call `local.model.set(...)` immediately.

Add:

```text
packages/tui/src/component/dialog-modal-endpoint.tsx
```

Flow:

1. If an exact `ready` endpoint exists, reuse it without prompting.
2. Otherwise show:

```text
Create Modal endpoint for <model> in <environment>?
Modal may bill compute while containers are running.
Idle endpoints scale to zero, but remain deployed until stopped.
```

3. On confirmation, call `ensureEndpoint`.
4. Show creation, provisioning, readiness, endpoint ID, and dashboard link.
5. Selecting `Esc` stops local waiting only.
6. Do not imply that cancelling the dialog stopped remote provisioning.
7. Commit the selected model only after readiness succeeds.
8. Retrying selection rejoins the durable record rather than creating another endpoint.

The provider runtime must reject a Modal model without a ready managed endpoint. It must not create resources silently outside the confirmed selection flow.

## Runtime Inference

Resolve the selected endpoint from the durable record and use:

```ts
createOpenAICompatible({
  name: "modal",
  baseURL: `${endpointURL}/v1`,
  apiKey: "",
  fetch: modalFetch
})
```

`modalFetch` must:

- Re-read the current proxy credential.
- Verify that the request origin matches the recorded endpoint origin.
- Reject redirects.
- Remove generated `Authorization`.
- Overwrite caller-provided Modal headers.
- Inject `Modal-Key` and `Modal-Secret`.
- Never include credentials in errors or logs.

Modal must remain unsupported by the experimental native runtime so this fetch wrapper cannot be bypassed.

## Endpoint Management And Stop

Add a TUI command:

```text
/modal
```

It opens a managed-endpoint dialog listing local records by:

- Model.
- Environment.
- Phase.
- Endpoint ID.
- Dashboard link.
- Last observation.

Only records with local creation provenance are shown as stoppable.

Also add:

```text
oc2 providers modal endpoints
oc2 providers modal stop <record-id>
oc2 providers modal stop --all
```

Permanent stop requires confirmation unless `--yes` is supplied.

Stop algorithm:

1. Acquire the record lock.
2. Verify the installation ID, generation, connection generation, environment, and exact endpoint ID.
3. Verify the current Modal account/profile matches the recorded account context.
4. Reconcile the exact ID through the pinned list decoder.
5. Persist `stopping`.
6. Run:

```text
modal endpoint stop -y --env <environment> <exact-endpoint-id>
```

7. Reconcile the result.
8. Persist a `stopped` tombstone.

Rules:

- Never stop by name, URL, model, or list position.
- Never adopt a discovered endpoint as managed.
- Repeated stopping of a confirmed tombstone is a local no-op.
- Ambiguous stop results become `stop_uncertain`.
- Do not assume stop retries are idempotent.
- Block selection of a record while it is stopping.
- Warn that stopping interrupts active users of that endpoint.

## Disconnect Behavior

Disconnecting Modal while managed endpoints remain must offer:

```text
Modal has <count> managed endpoints.

1. Stop all managed endpoints and disconnect
2. Cancel
```

Do not remove proxy credentials while nonterminal records remain.

If any stop is uncertain or fails:

- Keep Modal connected.
- Keep credentials available for recovery.
- Show the affected record IDs.
- Do not silently orphan the endpoints.

## Process Exit And Reuse

Normal TUI exit, worker shutdown, instance disposal, authentication bootstrap, and configuration reload must:

- Cancel local polling processes.
- Flush durable state.
- Leave remote endpoints running or scaled to zero.
- Issue no stop command.

This is intentional:

- Modal endpoints scale idle compute to zero (`tmp/Endpoints.md:176-181`).
- Permanent stop is destructive.
- Process crashes cannot guarantee cleanup.
- Durable reuse avoids repeated provisioning.

OC2 "handles stopping" through the explicit `/modal`, CLI, and disconnect flows, not through unreliable process-finalizer cleanup.

## Implementation Slices

### PR 1: Pinned Modal CLI And Contract

- Add the isolated Modal CLI installer.
- Pin Modal `1.5.2`.
- Capture sanitized CLI contract fixtures.
- Add strict decoders for setup, profile, proxy-token, create, list, and stop output.
- Reject unsupported output rather than guessing.

Verification:

- From `packages/core`: `bun test test/modal-cli.test.ts test/modal-cli-concurrency.test.ts`
- From `packages/core`: `bun run typecheck`
- From `packages/opencode`: `bun test test/provider/modal-cli-contract.test.ts`
- From `packages/opencode`: `bun run typecheck`

Review:

A fresh read-only reviewer must verify version pinning, fixture sanitization, Python isolation, exact subprocess arguments, schema-drift failure, concurrency, and global-environment safety.

### PR 2: Minimal Modal Connection

- Add Modal to legacy `/connect`.
- Install and authenticate the managed CLI.
- Support browser setup and terminal token setup.
- Prompt only for the environment.
- Create and persist the workspace proxy token.
- Allow the token in the selected environment.
- Preserve management and inference credential separation.
- Refuse credential removal while managed endpoints remain.

Verification:

- From `packages/opencode`: `bun test test/provider/modal-auth.test.ts test/auth/auth.test.ts test/server/httpapi-provider.test.ts`
- From `packages/opencode`: `bun run typecheck`
- From `packages/tui`: `bun test test/cli/cmd/tui/modal-connect.test.tsx test/cli/cmd/tui/provider-options.test.ts`
- From `packages/tui`: `bun run typecheck`

Review:

A fresh read-only reviewer must verify that no endpoint or proxy-token prompt exists, one-time secrets are persisted before proceeding, failed connection preserves prior credentials, and no credentials appear in logs or public provider responses.

### PR 3: Modal Catalog And Picker Identity

- Add the built-in legacy Modal provider and reviewed initial models.
- Allow additional configured Hugging Face repository IDs.
- Show models only after Modal is connected.
- Preserve exact Hugging Face IDs.
- Differentiate Modal from other providers.
- Handle duplicate display names.

Verification:

- From `packages/opencode`: `bun test test/provider/modal-provider.test.ts test/provider/provider.test.ts`
- From `packages/opencode`: `bun run typecheck`
- From `packages/tui`: `bun test test/cli/cmd/tui/model-options.test.ts`
- From `packages/tui`: `bun run typecheck`

Review:

A fresh read-only reviewer must verify disconnected visibility, connected model visibility, provider/model identity, configured model extension, and same-name cross-provider behavior.

### PR 4: Durable Endpoint Lifecycle

- Add `ModalEndpoint.Service`.
- Add the atomic durable ledger and tombstones.
- Add cross-process fingerprint locks.
- Implement intent, create, uncertain-create, reconcile, readiness, and reuse transitions.
- Add Modal lifecycle HTTP routes.
- Regenerate the JavaScript SDK.

Verification:

- From `packages/opencode`: `bun test test/provider/modal-endpoint.test.ts test/provider/modal-endpoint-concurrency.test.ts test/provider/modal-endpoint-crash.test.ts`
- From `packages/opencode`: `bun run typecheck`
- From `packages/sdk/js`: `bun script/build.ts`
- From `packages/sdk/js`: `bun run typecheck`

Review:

A fresh read-only reviewer must verify single-flight creation, pre-create intent durability, crash injection, exact-ID ownership, ambiguous-create handling, readiness bounds, and zero adoption of foreign endpoints.

### PR 5: Selection And Inference

- Add the endpoint provisioning dialog.
- Require billing confirmation before new creation.
- Reuse exact ready endpoints without prompting.
- Commit selection only after readiness.
- Resolve runtime base URL from the managed record.
- Inject proxy headers through runtime-only fetch.
- Keep Modal off the native runtime.

Verification:

- From `packages/opencode`: `bun test test/provider/modal-inference.test.ts test/session/llm-native.test.ts`
- From `packages/opencode`: `bun run typecheck`
- From `packages/tui`: `bun test test/cli/cmd/tui/modal-model-select.test.tsx test/cli/cmd/tui/model-options.test.ts`
- From `packages/tui`: `bun run typecheck`

Review:

A fresh read-only reviewer must verify confirmation boundaries, waiting cancellation, endpoint reuse, exact model probing, wrong-model failure, origin restrictions, redirects, header secrecy, and runtime bypass prevention.

### PR 6: Managed Stop And Disconnect

- Add `/modal`.
- Add endpoint list and exact-record stop CLI commands.
- Add permanent-stop confirmation.
- Persist stop and uncertain-stop transitions.
- Preserve stopped tombstones.
- Block disconnect until managed endpoints are stopped.
- Update `README.md` with connection, billing, reuse, and stop behavior.

Verification:

- From `packages/opencode`: `bun test test/provider/modal-stop.test.ts test/provider/modal-endpoint-crash.test.ts test/cli/modal-provider.test.ts`
- From `packages/opencode`: `bun run typecheck`
- From `packages/tui`: `bun test test/cli/cmd/tui/modal-endpoints.test.tsx`
- From `packages/tui`: `bun run typecheck`
- From the repository root: `bun run lint`
- From the repository root: `bun run check:packages`

Review:

A fresh read-only reviewer must verify exact-ID stopping, foreign endpoint protection, stop uncertainty, disconnect safety, tombstone reuse protection, active-user warnings, and that process shutdown issues no stop command.

## Future Work

- App and Session V2 support.
- Larger or remotely discovered model catalog.
- Custom Hugging Face and Modal Volume weights.
- Routing region and colocation controls.
- Proxy-token rotation and revocation.
- Automated recovery UI for ambiguous creates and stops.
- Unauthenticated endpoints.
- Endpoint usage and cost telemetry.
- Optional user-configured automatic idle-stop policy.
- Modal sandbox execution.

Modal sandbox support must reuse the managed CLI and account setup services where appropriate, but it requires a separate worker/executor design rather than extending the LLM provider directly.

## Open Questions

- **Environment default:** default to `MODAL_ENVIRONMENT`, otherwise `main`.
- **Endpoint lifetime:** retain and reuse endpoints until explicit OC2 stop. Do not stop on process exit.
- **Initial catalog:** ship only reviewed model IDs demonstrated by the supplied docs; extend through configuration until Modal exposes a documented catalog API.
