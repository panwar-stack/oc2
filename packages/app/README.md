# OC2 Local Browser App

This package contains the Solid/Vite browser interface for the OC2 minimal local coding agent harness. It runs against a local OC2 backend and is not a standalone hosted web app.

## Local Development

From the repository root, start the backend and app in separate terminals:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`. The app targets the local backend at `http://localhost:4096` by default.

## Package Scripts

```bash
bun run --cwd packages/app dev -- --port 4444
bun run --cwd packages/app build
bun run --cwd packages/app typecheck
bun run --cwd packages/app test:unit
```

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests expect an opencode backend at `localhost:4096` by default.

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)
