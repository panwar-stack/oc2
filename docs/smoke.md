# Manual Smoke Checklist

Run these checks before cutting a release or considering PR 16 complete:

```sh
bun test
bun run typecheck
bun run lint
bun run diagnostics
bun run check
bun src/index.ts version --json
bun src/index.ts diagnostics --json
bun src/index.ts run "hello" --json --model fake/test
```

Expected smoke output highlights:

- `version --json` prints `{ "name": "oc2", "version": "0.0.0" }` for the current package version.
- `diagnostics --json` prints `generatedAt`, `environment`, and `diagnostics` fields.
- `run "hello" --json --model fake/test` completes with `finalAssistantText: "fake response"` and `exitStatus: "completed"`.

Optional interactive smoke:

```sh
bun run smoke:tui
```

This opens the TUI with the fake model. Verify prompt entry, streamed assistant text, side panel toggling, and `Ctrl+C` exit manually.
