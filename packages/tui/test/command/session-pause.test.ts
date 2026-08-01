import { describe, expect, test } from "bun:test"
import type { SessionControlResult } from "@oc2-ai/sdk/v2"
import {
  affectedPauseStates,
  controlResultFeedback,
  createPauseStartCommand,
  createPauseStartCommands,
  dispatchPauseStart,
  pauseCommandEnabled,
  sessionOwnsCascade,
  unpauseCommandEnabled,
  type PauseStartAction,
  type PauseStartClient,
  type SessionPauseState,
} from "../../src/command/session-pause"

const SESSION = "ses_viewed"
const CHILD = "ses_child"
const WORKSPACE = "wrk_test"

function result(overrides: Partial<SessionControlResult> = {}): SessionControlResult {
  return {
    rootSessionID: SESSION,
    cascadeID: undefined,
    affectedSessionIDs: [SESSION],
    interruptionSignalledSessionIDs: [],
    stillBlockedSessionIDs: [],
    scheduledSessionIDs: [],
    unchanged: false,
    ...overrides,
  }
}

type PauseStartResponse = { data?: SessionControlResult; error?: unknown }

/** SDK session-control method names; the transport surface keeps the `start` name. */
type SdkAction = "pause" | "start"

function fakeClient(
  handler: (action: SdkAction, parameters: { sessionID: string; workspace?: string }) => PauseStartResponse,
) {
  const calls: { action: SdkAction; sessionID: string; workspace?: string }[] = []
  const client = {
    session: {
      async pause(parameters: { sessionID: string; workspace?: string }) {
        calls.push({ action: "pause", ...parameters })
        return handler("pause", parameters)
      },
      async start(parameters: { sessionID: string; workspace?: string }) {
        calls.push({ action: "start", ...parameters })
        return handler("start", parameters)
      },
    },
  } satisfies PauseStartClient
  return { client, calls }
}

type SlashEntry = { display: string; aliases: string[] }

function slashEntries(): SlashEntry[] {
  return createPauseStartCommands({
    sessionID: () => SESSION,
    pauseState: () => undefined,
    run: () => {},
  }).map((command) => ({
    display: `/${command.slash?.name}`,
    aliases: (command.slash?.aliases ?? []).map((alias) => `/${alias}`),
  }))
}

/**
 * Mirrors local slash resolution for a single-line input: the trimmed input must
 * equal the primary display exactly (as in
 * `packages/tui/src/component/prompt/index.tsx`), and a deprecated alias still
 * resolves to the same command the way the autocomplete dispatch path does.
 */
function matchLocalSlash(entries: SlashEntry[], input: string) {
  const trimmed = input.trim()
  if (input.includes("\n")) return undefined
  return entries.find((entry) => entry.display === trimmed || entry.aliases.includes(trimmed))
}

describe("pause/unpause slash discovery", () => {
  test("registers /pause and /unpause local session commands", () => {
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => undefined,
      run: () => {},
    })
    const names = commands.map((command) => command.slash?.name)
    expect(names).toEqual(["pause", "unpause"])
    expect(commands.map((command) => command.value)).toEqual(["session.pause", "session.unpause"])
    expect(commands.map((command) => command.category)).toEqual(["Session", "Session"])
    expect(commands.every((command) => !("hidden" in command))).toBe(true)
  })

  test("keeps /start as a deprecated alias of /unpause", () => {
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => undefined,
      run: () => {},
    })
    const unpause = commands.find((command) => command.slash?.name === "unpause")!
    expect(unpause.slash?.aliases).toEqual(["start"])
    expect(unpause.title).toBe("Unpause session")
    const pause = commands.find((command) => command.slash?.name === "pause")!
    expect(pause.slash?.aliases).toBeUndefined()
    expect(pause.title).toBe("Pause session")
  })

  test("maps through the sessionCommands() registry shape with slash displays", () => {
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => undefined,
      run: () => {},
    })
    const registry = commands.map((command) => ({
      namespace: "palette",
      name: command.value,
      slashName: command.slash?.name,
      slashAliases: command.slash?.aliases,
      ...command,
    }))
    const displays = registry.map((command) => `/${command.slashName}`)
    expect(displays).toEqual(["/pause", "/unpause"])
    const aliases = registry.map((command) => (command.slashAliases ?? []).map((alias: string) => `/${alias}`))
    expect(aliases).toEqual([[], ["/start"]])
  })

  test("does not register the misspelled /starte alias", () => {
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => undefined,
      run: () => {},
    })
    expect(commands.flatMap((command) => [command.slash?.name, ...(command.slash?.aliases ?? [])])).not.toContain(
      "starte",
    )
  })
})

describe("pause/unpause exact matching", () => {
  const entries = slashEntries()

  test("exact /pause and /unpause inputs select the matching local command", () => {
    expect(matchLocalSlash(entries, "/pause")?.display).toBe("/pause")
    expect(matchLocalSlash(entries, "/unpause")?.display).toBe("/unpause")
  })

  test("the deprecated /start alias still resolves to the unpause command", () => {
    expect(matchLocalSlash(entries, "/start")?.display).toBe("/unpause")
  })

  test("an exact /pause does not select /unpause and vice versa", () => {
    expect(matchLocalSlash(entries, "/unpause")?.display).not.toBe("/pause")
    expect(matchLocalSlash(entries, "/pause")?.display).not.toBe("/unpause")
  })

  test("/starte is not an exact match for /start or /unpause", () => {
    expect(matchLocalSlash(entries, "/starte")).toBeUndefined()
    expect(matchLocalSlash(entries, "/started")).toBeUndefined()
  })

  test("inputs with arguments or extra text do not match", () => {
    expect(matchLocalSlash(entries, "/pause now")).toBeUndefined()
    expect(matchLocalSlash(entries, "/unpause session")).toBeUndefined()
    expect(matchLocalSlash(entries, "/start session")).toBeUndefined()
  })
})

describe("pause/unpause enabled state", () => {
  test("an unknown or unpaused session can pause but not unpause", () => {
    expect(pauseCommandEnabled(undefined)).toBe(true)
    expect(unpauseCommandEnabled(undefined)).toBe(false)
    expect(pauseCommandEnabled({ paused: false })).toBe(true)
    expect(unpauseCommandEnabled({ paused: false })).toBe(false)
  })

  test("a hydrated paused session is treated as owning its cascade: unpause enabled, pause disabled", () => {
    expect(sessionOwnsCascade({ paused: true })).toBe(true)
    expect(pauseCommandEnabled({ paused: true })).toBe(false)
    expect(unpauseCommandEnabled({ paused: true })).toBe(true)
  })

  test("a locally paused session (cascadeID known) disables pause and enables unpause", () => {
    const state: SessionPauseState = { paused: true, cascadeID: "cas_1" }
    expect(sessionOwnsCascade(state)).toBe(true)
    expect(pauseCommandEnabled(state)).toBe(false)
    expect(unpauseCommandEnabled(state)).toBe(true)
  })

  test("an ancestor-blocked session can pause its own subtree but cannot unpause", () => {
    const state: SessionPauseState = { paused: true, ancestorBlocked: true }
    expect(sessionOwnsCascade(state)).toBe(false)
    expect(pauseCommandEnabled(state)).toBe(true)
    expect(unpauseCommandEnabled(state)).toBe(false)
  })

  test("a resumed session flips back to pause-enabled", () => {
    expect(pauseCommandEnabled({ paused: false })).toBe(true)
    expect(unpauseCommandEnabled({ paused: false })).toBe(false)
  })

  test("both commands are disabled without a viewed session", () => {
    const commands = createPauseStartCommands({
      sessionID: () => undefined,
      pauseState: () => undefined,
      run: () => {},
    })
    expect(commands.map((command) => command.enabled)).toEqual([false, false])
  })

  test("enabled state reacts to the viewed session's pause state", () => {
    const pauseState = { paused: true }
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => pauseState,
      run: () => {},
    })
    expect(commands.map((command) => command.enabled)).toEqual([false, true])
  })
})

describe("pause/unpause child targeting and API calls", () => {
  test("dispatching from a child view targets the child session", async () => {
    const { client, calls } = fakeClient((action) => ({
      data: result({ rootSessionID: CHILD, affectedSessionIDs: [CHILD] }),
    }))
    const dispatch = await dispatchPauseStart(client, "pause", CHILD, WORKSPACE)
    expect(dispatch).toEqual({
      ok: true,
      result: result({ rootSessionID: CHILD, affectedSessionIDs: [CHILD] }),
    })
    expect(calls).toEqual([{ action: "pause", sessionID: CHILD, workspace: WORKSPACE }])
  })

  test("pause and unpause route to the matching SDK methods", async () => {
    const { client, calls } = fakeClient(() => ({ data: result() }))
    await dispatchPauseStart(client, "pause", SESSION, undefined)
    await dispatchPauseStart(client, "unpause", SESSION, WORKSPACE)
    expect(calls).toEqual([
      { action: "pause", sessionID: SESSION, workspace: undefined },
      { action: "start", sessionID: SESSION, workspace: WORKSPACE },
    ])
  })

  test("an API error surfaces as a failed dispatch", async () => {
    const error = new Error("Session not found")
    const { client } = fakeClient(() => ({ error }))
    const dispatch = await dispatchPauseStart(client, "unpause", SESSION, WORKSPACE)
    expect(dispatch).toEqual({ ok: false, error })
  })

  test("a response without data is treated as a failed dispatch", async () => {
    const { client } = fakeClient(() => ({}))
    const dispatch = await dispatchPauseStart(client, "pause", SESSION, WORKSPACE)
    expect(dispatch.ok).toBe(false)
  })
})

describe("pause/unpause feedback", () => {
  test("pause reports affected and interrupted counts and records the cascade", () => {
    const feedback = controlResultFeedback(
      "pause",
      result({
        cascadeID: "cas_1",
        affectedSessionIDs: ["ses_lead", "ses_child"],
        interruptionSignalledSessionIDs: ["ses_child"],
      }),
    )
    expect(feedback.state).toEqual({ paused: true, cascadeID: "cas_1", ancestorBlocked: false })
    expect(feedback.variant).toBe("success")
    expect(feedback.message).toContain("Paused 2 sessions")
    expect(feedback.message).toContain("interrupted 1 running session")
  })

  test("repeated pause on the same root reports unchanged", () => {
    const feedback = controlResultFeedback("pause", result({ unchanged: true }))
    expect(feedback.variant).toBe("info")
    expect(feedback.message).toContain("already paused")
  })

  test("child unpause that stays paused by an ancestor surfaces the blocker explicitly", () => {
    const feedback = controlResultFeedback(
      "unpause",
      result({
        rootSessionID: CHILD,
        affectedSessionIDs: [CHILD, "ses_grandchild"],
        stillBlockedSessionIDs: [CHILD, "ses_grandchild"],
      }),
    )
    expect(feedback.state).toEqual({ paused: true, ancestorBlocked: true })
    expect(feedback.variant).toBe("warning")
    expect(feedback.message).toContain("stays paused by an ancestor")
  })

  test("unpause on a genuinely unpaused session reports it is not paused", () => {
    // An unchanged unpause with an empty stillBlocked set means the root owns no
    // cascade and no ancestor pause keeps it blocked.
    const feedback = controlResultFeedback("unpause", result({ unchanged: true }))
    expect(feedback.state).toEqual({ paused: false })
    expect(feedback.variant).toBe("info")
    expect(feedback.message).toContain("not paused")
  })

  test("unpause on an ancestor-blocked session without a cascade keeps the blocker state", () => {
    const feedback = controlResultFeedback("unpause", result({ unchanged: true, stillBlockedSessionIDs: [SESSION] }))
    expect(feedback.state).toEqual({ paused: true, ancestorBlocked: true })
    expect(feedback.variant).toBe("warning")
    expect(feedback.message).toContain("paused by an ancestor")
  })

  test("the ancestor warning tells the user to unpause from the ancestor", () => {
    const feedback = controlResultFeedback("unpause", result({ unchanged: true, stillBlockedSessionIDs: [SESSION] }))
    expect(feedback.message).toBe("This session is paused by an ancestor; unpause it from that ancestor")
  })

  test("an ancestor-blocked child converges: unpause disabled and pause re-enabled", () => {
    // The server reports the root in stillBlockedSessionIDs even when the child
    // owns no cascade, so the TUI converges to the ancestor-blocked state instead
    // of treating the session as not paused.
    const feedback = controlResultFeedback(
      "unpause",
      result({ rootSessionID: CHILD, unchanged: true, stillBlockedSessionIDs: [CHILD] }),
    )
    expect(feedback.state).toEqual({ paused: true, ancestorBlocked: true })
    expect(unpauseCommandEnabled(feedback.state)).toBe(false)
    expect(pauseCommandEnabled(feedback.state)).toBe(true)
    expect(feedback.variant).toBe("warning")
    expect(feedback.message).toContain("paused by an ancestor")
  })

  test("successful unpause reports resumed sessions", () => {
    const feedback = controlResultFeedback(
      "unpause",
      result({ affectedSessionIDs: [SESSION, "ses_child"], scheduledSessionIDs: ["ses_child"] }),
    )
    expect(feedback.state).toEqual({ paused: false })
    expect(feedback.variant).toBe("success")
    expect(feedback.message).toContain("resumed 1 session")
    expect(feedback.message).toContain("Unpaused")
  })
})

describe("pause/unpause affected-session reconciliation", () => {
  test("an ancestor-blocked child keeps paused/ancestorBlocked while the root clears", () => {
    const states = affectedPauseStates(
      result({
        affectedSessionIDs: [SESSION, CHILD],
        stillBlockedSessionIDs: [CHILD],
        scheduledSessionIDs: [SESSION],
      }),
      { paused: false },
    )
    expect(states).toEqual({
      [SESSION]: { paused: false },
      [CHILD]: { paused: true, ancestorBlocked: true },
    })
    // Command enablement derives from the reconciled states, not the action root.
    expect(unpauseCommandEnabled(states[CHILD])).toBe(false)
    expect(pauseCommandEnabled(states[CHILD])).toBe(true)
    expect(unpauseCommandEnabled(states[SESSION])).toBe(false)
    expect(pauseCommandEnabled(states[SESSION])).toBe(true)
  })

  test("a successful unpause clears every affected session that is no longer blocked", () => {
    const states = affectedPauseStates(
      result({
        affectedSessionIDs: [SESSION, CHILD, "ses_grandchild"],
        stillBlockedSessionIDs: [],
        scheduledSessionIDs: [CHILD, "ses_grandchild"],
      }),
      { paused: false },
    )
    expect(states).toEqual({
      [SESSION]: { paused: false },
      [CHILD]: { paused: false },
      ses_grandchild: { paused: false },
    })
  })

  test("a pause keeps affected children paused as ancestor-blocked and records the root cascade", () => {
    const states = affectedPauseStates(
      result({
        cascadeID: "cas_1",
        affectedSessionIDs: [SESSION, CHILD],
        stillBlockedSessionIDs: [SESSION, CHILD],
      }),
      { paused: true, cascadeID: "cas_1", ancestorBlocked: false },
    )
    expect(states).toEqual({
      [SESSION]: { paused: true, cascadeID: "cas_1", ancestorBlocked: false },
      [CHILD]: { paused: true, ancestorBlocked: true },
    })
    expect(sessionOwnsCascade(states[SESSION])).toBe(true)
    expect(sessionOwnsCascade(states[CHILD])).toBe(false)
  })

  test("an unchanged start without cascade history still records the root feedback state", () => {
    const states = affectedPauseStates(
      result({ affectedSessionIDs: [], unchanged: true, stillBlockedSessionIDs: [SESSION] }),
      { paused: true, ancestorBlocked: true },
    )
    expect(states).toEqual({ [SESSION]: { paused: true, ancestorBlocked: true } })
  })
})

describe("pause/unpause whitespace handling", () => {
  const entries = slashEntries()

  test("trailing and leading whitespace still matches after trimming", () => {
    expect(matchLocalSlash(entries, "/pause  ")?.display).toBe("/pause")
    expect(matchLocalSlash(entries, "  /unpause")?.display).toBe("/unpause")
    expect(matchLocalSlash(entries, " /pause ")?.display).toBe("/pause")
    expect(matchLocalSlash(entries, "  /start")?.display).toBe("/unpause")
  })

  test("multi-line input never matches a local slash", () => {
    expect(matchLocalSlash(entries, "/pause\ncontinue")).toBeUndefined()
    expect(matchLocalSlash(entries, "/unpause\n")).toBeUndefined()
    expect(matchLocalSlash(entries, "/start\n")).toBeUndefined()
  })
})

describe("pause/unpause command collisions", () => {
  test("command values and slash names are unique across the session registry", () => {
    const commands = createPauseStartCommands({
      sessionID: () => SESSION,
      pauseState: () => undefined,
      run: () => {},
    })
    const existing = [
      "session.rename",
      "session.timeline",
      "session.fork",
      "session.compact",
      "session.undo",
      "session.redo",
      "session.sidebar.toggle",
      "session.background",
      "session.child.first",
    ]
    const values = [...existing, ...commands.map((command) => command.value)]
    expect(new Set(values).size).toBe(values.length)
    const slashes = commands.map((command) => command.slash?.name)
    expect(new Set(slashes).size).toBe(slashes.length)
  })

  test("an exact local slash match wins over a configured server command", () => {
    // Prompt dispatch: internal slash is resolved first; only unmatched /-prefixed
    // input falls through to `sync.data.command` server commands.
    const configuredCommands = [{ name: "pause" }, { name: "unpause" }]
    const entries = slashEntries()
    const input = "/pause"
    const local = matchLocalSlash(entries, input)
    const isConfigured = configuredCommands.some((command) => command.name === input.slice(1))
    expect(local?.display).toBe("/pause")
    expect(isConfigured).toBe(true)
    expect(local).toBeDefined() // local dispatch happens before the server command
  })

  test("the deprecated /start alias resolves locally before a server /start command", () => {
    const configuredCommands = [{ name: "start" }]
    const entries = slashEntries()
    const local = matchLocalSlash(entries, "/start")
    const isConfigured = configuredCommands.some((command) => command.name === "start")
    expect(local?.display).toBe("/unpause")
    expect(isConfigured).toBe(true)
    expect(local).toBeDefined()
  })
})

describe("pause/unpause command run", () => {
  test("running the command invokes the action with the viewed session", () => {
    const runs: PauseStartAction[] = []
    const commands = createPauseStartCommands({
      sessionID: () => CHILD,
      pauseState: () => undefined,
      run: (action) => runs.push(action),
    })
    const pause = commands.find((command) => command.value === "session.pause")!
    const unpause = commands.find((command) => command.value === "session.unpause")!
    pause.run()
    unpause.run()
    expect(runs).toEqual(["pause", "unpause"])
  })

  test("the single-command factory targets its own action", () => {
    const runs: PauseStartAction[] = []
    const command = createPauseStartCommand("unpause", {
      sessionID: () => CHILD,
      pauseState: () => ({ paused: true }),
      run: (action) => runs.push(action),
    })
    expect(command.value).toBe("session.unpause")
    expect(command.slash?.name).toBe("unpause")
    expect(command.enabled).toBe(true)
    command.run()
    expect(runs).toEqual(["unpause"])
  })
})
