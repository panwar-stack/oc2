import { Config } from "effect"
import { Naming } from "../naming"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))

export function truthy(key: string) {
  return Naming.truthyEnv(key)
}

const copy = Naming.env("OC2_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")

function enabledByExperimental(key: string) {
  return Naming.env(key) === undefined ? truthy("OC2_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OC2_AUTO_HEAP_SNAPSHOT: truthy("OC2_AUTO_HEAP_SNAPSHOT"),
  OC2_GIT_BASH_PATH: Naming.env("OC2_GIT_BASH_PATH"),
  OC2_DISABLE_AUTOUPDATE: truthy("OC2_DISABLE_AUTOUPDATE"),
  OC2_ALWAYS_NOTIFY_UPDATE: truthy("OC2_ALWAYS_NOTIFY_UPDATE"),
  OC2_DISABLE_PRUNE: truthy("OC2_DISABLE_PRUNE"),
  OC2_DISABLE_TERMINAL_TITLE: truthy("OC2_DISABLE_TERMINAL_TITLE"),
  OC2_SHOW_TTFD: truthy("OC2_SHOW_TTFD"),
  OC2_DISABLE_AUTOCOMPACT: truthy("OC2_DISABLE_AUTOCOMPACT"),
  OC2_DISABLE_MODELS_FETCH: truthy("OC2_DISABLE_MODELS_FETCH"),
  OC2_DISABLE_MOUSE: truthy("OC2_DISABLE_MOUSE"),
  OC2_FAKE_VCS: Naming.env("OC2_FAKE_VCS"),
  OC2_SERVER_PASSWORD: Naming.env("OC2_SERVER_PASSWORD"),
  OC2_SERVER_USERNAME: Naming.env("OC2_SERVER_USERNAME"),

  // Experimental
  OC2_EXPERIMENTAL_FILEWATCHER: bool("OC2_EXPERIMENTAL_FILEWATCHER"),
  OC2_EXPERIMENTAL_DISABLE_FILEWATCHER: bool("OC2_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  OC2_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OC2_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OC2_MODELS_URL: Naming.env("OC2_MODELS_URL"),
  OC2_MODELS_PATH: Naming.env("OC2_MODELS_PATH"),
  OC2_DB: Naming.env("OC2_DB"),

  OC2_WORKSPACE_ID: Naming.env("OC2_WORKSPACE_ID"),
  OC2_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OC2_EXPERIMENTAL_WORKSPACES"),
  OC2_EXPERIMENTAL_SESSION_SWITCHER: enabledByExperimental("OC2_EXPERIMENTAL_SESSION_SWITCHER"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OC2_DISABLE_PROJECT_CONFIG() {
    return truthy("OC2_DISABLE_PROJECT_CONFIG")
  },
  get OC2_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OC2_EXPERIMENTAL_REFERENCES")
  },
  get OC2_TUI_CONFIG() {
    return Naming.env("OC2_TUI_CONFIG")
  },
  get OC2_CONFIG() {
    return Naming.env("OC2_CONFIG")
  },
  get OC2_CONFIG_CONTENT() {
    return Naming.env("OC2_CONFIG_CONTENT")
  },
  get OC2_CONFIG_DIR() {
    return Naming.env("OC2_CONFIG_DIR")
  },
  get OC2_PURE() {
    return truthy("OC2_PURE")
  },
  get OC2_PERMISSION() {
    return Naming.env("OC2_PERMISSION")
  },
  get OC2_PLUGIN_META_FILE() {
    return Naming.env("OC2_PLUGIN_META_FILE")
  },
  get OC2_CLIENT() {
    return Naming.env("OC2_CLIENT") ?? "cli"
  },
}
