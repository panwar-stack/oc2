import path from "path"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"
import { unique } from "remeda"
import { Option, Schema } from "effect"
import { TuiConfig } from "@oc2-ai/tui/config"
import { TuiKeybind } from "@oc2-ai/tui/config/keybind"
import { Flag } from "@oc2-ai/core/flag/flag"
import { Global } from "@oc2-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import * as Log from "@oc2-ai/core/util/log"
import * as ConfigPaths from "@/config/paths"
import { ConfigVariable } from "@/config/variable"

const log = Log.create({ service: "tui.migrate" })

const decoders = {
  theme: Schema.decodeUnknownOption(Schema.String),
  keybinds: Schema.decodeUnknownOption(TuiKeybind.KeybindOverrides),
  scroll_speed: Schema.decodeUnknownOption(TuiConfig.ScrollSpeed),
  scroll_acceleration: Schema.decodeUnknownOption(TuiConfig.ScrollAcceleration),
  diff_style: Schema.decodeUnknownOption(TuiConfig.DiffStyle),
}

export type LegacyTuiInfo = Pick<
  TuiConfig.Info,
  "theme" | "keybinds" | "scroll_speed" | "scroll_acceleration" | "diff_style"
>

export type LegacyTuiContribution = {
  source: string
  directory: string
  info: LegacyTuiInfo
}

export async function extractLegacyTuiConfig(input: { cwd: string; directories: string[] }) {
  const direct = Flag.OC2_DISABLE_PROJECT_CONFIG
    ? []
    : await Filesystem.findUp(["oc2.json", "oc2.jsonc"], input.cwd, undefined, { rootFirst: true })
  const files = unique([
    ...ConfigPaths.fileInDirectory(Global.Path.config, "oc2"),
    ...(Flag.OC2_CONFIG ? [Flag.OC2_CONFIG] : []),
    ...direct,
    ...unique(input.directories)
      .filter((directory) => directory !== Global.Path.config)
      .flatMap((directory) => ConfigPaths.fileInDirectory(directory, "oc2")),
  ])

  const contributions = await Promise.all(
    files.map(async (source): Promise<LegacyTuiContribution | undefined> => {
      const text = await Filesystem.readText(source).catch(async (error) => {
        if (!(await Filesystem.exists(source))) return undefined
        log.warn("failed to read config for legacy tui extraction", { source, error })
        return undefined
      })
      if (!text) return

      const expanded = await ConfigVariable.substitute({ text, type: "path", path: source, missing: "empty" })
      const errors: JsoncParseError[] = []
      const data = parseJsonc(expanded, errors, { allowTrailingComma: true })
      if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) {
        log.warn("skipping invalid config during legacy tui extraction", { source })
        return
      }

      const info: LegacyTuiInfo = {}
      const decode = (field: keyof LegacyTuiInfo, parsed: Option.Option<unknown>) => {
        if (Option.isNone(parsed)) {
          log.warn("ignored invalid legacy tui field", { source, field })
          return
        }
        Object.assign(info, { [field]: parsed.value })
      }

      if ("theme" in data) decode("theme", decoders.theme(data.theme))
      if ("keybinds" in data) decode("keybinds", decoders.keybinds(data.keybinds))
      if ("tui" in data) {
        if (!data.tui || typeof data.tui !== "object" || Array.isArray(data.tui)) {
          log.warn("ignored invalid legacy tui field", { source, field: "tui" })
        } else {
          if ("scroll_speed" in data.tui) decode("scroll_speed", decoders.scroll_speed(data.tui.scroll_speed))
          if ("scroll_acceleration" in data.tui)
            decode("scroll_acceleration", decoders.scroll_acceleration(data.tui.scroll_acceleration))
          if ("diff_style" in data.tui) decode("diff_style", decoders.diff_style(data.tui.diff_style))
        }
      }
      if (!Object.keys(info).length) return
      return { source, directory: path.dirname(source), info }
    }),
  )
  return contributions.filter((contribution): contribution is LegacyTuiContribution => !!contribution)
}
