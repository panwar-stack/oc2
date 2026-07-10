# OC2 Browser App

This package contains the Solid/Vite browser interface for the OC2 minimal coding-agent harness. It is one interface to the full agent loop, including configurable providers and agents, persistent sessions, and permission-gated tools. "Minimal" describes the distribution and owner-service boundary, not the browser app's feature set.

At runtime, `oc2 web` serves embedded browser assets when they are present and currently proxies `app.oc2.ai` when they are unavailable. This hosted fallback forwards incoming request headers, including authorization headers and cookies. The Vite development flow below is separate: it serves the UI assets locally and connects them to a local OC2 backend.

## Local Development

From the repository root, start the backend and app in separate terminals:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`. The app targets the local backend at `http://localhost:4096` by default. Model calls go to the configured provider endpoint, which may be local.

## Package Scripts

```bash
bun run --cwd packages/app dev -- --port 4444
bun run --cwd packages/app build
bun run --cwd packages/app typecheck
bun run --cwd packages/app test:unit
```

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests expect an OC2 backend at `localhost:4096` by default.

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)
