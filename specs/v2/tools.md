# V2 Tool Contract

The Plugin package owns the public typed tool definition. Core owns process and Location-scoped registration, invocation settlement, generic output bounding, and durable handoff to Session execution.

## Definitions

`Tool.make(...)` binds input and output codecs, execution, and optional model-facing projection into one opaque tool value. Application tools and shipped built-ins use the same contract.

- Input is decoded before execution.
- Successful output is encoded before projection.
- Invalid input never invokes the handler.
- Invalid output never produces successful settlement.
- Tool dependencies are captured when the definition is constructed.
- Projection is pure and depends only on validated input and output.

## Invocation Identity

Every local invocation receives the Session ID, effective agent, owning assistant message ID, and tool call ID supplied by the runner. The registry does not infer ownership from provider-local IDs.

Effect interruption cancels execution. Tools may translate deliberately classified expected failures into model-visible `Tool.Failure`, but must not consume interruption or defects through broad cause handling.

## Scoped Registration

Tools are named when registered. Process-scoped `ApplicationTools` registrations are shared by every Location. Location-scoped registrations overlay application registrations and take precedence for the same name. Both placements are Scope-owned:

- the latest active registration for a name wins;
- closing a registration removes only that registration;
- closing the winner reveals the previous active registration;
- request materialization captures the identity of each advertised registration;
- settlement rejects a call as stale when that registration was removed or replaced after advertisement.

Location producers receive the narrow `Tools.Service` registration capability rather than registry internals. Trusted built-ins may capture permission or filesystem services unavailable to application tools; sharing a definition type does not imply equal authority.

## Settlement

For each call the registry resolves the captured definition, decodes input, executes it with durable identity, encodes output, projects model content, bounds provider-facing output, and returns one settlement to the runner.

Permissions remain a tool responsibility. Trusted tools formulate and sequence requests against the Location permission service; the registry does not invent generic resource authority.

Outcomes remain distinct:

- expected tool failures are model-visible settlements;
- interruption is cancellation, not a tool result;
- unexpected typed errors and defects follow runner operational-failure policy;
- unknown tools and invalid calls settle explicitly without invoking a handler.

## Output Bounding

Producer capture limits and registry model-output limits are separate. A producer must report data it discarded and cannot claim complete retention after loss.

The registry bounds the channel sent to the provider after projection. Oversized textual output may be retained in managed storage and replaced with a bounded preview. Failure to retain complete output fails settlement rather than publishing lossy success.

Managed storage is operational metadata, not part of domain output schemas. Generic bounding must not change validated structured results or grant filesystem authority to managed paths.

## Laws

- One tool definition has one executor.
- Execution observes decoded input; projection observes encoded output.
- Invocation-owned records use runner-supplied Session, agent, message, and call identity.
- Scope closure removes exactly its registration overlay.
- A call executes only while the advertised registration identity is still current.
- Output retention policy does not change domain output.
