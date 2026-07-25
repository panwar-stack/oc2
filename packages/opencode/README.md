# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Prompt-cache diagnostics

opencode surfaces prompt-cache read/write status in session usage. Runtime
regression warnings may also appear as `Prompt Cache` TUI toasts when interactive
diagnostics are available. See [`../../docs/prompt-caching.md`](../../docs/prompt-caching.md)
for provider behavior, warmup expectations, and self-healing policy details.
