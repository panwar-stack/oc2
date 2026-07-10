import { expect } from "bun:test"
import nodeFs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Global } from "@oc2-ai/core/global"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { CurrentWorkingDirectory } from "@/config/tui-cwd"
import { TuiConfig } from "../../src/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NpmTest } from "../fake/npm"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))
const winIt = process.platform === "win32" ? it.instance : it.instance.skip

const globalConfigFiles = ["oc2.json", "oc2.jsonc", "tui.json", "tui.jsonc"].map((file) =>
  path.join(Global.Path.config, file),
)
const homeConfigFiles = ["oc2.json", "oc2.jsonc", "tui.json", "tui.jsonc"].map((file) =>
  path.join(Global.Path.home, ".oc2", file),
)

const cleanState = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  delete process.env.OC2_CONFIG
  delete process.env.OC2_CONFIG_DIR
  delete process.env.OC2_TUI_CONFIG
  delete process.env.OC2_DISABLE_PROJECT_CONFIG
  yield* Effect.forEach(
    [...globalConfigFiles, ...homeConfigFiles],
    (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
    { discard: true },
  )
})

const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    cleanState,
    () => self,
    () => cleanState,
  )

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

const withPlatform = <A, E, R>(platform: typeof process.platform, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")
      Object.defineProperty(process, "platform", {
        ...original,
        value: platform,
      })
      return original
    }),
    () => self,
    (original) =>
      Effect.sync(() => {
        if (original) Object.defineProperty(process, "platform", original)
      }),
  )

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(
      TuiConfig.layer.pipe(
        Layer.provide(NpmTest.noop),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)),
      ),
    ),
  )

const getTuiPluginOrigins = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.pluginOrigins()).pipe(
    Effect.provide(
      TuiConfig.layer.pipe(
        Layer.provide(NpmTest.noop),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)),
      ),
    ),
  )

it.instance("keeps server and tui plugin merge semantics aligned", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const local = path.join(test.directory, ".oc2")
      yield* fs.makeDirectory(local, { recursive: true })

      yield* fs.writeJson(path.join(Global.Path.config, "oc2.json"), {
        plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(local, "oc2.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
      })
      yield* fs.writeJson(path.join(local, "tui.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
      })

      const server = yield* Config.use.get()
      const tui = yield* getTuiConfig(test.directory)
      const tuiOrigins = yield* getTuiPluginOrigins(test.directory)
      const serverPlugins = (server.plugin ?? []).map((item) => ConfigPlugin.pluginSpecifier(item))
      const tuiPlugins = (tui.plugin ?? []).map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(serverPlugins).toEqual(tuiPlugins)
      expect(serverPlugins).toContain("shared-plugin@2.0.0")
      expect(serverPlugins).not.toContain("shared-plugin@1.0.0")

      const serverOrigins = server.plugin_origins ?? []
      expect(serverOrigins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(serverPlugins)
      expect(tuiOrigins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(tuiPlugins)
      expect(serverOrigins.map((item) => item.scope)).toEqual(tuiOrigins.map((item) => item.scope))
    }),
  ),
)

it.instance("loads tui config with the same precedence order as server config paths", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project" })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".oc2", "tui.json"),
        JSON.stringify({ theme: "local", diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("local")
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("applies the complete interleaved tui source precedence plan", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "apps", "client")
      const nearest = path.join(nested, ".oc2", "tui.json")
      const outer = path.join(test.directory, ".oc2", "oc2.json")
      const home = path.join(Global.Path.home, ".oc2", "tui.json")
      const configDir = path.join(test.directory, "config-dir")
      const managed = path.join(configDir, "tui.json")
      const configEnv = path.join(test.directory, "config-env.json")
      const tuiEnv = path.join(test.directory, "tui-env.json")
      const root = path.join(test.directory, "tui.json")
      const direct = path.join(nested, "oc2.json")
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global" })
      yield* fs.writeJson(configEnv, { theme: "config-env" })
      yield* fs.writeJson(tuiEnv, { theme: "tui-env" })
      yield* fs.writeJson(root, { theme: "direct-root" })
      yield* fs.writeJson(direct, { theme: "direct-near" })
      yield* fs.writeWithDirs(nearest, JSON.stringify({ theme: "discovered-near" }))
      yield* fs.writeWithDirs(outer, JSON.stringify({ theme: "discovered-outer" }))
      yield* fs.writeWithDirs(home, JSON.stringify({ theme: "home" }))
      yield* fs.writeWithDirs(managed, JSON.stringify({ theme: "config-dir" }))
      process.env.OC2_CONFIG = configEnv
      process.env.OC2_TUI_CONFIG = tuiEnv
      process.env.OC2_CONFIG_DIR = configDir

      expect((yield* getTuiConfig(nested)).theme).toBe("config-dir")
      yield* fs.remove(managed)
      expect((yield* getTuiConfig(nested)).theme).toBe("home")
      yield* fs.remove(home)
      expect((yield* getTuiConfig(nested)).theme).toBe("discovered-outer")
      yield* fs.remove(outer)
      expect((yield* getTuiConfig(nested)).theme).toBe("discovered-near")
      yield* fs.remove(nearest)
      expect((yield* getTuiConfig(nested)).theme).toBe("direct-near")
      yield* fs.remove(direct)
      expect((yield* getTuiConfig(nested)).theme).toBe("direct-root")
      yield* fs.remove(root)
      expect((yield* getTuiConfig(nested)).theme).toBe("tui-env")
      delete process.env.OC2_TUI_CONFIG
      expect((yield* getTuiConfig(nested)).theme).toBe("config-env")
      delete process.env.OC2_CONFIG
      expect((yield* getTuiConfig(nested)).theme).toBe("global")
    }),
  ),
)

it.instance("resolves attention config defaults and overrides", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: true,
        sound: true,
        volume: 0.4,
        sound_pack: "opencode.default",
        sounds: {},
      })

      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        attention: {
          enabled: false,
          notifications: false,
          sound: false,
          volume: 0.7,
          sound_pack: "acme.soft",
          sounds: {
            default: path.join(test.directory, "default.mp3"),
            question: pathToFileURL(path.join(test.directory, "question.mp3")).href,
            error: "./error.mp3",
            subagent_done: "./subagent-done.mp3",
          },
        },
      })

      expect((yield* getTuiConfig(test.directory)).attention).toEqual({
        enabled: false,
        notifications: false,
        sound: false,
        volume: 0.7,
        sound_pack: "acme.soft",
        sounds: {
          default: path.join(test.directory, "default.mp3"),
          question: path.join(test.directory, "question.mp3"),
          error: path.join(test.directory, "error.mp3"),
          subagent_done: path.join(test.directory, "subagent-done.mp3"),
        },
      })
    }),
  ),
)

it.instance("loads legacy tui keys without modifying protected sources", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const source = path.join(test.directory, "oc2.json")
      const backup = source + ".tui-migration.bak"
      const sources = [
        {
          file: source,
          content: JSON.stringify({ theme: "legacy-theme", keybinds: { app_exit: "ctrl+q" } }, null, 2),
        },
        { file: path.join(test.directory, "tui.json"), content: '{"scroll_speed":5}\n' },
        {
          file: path.join(test.directory, "tui.jsonc"),
          content: '{\n  // protected explicit TUI config\n  "diff_style": "stacked"\n}\n',
        },
        { file: backup, content: '{"theme":"existing-backup"}\n' },
      ]
      for (const item of sources) yield* fs.writeFileString(item.file, item.content)
      const fixed = new Date("2020-01-02T03:04:05.000Z")
      yield* Effect.promise(() => Promise.all(sources.map((item) => nodeFs.utimes(item.file, fixed, fixed))))
      const before = new Map(
        yield* Effect.promise(() =>
          Promise.all(
            sources.map(async (item) => [
              item.file,
              { bytes: await nodeFs.readFile(item.file), mtimeMs: (await nodeFs.stat(item.file)).mtimeMs },
            ] as const),
          ),
        ),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("legacy-theme")
      expect(config.scroll_speed).toBe(5)
      expect(config.diff_style).toBe("stacked")
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      for (const item of sources) {
        const original = before.get(item.file)
        if (!original) throw new Error(`missing protected source snapshot for ${item.file}`)
        expect(yield* Effect.promise(() => nodeFs.readFile(item.file))).toEqual(original.bytes)
        expect((yield* Effect.promise(() => nodeFs.stat(item.file))).mtimeMs).toBe(original.mtimeMs)
      }
      expect(yield* fs.existsSafe(path.join(test.directory, "oc2.jsonc.tui-migration.bak"))).toBe(false)
    }),
  ),
)

it.instance("interleaves legacy and explicit files within each directory", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "oc2.json"), { theme: "legacy-json", tui: { scroll_speed: 1 } })
      yield* fs.writeFileString(
        path.join(test.directory, "oc2.jsonc"),
        `{ "theme": "legacy-jsonc", "tui": { "scroll_speed": 2 } }`,
      )
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "tui-json", scroll_speed: 3 })
      yield* fs.writeJson(path.join(test.directory, "tui.jsonc"), { theme: "tui-jsonc", scroll_speed: 4 })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("tui-jsonc")
      expect(config.scroll_speed).toBe(4)
    }),
  ),
)

it.instance("keeps valid legacy siblings when another field is invalid", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "oc2.json"), {
        theme: "legacy-theme",
        keybinds: "invalid",
        tui: { scroll_speed: 2, diff_style: "invalid", unknown: true },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("legacy-theme")
      expect(config.scroll_speed).toBe(2)
      expect(config.diff_style).toBeUndefined()
    }),
  ),
)

it.instance("skips legacy extraction when oc2.jsonc is syntactically invalid", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(
        path.join(test.directory, "oc2.jsonc"),
        `{
  "theme": "broken-theme",
  "tui": { "scroll_speed": 2 }
  "username": "still-broken"
}`,
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBeUndefined()
      expect(config.scroll_speed).toBeUndefined()
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(test.directory, "oc2.jsonc.tui-migration.bak"))).toBe(false)
      const source = yield* fs.readFileString(path.join(test.directory, "oc2.jsonc"))
      expect(source).toContain('"theme": "broken-theme"')
      expect(source).toContain('"tui": { "scroll_speed": 2 }')
    }),
  ),
)

it.instance("explicit tui config overrides legacy config in the same directory", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "oc2.json"), { theme: "legacy" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { diff_style: "stacked" })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBe("legacy")

      const server = JSON.parse(yield* fs.readFileString(path.join(test.directory, "oc2.json")))
      expect(server.theme).toBe("legacy")
      expect(yield* fs.existsSafe(path.join(test.directory, "oc2.json.tui-migration.bak"))).toBe(false)
    }),
  ),
)

it.instance("loads legacy tui keys across multiple oc2.json levels", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "apps", "client")
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeJson(path.join(test.directory, "oc2.json"), { theme: "root-theme" })
      yield* fs.writeJson(path.join(nested, "oc2.json"), { theme: "nested-theme" })

      const config = yield* getTuiConfig(nested)
      expect(config.theme).toBe("nested-theme")
      expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(nested, "tui.json"))).toBe(false)
    }),
  ),
)

it.instance("flattens nested tui key inside tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        theme: "outer",
        tui: { scroll_speed: 3, diff_style: "stacked" },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.scroll_speed).toBe(3)
      expect(config.diff_style).toBe("stacked")
      expect(config.theme).toBe("outer")
    }),
  ),
)

it.instance("top-level keys in tui.json take precedence over nested tui key", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        diff_style: "auto",
        tui: { diff_style: "stacked", scroll_speed: 2 },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("auto")
      expect(config.scroll_speed).toBe(2)
    }),
  ),
)

it.instance("project config takes precedence over OC2_TUI_CONFIG (matches OC2_CONFIG)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "project", diff_style: "auto" })
      yield* fs.writeJson(custom, { theme: "custom", diff_style: "stacked" })

      yield* withEnv(
        "OC2_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("project")
          expect(config.diff_style).toBe("auto")
        }),
      )
    }),
  ),
)

it.instance("reapplies OC2_CONFIG when it is also a direct project source", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const project = path.join(test.directory, "oc2.json")
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(project, { theme: "project" })
      yield* fs.writeJson(custom, { theme: "custom" })

      const config = yield* withEnv(
        "OC2_CONFIG",
        project,
        withEnv("OC2_TUI_CONFIG", custom, getTuiConfig(test.directory)),
      )

      expect(config.theme).toBe("project")
    }),
  ),
)

it.instance("merges keybind overrides across precedence layers", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { keybinds: { app_exit: "ctrl+q" } })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { theme_list: "ctrl+k" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      expect(config.keybinds.get("theme.switch")?.[0]?.key).toBe("ctrl+k")
    }),
  ),
)

it.instance("ignores unknown keybind names without dropping valid overrides from the same file", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        keybinds: {
          session_delete: "ctrl+d",
          not_a_real_keybind: "ctrl+q",
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("session.delete")?.[0]?.key).toBe("ctrl+d")
      expect(config.keybinds.get("not_a_real_keybind")).toEqual([])
    }),
  ),
)

it.instance("resolves keybind lookup from canonical keybinds", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          leader: { key: { name: "g", ctrl: true } },
          command_list: "alt+p",
          which_key_toggle: "alt+k",
          editor_open: "ctrl+e",
          "prompt.autocomplete.next": "ctrl+j",
          "dialog.prompt.submit": "ctrl+s",
          "dialog.mcp.toggle": "ctrl+t",
          model_favorite_toggle: "ctrl+f",
          "dialog.plugins.install": "shift+i",
        },
        leader_timeout: 1234,
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("leader")?.[0]?.key).toEqual({ name: "g", ctrl: true })
      expect(config.leader_timeout).toBe(1234)
      expect(config.keybinds.get("command.palette.show")?.[0]?.key).toBe("alt+p")
      expect(config.keybinds.get("session.new")?.[0]?.key).toBe("<leader>n")
      expect(config.keybinds.get("which-key.toggle")?.[0]?.key).toBe("alt+k")
      expect(config.keybinds.get("which-key.layout.toggle")?.[0]?.key).toBe("ctrl+alt+shift+k")
      expect(config.keybinds.get("which-key.pending.toggle")?.[0]?.key).toBe("ctrl+alt+shift+p")
      expect(config.keybinds.get("which-key.group.next")?.[0]?.key).toBe("ctrl+alt+right,ctrl+alt+]")
      expect((config.keybinds.get("which-key.toggle")?.[0] as { desc?: unknown } | undefined)?.desc).toBe(
        "Toggle which-key panel",
      )
      expect(config.keybinds.get("prompt.editor")?.[0]?.key).toBe("ctrl+e")
      expect(config.keybinds.get("prompt.autocomplete.next")?.[0]?.key).toBe("ctrl+j")
      expect(config.keybinds.get("dialog.prompt.submit")?.[0]?.key).toBe("ctrl+s")
      expect(config.keybinds.get("dialog.mcp.toggle")?.[0]?.key).toBe("ctrl+t")
      expect(config.keybinds.get("model.dialog.favorite")?.[0]?.key).toBe("ctrl+f")
      expect(config.keybinds.get("dialog.plugins.install")?.[0]?.key).toBe("shift+i")
      expect(
        config.keybinds.gather("plugins.dialog", ["dialog.plugins.install"]).map((binding) => binding.cmd),
      ).toEqual(["dialog.plugins.install"])
    }),
  ),
)

it.instance("keybinds accept OpenTUI binding specs", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        keybinds: {
          command_list: [{ key: "alt+p", preventDefault: false }],
          editor_open: { key: { name: "e", ctrl: true }, group: "Explicit" },
          "prompt.autocomplete.next": false,
          plugin_manager: "ctrl+shift+p",
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("command.palette.show")).toEqual([
        { key: "alt+p", cmd: "command.palette.show", preventDefault: false, desc: "List available commands" },
      ])
      expect(config.keybinds.get("prompt.editor")?.[0]).toMatchObject({
        key: { name: "e", ctrl: true },
        cmd: "prompt.editor",
        group: "Explicit",
      })
      expect(config.keybinds.get("prompt.autocomplete.next")).toEqual([])
      expect(config.keybinds.get("plugins.list")?.[0]?.key).toBe("ctrl+shift+p")
    }),
  ),
)

winIt("defaults Ctrl+Z to input undo on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

winIt("keeps explicit input undo overrides on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { input_undo: "ctrl+y" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
    }),
  ),
)

winIt("ignores terminal suspend bindings on Windows", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { keybinds: { terminal_suspend: "alt+z" } })

      const config = yield* getTuiConfig(test.directory)
      expect(config.keybinds.get("terminal.suspend")).toEqual([])
      expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
    }),
  ),
)

it.instance("applies Windows keybind defaults", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const test = yield* TestInstance
        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+z,ctrl+-,super+z")
      }),
    ),
  ),
)

it.instance("ignores explicit keybind terminal suspend binding on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            terminal_suspend: "alt+z",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("terminal.suspend")).toEqual([])
      }),
    ),
  ),
)

it.instance("keeps explicit configured keybind input undo on Windows", () =>
  withCleanState(
    withPlatform(
      "win32",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          keybinds: {
            input_undo: "ctrl+y",
          },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.keybinds.get("input.undo")?.[0]?.key).toBe("ctrl+y")
      }),
    ),
  ),
)

it.instance("OC2_TUI_CONFIG provides settings when no project config exists", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(custom, { theme: "from-env", diff_style: "stacked" })

      yield* withEnv(
        "OC2_TUI_CONFIG",
        custom,
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("from-env")
          expect(config.diff_style).toBe("stacked")
        }),
      )
    }),
  ),
)

it.instance("project disable excludes direct and discovered project tui sources", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const custom = path.join(test.directory, "custom-tui.json")
      yield* fs.writeJson(path.join(test.directory, "oc2.json"), { theme: "direct-legacy" })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "direct-explicit" })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".oc2", "tui.json"),
        JSON.stringify({ theme: "discovered" }),
      )
      yield* fs.writeJson(custom, { theme: "custom" })

      yield* withEnv(
        "OC2_DISABLE_PROJECT_CONFIG",
        "true",
        withEnv(
          "OC2_TUI_CONFIG",
          custom,
          Effect.gen(function* () {
            expect((yield* getTuiConfig(test.directory)).theme).toBe("custom")
          }),
        ),
      )
    }),
  ),
)

it.instance("loads only legacy values from OC2_CONFIG without deriving a sibling tui path", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const customDir = path.join(test.directory, "custom")
      yield* fs.makeDirectory(customDir, { recursive: true })
      yield* fs.writeJson(path.join(customDir, "oc2.json"), { theme: "from-config-env", model: "test/model" })
      yield* fs.writeJson(path.join(customDir, "tui.json"), { theme: "should-not-load" })

      yield* withEnv(
        "OC2_CONFIG",
        path.join(customDir, "oc2.json"),
        Effect.gen(function* () {
          const config = yield* getTuiConfig(test.directory)
          expect(config.theme).toBe("from-config-env")
        }),
      )
    }),
  ),
)

it.instance("applies env and file substitutions in tui.json", () =>
  withCleanState(
    withEnv(
      "TUI_THEME_TEST",
      "env-theme",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeFileString(path.join(test.directory, "keybind.txt"), "ctrl+q")
        yield* fs.writeJson(path.join(test.directory, "tui.json"), {
          theme: "{env:TUI_THEME_TEST}",
          keybinds: { app_exit: "{file:keybind.txt}" },
        })

        const config = yield* getTuiConfig(test.directory)
        expect(config.theme).toBe("env-theme")
        expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
      }),
    ),
  ),
)

it.instance("applies substitutions relative to the legacy source", () =>
  withCleanState(
    withEnv(
      "LEGACY_TUI_THEME_TEST",
      "legacy-env-theme",
      withEnv(
        "LEGACY_TUI_SCROLL_SPEED_TEST",
        "2.5",
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const test = yield* TestInstance
          const configDir = path.join(test.directory, "config")
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(path.join(configDir, "keybind.txt"), "ctrl+q")
          yield* fs.writeFileString(path.join(configDir, "diff-style.txt"), "stacked")
          yield* fs.writeFileString(
            path.join(configDir, "oc2.jsonc"),
            `{
  "theme": "{env:LEGACY_TUI_THEME_TEST}",
  "keybinds": { "app_exit": "{file:keybind.txt}" },
  "tui": {
    "scroll_speed": {env:LEGACY_TUI_SCROLL_SPEED_TEST},
    "diff_style": "{file:diff-style.txt}"
  }
}`,
          )

          const config = yield* getTuiConfig(configDir)
          expect(config.theme).toBe("legacy-env-theme")
          expect(config.scroll_speed).toBe(2.5)
          expect(config.diff_style).toBe("stacked")
          expect(config.keybinds.get("app.exit")?.[0]?.key).toBe("ctrl+q")
        }),
      ),
    ),
  ),
)

it.instance("applies file substitutions when first identical token is in a commented line", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "theme.txt"), "resolved-theme")
      yield* fs.writeFileString(
        path.join(test.directory, "tui.jsonc"),
        `{
  // "theme": "{file:theme.txt}",
  "theme": "{file:theme.txt}"
}`,
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("resolved-theme")
    }),
  ),
)

it.instance("loads .oc2/tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(
        path.join(test.directory, ".oc2", "tui.json"),
        JSON.stringify({ diff_style: "stacked" }, null, 2),
      )

      const config = yield* getTuiConfig(test.directory)
      expect(config.diff_style).toBe("stacked")
    }),
  ),
)

it.instance("supports tuple plugin specs with options in tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin: [["acme-plugin@1.2.3", { enabled: true, label: "demo" }]],
      })

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual([["acme-plugin@1.2.3", { enabled: true, label: "demo" }]])
      expect(origins).toEqual([
        {
          spec: ["acme-plugin@1.2.3", { enabled: true, label: "demo" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("deduplicates tuple plugin specs by name with higher precedence winning", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin: [["acme-plugin@1.0.0", { source: "global" }]],
      })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin: [
          ["acme-plugin@2.0.0", { source: "project" }],
          ["second-plugin@3.0.0", { source: "project" }],
        ],
      })

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual([
        ["acme-plugin@2.0.0", { source: "project" }],
        ["second-plugin@3.0.0", { source: "project" }],
      ])
      expect(origins).toEqual([
        {
          spec: ["acme-plugin@2.0.0", { source: "project" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
        {
          spec: ["second-plugin@3.0.0", { source: "project" }],
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("tracks global and local plugin metadata in merged tui config", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { plugin: ["global-plugin@1.0.0"] })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), { plugin: ["local-plugin@2.0.0"] })

      const config = yield* getTuiConfig(test.directory)
      const origins = yield* getTuiPluginOrigins(test.directory)
      expect(config.plugin).toEqual(["global-plugin@1.0.0", "local-plugin@2.0.0"])
      expect(origins).toEqual([
        {
          spec: "global-plugin@1.0.0",
          scope: "global",
          source: path.join(Global.Path.config, "tui.json"),
        },
        {
          spec: "local-plugin@2.0.0",
          scope: "local",
          source: path.join(test.directory, "tui.json"),
        },
      ])
    }),
  ),
)

it.instance("merges plugin_enabled flags across config layers", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), {
        plugin_enabled: {
          "internal:sidebar-context": false,
          "demo.plugin": true,
        },
      })
      yield* fs.writeJson(path.join(test.directory, "tui.json"), {
        plugin_enabled: {
          "demo.plugin": false,
          "local.plugin": true,
        },
      })

      const config = yield* getTuiConfig(test.directory)
      expect(config.plugin_enabled).toEqual({
        "internal:sidebar-context": false,
        "demo.plugin": false,
        "local.plugin": true,
      })
    }),
  ),
)

it.instance("silently skips malformed tui.json - load failures degrade to {}", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "tui.json"), '{ "theme": "broken",')
      yield* fs.writeWithDirs(path.join(test.directory, ".oc2", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("silently skips non-ENOENT read failures (e.g. tui.json is a directory) - fallback layer still loads", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.makeDirectory(path.join(test.directory, "tui.json"), { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".oc2", "tui.json"), JSON.stringify({ theme: "fallback" }))

      const config = yield* getTuiConfig(test.directory)
      expect(config.theme).toBe("fallback")
    }),
  ),
)

it.instance("missing tui.json - silently treated as empty (ENOENT path)", () =>
  withCleanState(
    Effect.gen(function* () {
      const test = yield* TestInstance
      const config = yield* getTuiConfig(test.directory)
      expect(config).toBeDefined()
      expect(config.theme).toBeUndefined()
    }),
  ),
)
