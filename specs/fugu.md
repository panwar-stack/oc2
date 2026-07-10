# Fugu Virtual Model

Fugu is the built-in virtual `fugu/fugu` model. It fans one ordinary model request out to configured branch models, optionally evaluates their private results with a judge, and exposes only a synthesizer stream to the caller.

## Selection And Configuration

The virtual provider/model is always discoverable unless explicitly disabled. Selecting it requires valid runtime configuration:

```jsonc
{
  "fugu": {
    "branches": [{ "model": "provider/model", "variant": "medium" }],
    "judge": { "model": "provider/model", "variant": "high" },
    "synthesizer": { "model": "provider/model", "variant": "high" }
  }
}
```

Configuration is intentionally decoded permissively so OC2 can start without a usable Fugu setup. Request-time validation requires at least one branch and a synthesizer, resolves every target through normal provider/model lookup, validates variants, and rejects recursive `fugu/fugu` targets. The judge is optional.

## Execution

Fugu intercepts the selected virtual model before ordinary provider language-model loading.

1. Branches receive the caller's original request context and run concurrently.
2. Branch and judge requests may see caller tool definitions as non-executing suggestions, but cannot execute caller tools.
3. Successful branch text and private tool-call proposals are collected with failure summaries.
4. The optional judge evaluates private branch results.
5. The synthesizer receives original context, successful results, failures, optional judge guidance, executable caller tools, and caller tool choice.
6. Only the synthesizer event stream reaches normal Session processing.

One branch failure does not fail the run while another succeeds. All branch failures, synthesizer failure, or invalid configuration fail the model request normally.

## Privacy Boundary

Branch responses, judge guidance, private tool proposals, prompts, provider credentials, variants, model identifiers, stack traces, and raw errors are not caller-visible Session output. Operational logging is outside this caller-output privacy contract.

## Live Status

Fugu publishes live-only `session.next.fugu.status` events after validation. Status carries Session and run identity, orchestration phase, indexed branch states, optional judge state, and synthesizer state.

Status never contains private branch or judge content, target identities, prompts, tool proposals, credentials, or raw errors. It is ephemeral and absent from durable Session replay.

The app and TUI associate status with the current run, ignore stale updates, render progress near the active turn, and clear or suppress terminal state when the Session becomes idle.
