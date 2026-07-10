# TUI Plugin Contract

The TUI plugin system extends the terminal application through typed host capabilities while keeping rendering, lifecycle, cleanup, and terminal authority under host control.

## Configuration And Identity

TUI plugin configuration lives in `tui.json`, including ordered plugin specs, plugin enablement, keybinds, attention settings, and theme selection. Project-local files may live in project directories or under `.oc2`; `OC2_CONFIG_DIR` supplies an additional explicit configuration root.

Config files merge in this order, with later entries taking precedence:

1. global `tui.json`;
2. the explicit `OC2_TUI_CONFIG` file;
3. project files applied root-first so the closest file wins;
4. discovered `.oc2` directories and `OC2_CONFIG_DIR`.

Plugin entries may be npm specs, file URLs, relative paths, or absolute paths, optionally paired with options. Relative paths resolve against the config file that declared them. npm entries deduplicate by package name; file entries deduplicate by resolved spec before loading.

Runtime identity is the plugin's exported ID. File plugins must provide one; npm plugins may fall back to package name. Duplicate IDs, including collisions with internal plugins, are rejected.

Desired enablement is merged from config and persisted TUI KV state. Persisted state wins at startup. Internal plugins may register disabled by default and be activated later.

## Author Module

Authors import the contract from `@oc2-ai/plugin/tui` and default-export one target-specific module:

```tsx
import type { TuiPlugin, TuiPluginModule } from "@oc2-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [{ name: "demo.open", title: "Demo", namespace: "palette", run: () => api.route.navigate("demo") }],
    bindings: [{ key: "ctrl+shift+m", cmd: "demo.open", desc: "Open demo" }],
  })
  api.route.register([{ name: "demo", render: () => <text>Demo</text> }])
}

export default { id: "acme.demo", tui } satisfies TuiPluginModule & { id: string }
```

The loader reads only the default export. A module is target-exclusive and cannot export both server and TUI implementations. Packages expose separate `./server` and `./tui` entrypoints when supporting both targets.

Package compatibility uses `engines.oc2`. TUI packages do not fall back to a package root export or `main`; path modules retain the explicit `index.ts`/`index.js` directory fallback. Theme-only packages may omit `./tui` when `oc-themes` contains valid package-relative files.

## Host API

The host provides scoped capabilities for:

- application version and attention requests;
- keymap registration, command dispatch, shortcut formatting, and UI modes;
- route registration and navigation;
- dialogs, toast, host UI components, and slots;
- TUI config, KV, synchronized state, SDK client, and live events;
- theme selection and plugin-owned theme installation;
- renderer access;
- plugin listing, activation, deactivation, runtime add, and installation;
- cancellation and explicit lifecycle cleanup.

The API exposes live host objects rather than frozen snapshots. The SDK client is the domain-operation boundary; plugins do not receive backend implementation services.

## Registration And Cleanup

External modules resolve and import concurrently, then activate sequentially for deterministic command, route, and side-effect order. Internal plugins activate first. Pure mode skips external plugins only.

Every plugin activation owns a cleanup scope. The runtime tracks commands, key bindings, modes, routes, event subscriptions, slots, sound packs, and explicit disposal handlers. Initialization failure rolls back registrations and does not stop later plugins. Deactivation aborts the lifecycle signal and runs cleanup in reverse order.

Cleanup is awaited with a bounded per-plugin budget. Timeout or cleanup failure is logged while application shutdown continues.

## Routes, Modes, And Slots

`home` and `session` are reserved host routes. Other names are plugin routes; the last registration for a name wins. Unknown routes render a safe fallback.

Keymap layers may be gated by host or plugin-defined modes. Mode pushes are plugin-scoped and are removed automatically during cleanup.

Host slots have documented prop contracts and composition modes. Plugins may register additional slot names for their own UI, but host-assigned registration identity prevents one plugin from impersonating another.

## Installation And Themes

CLI and TUI installation share manifest reading, package installation, and targeted JSONC config patching. npm installation uses `--ignore-scripts`. Per-target config writes are serialized and preserve comments. Installation and runtime loading are separate operations.

Theme paths must remain inside their package. Theme copying uses a cross-process lock and preserves user-modified destinations unless plugin metadata indicates an update. Attention delivery and notification text remain host-mediated so focus policy, terminal integration, sound fallback, and privacy sanitization are applied consistently.
