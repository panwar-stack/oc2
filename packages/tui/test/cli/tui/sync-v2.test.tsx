/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@oc2-ai/sdk/v2"
import { onMount } from "solid-js"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProviderV2, useSyncV2 } from "../../../src/context/sync-v2"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function emitTwice(events: ReturnType<typeof createEventSource>, payload: Event) {
  const event = global(payload)
  events.emit(event)
  events.emit(event)
}

async function mountSyncV2(calls = createFetch()) {
  const events = createEventSource()
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))
  await mounted
  return { app, events, sync }
}

test("sync v2 flushes buffered text deltas before step end", async () => {
  const { app, events, sync } = await mountSyncV2()

  try {
    emitTwice(events, {
      id: "evt_step_text_flush",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitTwice(events, {
      id: "evt_text_flush_start",
      type: "session.next.text.started",
      properties: { sessionID: "session-1", assistantMessageID: "msg_assistant_1", timestamp: 2, textID: "text-1" },
    })
    emitTwice(events, {
      id: "evt_text_flush_delta_1",
      type: "session.next.text.delta",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 2,
        textID: "text-1",
        delta: "hel",
      },
    })
    emitTwice(events, {
      id: "evt_text_flush_delta_2",
      type: "session.next.text.delta",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 2,
        textID: "text-1",
        delta: "lo",
      },
    })
    emitTwice(events, {
      id: "evt_step_text_done",
      type: "session.next.step.ended",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 3,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.fromSession("session-1")[0]
      return assistant?.type === "assistant" && assistant.time.completed === 3
    })
    const assistant = sync.session.message.fromSession("session-1")[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.time.completed).toBe(3)
    expect(assistant.content[0]).toMatchObject({ type: "text", id: "text-1", text: "hello" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 flushes buffered reasoning before step failure", async () => {
  const { app, events, sync } = await mountSyncV2()

  try {
    emitTwice(events, {
      id: "evt_step_reasoning_flush",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitTwice(events, {
      id: "evt_reasoning_flush_start",
      type: "session.next.reasoning.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 2,
        reasoningID: "reasoning-1",
        providerMetadata: {},
      },
    })
    emitTwice(events, {
      id: "evt_reasoning_flush_delta",
      type: "session.next.reasoning.delta",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 2,
        reasoningID: "reasoning-1",
        delta: "why",
      },
    })
    emitTwice(events, {
      id: "evt_step_reasoning_failed",
      type: "session.next.step.failed",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 3,
        error: { type: "unknown", message: "boom" },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.fromSession("session-1")[0]
      return assistant?.type === "assistant" && assistant.finish === "error"
    })
    const assistant = sync.session.message.fromSession("session-1")[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.finish).toBe("error")
    expect(assistant.content[0]).toMatchObject({ type: "reasoning", id: "reasoning-1", text: "why" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 does not duplicate buffered deltas replayed after hydration", async () => {
  const response = Promise.withResolvers<Response>()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/message") return response.promise
    return undefined
  })
  const { app, events, sync } = await mountSyncV2(calls)

  try {
    emitTwice(events, {
      id: "evt_step_hydrate_delta",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitTwice(events, {
      id: "evt_text_hydrate_start",
      type: "session.next.text.started",
      properties: { sessionID: "session-1", assistantMessageID: "msg_assistant_1", timestamp: 2, textID: "text-1" },
    })
    await wait(() => {
      const assistant = sync.session.message.fromSession("session-1")[0]
      return assistant?.type === "assistant" && assistant.content[0]?.type === "text"
    })
    const hydration = sync.session.message.sync("session-1")
    emitTwice(events, {
      id: "evt_text_hydrate_delta",
      type: "session.next.text.delta",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_1",
        timestamp: 3,
        textID: "text-1",
        delta: "hi",
      },
    })
    response.resolve(
      json({
        data: [
          {
            id: "msg_assistant_1",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", id: "text-1", text: "" }],
            time: { created: 1 },
          },
        ],
      }),
    )
    await hydration
    await wait(() => {
      const assistant = sync.session.message.fromSession("session-1")[0]
      return assistant?.type === "assistant" && assistant.content[0]?.type === "text" && assistant.content[0].text === "hi"
    })
    await Bun.sleep(80)
    const assistant = sync.session.message.fromSession("session-1")[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.content[0]).toMatchObject({ type: "text", id: "text-1", text: "hi" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 skips pending delta replay when the snapshot already contains it", async () => {
  const sessionID = "session-fresh-delta"
  const assistantMessageID = "msg_assistant_fresh_delta"
  const textID = "text-fresh-delta"
  const response = Promise.withResolvers<Response>()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return response.promise
    return undefined
  })
  const { app, events, sync } = await mountSyncV2(calls)

  try {
    emitTwice(events, {
      id: "evt_step_hydrate_fresh_delta",
      type: "session.next.step.started",
      properties: {
        sessionID,
        assistantMessageID,
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitTwice(events, {
      id: "evt_text_hydrate_fresh_start",
      type: "session.next.text.started",
      properties: { sessionID, assistantMessageID, timestamp: 2, textID },
    })
    await wait(() => {
      const assistant = sync.session.message.fromSession(sessionID)[0]
      return assistant?.type === "assistant" && assistant.content[0]?.type === "text"
    })
    const hydration = sync.session.message.sync(sessionID)
    emitTwice(events, {
      id: "evt_text_hydrate_fresh_delta",
      type: "session.next.text.delta",
      properties: {
        sessionID,
        assistantMessageID,
        timestamp: 3,
        textID,
        delta: "hi",
      },
    })
    response.resolve(
      json({
        data: [
          {
            id: assistantMessageID,
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", id: textID, text: "hi" }],
            time: { created: 1 },
          },
        ],
      }),
    )
    await hydration
    await Bun.sleep(80)
    const assistant = sync.session.message.fromSession(sessionID)[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.content[0]).toMatchObject({ type: "text", id: textID, text: "hi" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 settles pending tools when a live failure arrives", async () => {
  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_agent_1",
      type: "session.next.agent.switched",
      properties: { sessionID: "session-1", messageID: "msg_agent_1", timestamp: 0, agent: "build" },
    })
    emitTwice(events, {
      id: "evt_model_1",
      type: "session.next.model.switched",
      properties: {
        sessionID: "session-1",
        messageID: "msg_model_1",
        timestamp: 0,
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitTwice(events, {
      id: "evt_step_started_1",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 1,
        agent: "build",
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitTwice(events, {
      id: "evt_input_1",
      type: "session.next.tool.input.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 2,
        callID: "call-1",
        name: "bash",
      },
    })
    emitTwice(events, {
      id: "evt_called_1",
      type: "session.next.tool.called",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        tool: "bash",
        input: {},
        provider: { executed: false, metadata: { fake: { call: true } } },
      },
    })
    emitTwice(events, {
      id: "evt_failed_1",
      type: "session.next.tool.failed",
      properties: {
        sessionID: "session-1",
        timestamp: 3,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        error: { type: "unknown", message: "aborted" },
        provider: { executed: false, metadata: { fake: { result: true } } },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.fromSession("session-1")[0]
      return (
        assistant?.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "error"
      )
    })

    const assistant = sync.session.message.fromSession("session-1")[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.id).toBe("msg_explicit_assistant_9")
    const tool = assistant.content[0]
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool") return
    expect(tool.state.status).toBe("error")
    if (tool.state.status !== "error") return
    expect(tool.state.error).toEqual({ type: "unknown", message: "aborted" })
    expect(tool.state.input).toEqual({})
    expect(tool.state.structured).toEqual({})
    expect(tool.state.content).toEqual([])
    expect(tool.provider).toEqual({
      executed: false,
      metadata: { fake: { call: true } },
      resultMetadata: { fake: { result: true } },
    })
    expect(sync.session.message.fromSession("session-1").map((message) => message.type)).toEqual([
      "assistant",
      "model-switched",
      "agent-switched",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 renders admitted prompts only after promotion", async () => {
  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_admitted_1",
      type: "session.next.prompt.admitted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 0,
        prompt: { text: "hello" },
        delivery: "steer",
      },
    })
    expect(sync.session.message.fromSession("session-1")).toEqual([])

    emitTwice(events, {
      id: "evt_promoted_1",
      type: "session.next.prompt.promoted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 1,
        prompt: { text: "hello" },
        timeCreated: 0,
      },
    })

    await wait(() => sync.session.message.fromSession("session-1").length === 1)
    const message = sync.session.message.fromSession("session-1")[0]
    expect(message?.type).toBe("user")
    if (message?.type !== "user") return
    expect(message).toMatchObject({ id: "msg_user_1", text: "hello" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 renders a promoted prompt when admission was missed", async () => {
  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_promoted_1",
      type: "session.next.prompt.promoted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 1,
        prompt: { text: "hello" },
        timeCreated: 0,
      },
    })

    await wait(() => sync.session.message.fromSession("session-1").length === 1)
    expect(sync.session.message.fromSession("session-1")[0]?.id).toBe("msg_user_1")
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 projects live context updates with their message ID", async () => {
  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_context_1",
      type: "session.next.context.updated",
      properties: {
        sessionID: "session-1",
        messageID: "msg_context_1",
        timestamp: 1,
        text: "Updated context",
      },
    })

    await wait(() => sync.session.message.fromSession("session-1").length === 1)
    expect(sync.session.message.fromSession("session-1")[0]).toMatchObject({
      id: "msg_context_1",
      type: "system",
      text: "Updated context",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 preserves live events while snapshot hydration is in flight", async () => {
  const events = createEventSource()
  const response = Promise.withResolvers<Response>()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/message") return response.promise
    return undefined
  })
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    const hydration = sync.session.message.sync("session-1")
    emitTwice(events, {
      id: "evt_agent_1",
      type: "session.next.agent.switched",
      properties: { sessionID: "session-1", messageID: "msg_agent_1", timestamp: 0, agent: "build" },
    })
    response.resolve(json({ data: [] }))
    await hydration

    expect(sync.session.message.fromSession("session-1").map((message) => [message.id, message.type])).toEqual([
      ["msg_agent_1", "agent-switched"],
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 replaces stale cached rows while preserving in-flight live rows", async () => {
  const events = createEventSource()
  const response = Promise.withResolvers<Response>()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/message") return response.promise
    return undefined
  })
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_promoted_1",
      type: "session.next.prompt.promoted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 1,
        prompt: { text: "stale" },
        timeCreated: 0,
      },
    })
    await wait(() => sync.session.message.fromSession("session-1")[0]?.id === "msg_user_1")
    const hydration = sync.session.message.sync("session-1")
    emitTwice(events, {
      id: "evt_agent_1",
      type: "session.next.agent.switched",
      properties: { sessionID: "session-1", messageID: "msg_agent_1", timestamp: 2, agent: "build" },
    })
    await wait(() => sync.session.message.fromSession("session-1")[0]?.id === "msg_agent_1")
    response.resolve(
      json({
        data: [{ id: "msg_user_1", type: "user", text: "fresh", time: { created: 0 } }],
      }),
    )
    await hydration

    expect(sync.session.message.fromSession("session-1").map((message) => [message.id, message.type])).toEqual([
      ["msg_agent_1", "agent-switched"],
      ["msg_user_1", "user"],
    ])
    expect(sync.session.message.fromSession("session-1")[1]).toMatchObject({ text: "fresh" })
  } finally {
    app.renderer.destroy()
  }
})

test("sync v2 preserves snapshot order and metadata for in-flight updates", async () => {
  const events = createEventSource()
  const response = Promise.withResolvers<Response>()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/message") return response.promise
    return undefined
  })
  let sync!: ReturnType<typeof useSyncV2>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSyncV2()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <SyncProviderV2>
            <Probe />
          </SyncProviderV2>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitTwice(events, {
      id: "evt_step_older",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_older",
        timestamp: 0,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitTwice(events, {
      id: "evt_step_1",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_old",
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    await wait(() => sync.session.message.fromSession("session-1")[0]?.id === "msg_assistant_old")
    const hydration = sync.session.message.sync("session-1")
    emitTwice(events, {
      id: "evt_text_1",
      type: "session.next.text.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_old",
        timestamp: 2,
        textID: "text-1",
      },
    })
    emitTwice(events, {
      id: "evt_text_older",
      type: "session.next.text.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_older",
        timestamp: 2,
        textID: "text-older",
      },
    })
    await wait(() => {
      const messages = sync.session.message.fromSession("session-1")
      return messages.every((message) => message.type !== "assistant" || message.content[0]?.type === "text")
    })
    response.resolve(
      json({
        data: [
          {
            id: "msg_assistant_new",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [],
            time: { created: 3 },
          },
          {
            id: "msg_assistant_old",
            type: "assistant",
            metadata: { source: "snapshot" },
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [],
            time: { created: 1 },
          },
        ],
      }),
    )
    await hydration
    emitTwice(events, {
      id: "evt_step_late_duplicate",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_assistant_old",
        timestamp: 1,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })

    expect(sync.session.message.fromSession("session-1").map((message) => message.id)).toEqual([
      "msg_assistant_new",
      "msg_assistant_old",
      "msg_assistant_older",
    ])
    expect(JSON.parse(JSON.stringify(sync.session.message.fromSession("session-1")[1]))).toMatchObject({
      metadata: { source: "snapshot" },
      content: [{ type: "text", id: "text-1", text: "" }],
    })
    expect(JSON.parse(JSON.stringify(sync.session.message.fromSession("session-1")[2]))).toMatchObject({
      content: [{ type: "text", id: "text-older", text: "" }],
    })
  } finally {
    app.renderer.destroy()
  }
})
