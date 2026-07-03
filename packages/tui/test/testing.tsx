/** @jsxImportSource @opentui/solid */
import { createResource, Show, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

export { TestTuiContexts } from "./fixture/tui-environment"
export { createTuiResolvedConfig } from "./fixture/tui-runtime"
export {
  createEventSource,
  createFetch,
  directory,
  eventSource,
  json,
  wait,
  worktree,
} from "./cli/cmd/tui/sync-fixture"

export { ArgsProvider } from "../src/context/args"
export { EditorContextProvider } from "../src/context/editor"
export { KVProvider } from "../src/context/kv"
export { LocalProvider } from "../src/context/local"
export { ProjectProvider } from "../src/context/project"
export { RouteProvider } from "../src/context/route"
export { SDKProvider } from "../src/context/sdk"
export { SyncProvider, useSync } from "../src/context/sync"
export { ThemeProvider } from "../src/context/theme"
export { TuiConfigProvider } from "../src/config"
export { OpencodeKeymapProvider, registerOpencodeKeymap, useCommandSlashes } from "../src/keymap"
export { DialogProvider } from "../src/ui/dialog"
export { ToastProvider } from "../src/ui/toast"
export { PromptHistoryProvider } from "../src/component/prompt/history"
export { PromptStashProvider } from "../src/component/prompt/stash"
export { DialogRoots } from "../src/routes/session/dialog-roots"

export function SessionRootsCommand() {
  // Loading the full session route statically also loads Prompt before prompt-footer mocks register.
  const [Command] = createResource<Component>(() =>
    import("../src/routes/session").then((module) => module.SessionRootsCommand),
  )
  return <Show when={Command()}>{(Current) => <Dynamic component={Current()} />}</Show>
}
