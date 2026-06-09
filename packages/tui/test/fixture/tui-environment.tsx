/** @jsxImportSource @opentui/solid */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import { onCleanup, type ParentProps } from "solid-js"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
  }>,
) {
  const state = props.paths?.state ?? createTestState()
  if (!props.paths?.state) onCleanup(() => rmSync(state, { recursive: true, force: true }))

  return (
    <TuiPathsProvider
      value={{
        cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/tui",
        home: "/tmp/opencode/home",
        worktree: "/tmp/opencode",
        ...props.paths,
        state,
      }}
    >
      <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
        <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
      </TuiTerminalEnvironmentProvider>
    </TuiPathsProvider>
  )
}

function createTestState() {
  const state = mkdtempSync(path.join(os.tmpdir(), "opencode-tui-"))
  writeFileSync(path.join(state, "kv.json"), "{}")
  return state
}
