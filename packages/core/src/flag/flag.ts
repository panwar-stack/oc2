import { Config } from "effect"
import { Naming } from "../naming"

const bool = (name: string) =>
  Config.boolean(Naming.canonicalEnv(name)).pipe(Config.orElse(() => Config.boolean(name)), Config.withDefault(false))

export function truthy(key: string) {
  return Naming.truthyEnv(key)
}

const copy = Naming.env("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")

function enabledByExperimental(key: string) {
  return Naming.env(key) === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: Naming.env("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: Naming.env("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: Naming.env("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: Naming.env("OPENCODE_SERVER_USERNAME"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: bool("OPENCODE_EXPERIMENTAL_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: bool("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: Naming.env("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: Naming.env("OPENCODE_MODELS_PATH"),
  OPENCODE_DB: Naming.env("OPENCODE_DB"),

  OPENCODE_WORKSPACE_ID: Naming.env("OPENCODE_WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  OPENCODE_EXPERIMENTAL_SESSION_SWITCHER: enabledByExperimental("OPENCODE_EXPERIMENTAL_SESSION_SWITCHER"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return Naming.env("OPENCODE_TUI_CONFIG")
  },
  get OPENCODE_CONFIG() {
    return Naming.env("OPENCODE_CONFIG")
  },
  get OPENCODE_CONFIG_CONTENT() {
    return Naming.env("OPENCODE_CONFIG_CONTENT")
  },
  get OPENCODE_CONFIG_DIR() {
    return Naming.env("OPENCODE_CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return Naming.env("OPENCODE_PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return Naming.env("OPENCODE_PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return Naming.env("OPENCODE_CLIENT") ?? "cli"
  },
}
