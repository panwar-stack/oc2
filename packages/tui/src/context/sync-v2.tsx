import { useEvent } from "./event"
import type {
  Event,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
} from "@oc2-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { onCleanup } from "solid-js"

function activeAssistant(messages: SessionMessage[]) {
  const index = messages.findIndex((message) => message.type === "assistant" && !message.time.completed)
  if (index < 0) return
  const assistant = messages[index]
  return assistant?.type === "assistant" ? assistant : undefined
}

function ownedAssistant(messages: SessionMessage[], messageID: string) {
  const message = messages.find((message) => message.type === "assistant" && message.id === messageID)
  return message?.type === "assistant" ? message : undefined
}

function activeShell(messages: SessionMessage[], callID: string) {
  const index = messages.findIndex((message) => message.type === "shell" && message.callID === callID)
  if (index < 0) return
  const shell = messages[index]
  return shell?.type === "shell" ? shell : undefined
}

function latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantTool => item.type === "tool" && (callID === undefined || item.id === callID),
  )
}

function latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
  )
}

function latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
  )
}

function assistantContentText(
  messages: SessionMessage[],
  assistantMessageID: string,
  type: "text" | "reasoning",
  contentID: string,
) {
  const assistant = ownedAssistant(messages, assistantMessageID)
  return type === "text" ? latestText(assistant, contentID)?.text : latestReasoning(assistant, contentID)?.text
}

function assistantToolPendingInput(messages: SessionMessage[], assistantMessageID: string, callID: string) {
  const tool = latestTool(ownedAssistant(messages, assistantMessageID), callID)
  return tool?.state.status === "pending" ? tool.state.input : undefined
}

function assistantContentKey(item: SessionMessageAssistant["content"][number]) {
  switch (item.type) {
    case "text":
      return `text:${item.id}`
    case "reasoning":
      return `reasoning:${item.id}`
    case "tool":
      return `tool:${item.id}`
  }
}

function toolStateRank(state: SessionMessageAssistantTool["state"]) {
  switch (state.status) {
    case "pending":
      return 0
    case "running":
      return 1
    case "completed":
    case "error":
      return 2
  }
}

function mergeAssistantToolSnapshot(
  item: SessionMessageAssistantTool,
  current: SessionMessageAssistant["content"][number] | undefined,
) {
  if (current?.type !== "tool") return item
  if (
    item.state.status === "pending" &&
    current.state.status === "pending" &&
    current.state.input.startsWith(item.state.input)
  )
    return current
  if (item.state.status === "pending" && current.state.status === "pending") return item
  return toolStateRank(current.state) >= toolStateRank(item.state) ? current : item
}

function mergeAssistantSnapshot(message: SessionMessage, live: SessionMessage | undefined) {
  if (message.type !== "assistant" || live?.type !== "assistant") return message

  const liveContent = new Map(live.content.map((item) => [assistantContentKey(item), item]))
  const mergedKeys = new Set<string>()
  const content = message.content.map((item) => {
    const key = assistantContentKey(item)
    mergedKeys.add(key)
    const current = liveContent.get(key)
    if (item.type === "text" && current?.type === "text" && current.text.startsWith(item.text))
      return { ...item, text: current.text }
    if (item.type === "reasoning" && current?.type === "reasoning" && current.text.startsWith(item.text))
      return {
        ...item,
        text: current.text,
        providerMetadata: item.providerMetadata ?? current.providerMetadata,
      }
    if (item.type === "tool") return mergeAssistantToolSnapshot(item, current)
    return item
  })

  const merged = {
    ...message,
    content: [...content, ...live.content.filter((item) => !mergedKeys.has(assistantContentKey(item)))],
  }

  const liveCompleted = live.time.completed
  if (liveCompleted === undefined) return merged

  const snapshotCompleted = message.time.completed
  if (snapshotCompleted !== undefined && snapshotCompleted > liveCompleted) return merged

  const liveIsNewer = snapshotCompleted === undefined || liveCompleted > snapshotCompleted
  if (liveIsNewer) merged.time.completed = liveCompleted
  if (live.finish !== undefined && (liveIsNewer || merged.finish === undefined)) merged.finish = live.finish
  if (live.cost !== undefined && (liveIsNewer || merged.cost === undefined)) merged.cost = live.cost
  if (live.tokens !== undefined && (liveIsNewer || merged.tokens === undefined)) merged.tokens = live.tokens
  if (live.error !== undefined && (liveIsNewer || merged.error === undefined)) merged.error = live.error
  if (live.snapshot?.end !== undefined && (liveIsNewer || merged.snapshot?.end === undefined))
    merged.snapshot = { ...merged.snapshot, end: live.snapshot.end }
  return merged
}

function prepend(messages: SessionMessage[], message: SessionMessage) {
  if (messages.some((item) => item.id === message.id)) return
  messages.unshift(message)
}

const STREAMING_FLUSH_MS = 33
const SDK_EVENT_BATCH_FLUSH_MS = 20
const MESSAGE_HISTORY_LIMIT = 100

function messageCreated(message: SessionMessage) {
  return message.time.created
}

function isActiveMessage(message: SessionMessage) {
  return (message.type === "assistant" || message.type === "shell") && message.time.completed === undefined
}

function pruneMessages(messages: SessionMessage[]) {
  if (messages.length <= MESSAGE_HISTORY_LIMIT) return messages
  const keep = new Set(
    messages
      .toSorted((left, right) => messageCreated(right) - messageCreated(left))
      .slice(0, MESSAGE_HISTORY_LIMIT)
      .map((message) => message.id),
  )
  return messages.filter((message) => keep.has(message.id) || isActiveMessage(message))
}

export const { use: useSyncV2, provider: SyncProviderV2 } = createSimpleContext({
  name: "SyncV2",
  init: () => {
    const [store, setStore] = createStore<{
      messages: {
        [sessionID: string]: SessionMessage[]
      }
    }>({
      messages: {},
    })

    const event = useEvent()
    const sdk = useSDK()
    const applied = new Set<string>()
    const buffering = new Map<string, Event[]>()
    const syncing = new Map<string, Promise<void>>()
    const deletedSessions = new Set<string>()
    function duplicate(id: string) {
      if (applied.has(id)) return true
      applied.add(id)
      if (applied.size <= 1000) return false
      const oldest = applied.values().next()
      if (!oldest.done) applied.delete(oldest.value)
      return false
    }

    function update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
      setStore(
        "messages",
        produce((draft) => {
          const messages = (draft[sessionID] ??= [])
          fn(messages)
          draft[sessionID] = pruneMessages(messages)
        }),
      )
    }

    type StreamingContentBuffer = {
      sessionID: string
      assistantMessageID: string
      contentID: string
      type: "text" | "reasoning"
      text: string
    }

    const streamingContentBuffers = new Map<string, StreamingContentBuffer>()
    let streamingContentFlushTimer: ReturnType<typeof setTimeout> | undefined

    function streamingContentKey(
      sessionID: string,
      assistantMessageID: string,
      type: "text" | "reasoning",
      contentID: string,
    ) {
      return `${sessionID}:${assistantMessageID}:${type}:${contentID}`
    }

    function scheduleStreamingContentFlush() {
      if (streamingContentFlushTimer) return
      streamingContentFlushTimer = setTimeout(flushStreamingContentBuffers, STREAMING_FLUSH_MS)
    }

    function flushStreamingContent(buffer: StreamingContentBuffer) {
      update(buffer.sessionID, (draft) => {
        const assistant = ownedAssistant(draft, buffer.assistantMessageID)
        const match =
          buffer.type === "text"
            ? latestText(assistant, buffer.contentID)
            : latestReasoning(assistant, buffer.contentID)
        if (match) match.text += buffer.text
      })
    }

    function flushStreamingContentBuffers() {
      if (streamingContentFlushTimer) {
        clearTimeout(streamingContentFlushTimer)
        streamingContentFlushTimer = undefined
      }
      const buffers = [...streamingContentBuffers.values()]
      streamingContentBuffers.clear()
      for (const buffer of buffers) flushStreamingContent(buffer)
    }

    function flushStreamingContentItem(
      sessionID: string,
      assistantMessageID: string,
      type: "text" | "reasoning",
      contentID: string,
    ) {
      const key = streamingContentKey(sessionID, assistantMessageID, type, contentID)
      const buffer = streamingContentBuffers.get(key)
      if (!buffer) return
      streamingContentBuffers.delete(key)
      flushStreamingContent(buffer)
    }

    function flushStreamingAssistant(sessionID: string, assistantMessageID: string) {
      const buffers = [...streamingContentBuffers.values()].filter(
        (buffer) => buffer.sessionID === sessionID && buffer.assistantMessageID === assistantMessageID,
      )
      for (const buffer of buffers) {
        streamingContentBuffers.delete(
          streamingContentKey(buffer.sessionID, buffer.assistantMessageID, buffer.type, buffer.contentID),
        )
        flushStreamingContent(buffer)
      }
    }

    function flushStreamingSession(sessionID: string) {
      const buffers = [...streamingContentBuffers.values()].filter((buffer) => buffer.sessionID === sessionID)
      for (const buffer of buffers) {
        streamingContentBuffers.delete(
          streamingContentKey(buffer.sessionID, buffer.assistantMessageID, buffer.type, buffer.contentID),
        )
        flushStreamingContent(buffer)
      }
    }

    function dropStreamingSession(sessionID: string) {
      for (const [key, buffer] of streamingContentBuffers) {
        if (buffer.sessionID === sessionID) streamingContentBuffers.delete(key)
      }
    }

    function deleteSession(sessionID: string) {
      deletedSessions.add(sessionID)
      dropStreamingSession(sessionID)
      buffering.delete(sessionID)
      syncing.delete(sessionID)
      setStore(
        "messages",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
    }

    function replayPendingAfterHydration(
      sessionID: string,
      pending: Event[],
      liveMessages: SessionMessage[],
      baseMessages: SessionMessage[],
    ) {
      const replayedText = new Map<string, string>()
      const replayedToolInput = new Map<string, string>()
      for (const event of pending) {
        if (event.type === "session.next.tool.called") {
          const currentTool = latestTool(
            ownedAssistant(store.messages[event.properties.sessionID] ?? [], event.properties.assistantMessageID),
            event.properties.callID,
          )
          if (currentTool && currentTool.state.status !== "pending") continue
          apply(event)
          continue
        }

        if (event.type === "session.next.tool.progress") {
          const currentTool = latestTool(
            ownedAssistant(store.messages[event.properties.sessionID] ?? [], event.properties.assistantMessageID),
            event.properties.callID,
          )
          if (currentTool?.state.status !== "running") continue

          const liveTool = latestTool(
            ownedAssistant(liveMessages, event.properties.assistantMessageID),
            event.properties.callID,
          )
          if (
            liveTool?.state.status === "running" &&
            (JSON.stringify(liveTool.state.structured) !== JSON.stringify(event.properties.structured) ||
              JSON.stringify(liveTool.state.content) !== JSON.stringify(event.properties.content))
          )
            continue

          apply(event)
          continue
        }

        if (
          event.type !== "session.next.text.delta" &&
          event.type !== "session.next.reasoning.delta" &&
          event.type !== "session.next.tool.input.delta"
        ) {
          apply(event)
          continue
        }

        if (event.type === "session.next.tool.input.delta") {
          const key = `${event.properties.sessionID}:${event.properties.assistantMessageID}:tool:${event.properties.callID}`
          const liveInput = assistantToolPendingInput(
            liveMessages,
            event.properties.assistantMessageID,
            event.properties.callID,
          )
          const currentInput =
            replayedToolInput.get(key) ??
            assistantToolPendingInput(baseMessages, event.properties.assistantMessageID, event.properties.callID) ??
            assistantToolPendingInput(
              store.messages[event.properties.sessionID] ?? [],
              event.properties.assistantMessageID,
              event.properties.callID,
            )

          if (liveInput === undefined || currentInput === undefined) {
            apply(event)
            continue
          }

          if (currentInput.startsWith(liveInput)) continue

          const delta = liveInput.startsWith(currentInput) ? liveInput.slice(currentInput.length) : event.properties.delta
          if (!delta) continue

          replayedToolInput.set(key, currentInput + delta)
          apply({ ...event, properties: { ...event.properties, delta } })
          continue
        }

        const type = event.type === "session.next.text.delta" ? "text" : "reasoning"
        const contentID = event.type === "session.next.text.delta" ? event.properties.textID : event.properties.reasoningID
        const key = streamingContentKey(event.properties.sessionID, event.properties.assistantMessageID, type, contentID)
        const liveText = assistantContentText(liveMessages, event.properties.assistantMessageID, type, contentID)
        const currentText =
          replayedText.get(key) ??
          assistantContentText(baseMessages, event.properties.assistantMessageID, type, contentID) ??
          assistantContentText(store.messages[event.properties.sessionID] ?? [], event.properties.assistantMessageID, type, contentID)

        if (liveText === undefined || currentText === undefined) {
          apply(event)
          continue
        }

        if (currentText.startsWith(liveText)) continue

        const delta = liveText.startsWith(currentText) ? liveText.slice(currentText.length) : event.properties.delta
        if (!delta) continue

        replayedText.set(key, currentText + delta)
        if (event.type === "session.next.text.delta") {
          apply({ ...event, properties: { ...event.properties, delta } })
          continue
        }
        apply({ ...event, properties: { ...event.properties, delta } })
      }
      flushStreamingSession(sessionID)
    }

    async function hydrate(sessionID: string) {
      if (deletedSessions.has(sessionID)) return
      const pending: Event[] = []
      flushStreamingSession(sessionID)
      const before = JSON.parse(JSON.stringify(store.messages[sessionID] ?? [])) as SessionMessage[]
      buffering.set(sessionID, pending)
      try {
        const response = await sdk.client.v2.session.messages({ sessionID })
        if (deletedSessions.has(sessionID)) return
        // SDKProvider batches live events briefly; keep buffering open long enough
        // for queued pre-snapshot events to reach the hydration replay path.
        await new Promise((resolve) => setTimeout(resolve, SDK_EVENT_BATCH_FLUSH_MS))
        if (deletedSessions.has(sessionID)) return
        const messages = response.data?.data ?? []
        const snapshotIDs = new Set(messages.map((message) => message.id))
        flushStreamingSession(sessionID)
        const live = JSON.parse(JSON.stringify(store.messages[sessionID] ?? [])) as SessionMessage[]
        const liveByID = new Map(live.map((message) => [message.id, message]))
        const merged = pruneMessages([
          ...messages.map((message) => mergeAssistantSnapshot(message, liveByID.get(message.id))),
          ...before.filter((message) => !snapshotIDs.has(message.id)),
        ])
        setStore(
          "messages",
          sessionID,
          reconcile(merged),
        )
        buffering.delete(sessionID)
        replayPendingAfterHydration(sessionID, pending, live, merged)
      } catch (error) {
        buffering.delete(sessionID)
        throw error
      }
    }

    function sync(sessionID: string) {
      const existing = syncing.get(sessionID)
      if (existing) return existing
      const result = hydrate(sessionID).finally(() => syncing.delete(sessionID))
      syncing.set(sessionID, result)
      return result
    }

    function apply(event: Event) {
      switch (event.type) {
        case "session.next.agent.switched":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "agent-switched",
              agent: event.properties.agent,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.model.switched":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "model-switched",
              model: event.properties.model,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.prompted": {
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "user",
              text: event.properties.prompt.text,
              files: event.properties.prompt.files,
              agents: event.properties.prompt.agents,
              references: event.properties.prompt.references,
              time: { created: event.properties.timestamp },
            })
          })
          break
        }
        case "session.next.prompt.admitted":
          break
        case "session.next.prompt.promoted":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "user",
              text: event.properties.prompt.text,
              files: event.properties.prompt.files,
              agents: event.properties.prompt.agents,
              references: event.properties.prompt.references,
              time: { created: event.properties.timeCreated },
            })
          })
          break
        case "session.next.context.updated":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "system",
              text: event.properties.text,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.synthetic":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "synthetic",
              sessionID: event.properties.sessionID,
              text: event.properties.text,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "shell",
              callID: event.properties.callID,
              command: event.properties.command,
              output: "",
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          update(event.properties.sessionID, (draft) => {
            const match = activeShell(draft, event.properties.callID)
            if (!match) return
            match.output = event.properties.output
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.step.started":
          update(event.properties.sessionID, (draft) => {
            if (draft.some((message) => message.id === event.properties.assistantMessageID)) return
            const currentAssistant = activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.properties.timestamp
            prepend(draft, {
              id: event.properties.assistantMessageID,
              type: "assistant",
              agent: event.properties.agent,
              model: event.properties.model,
              content: [],
              snapshot: event.properties.snapshot ? { start: event.properties.snapshot } : undefined,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          flushStreamingAssistant(event.properties.sessionID, event.properties.assistantMessageID)
          update(event.properties.sessionID, (draft) => {
            const currentAssistant = ownedAssistant(draft, event.properties.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = event.properties.finish
            currentAssistant.cost = event.properties.cost
            currentAssistant.tokens = event.properties.tokens
            if (event.properties.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.properties.snapshot }
          })
          break
        case "session.next.step.failed":
          flushStreamingAssistant(event.properties.sessionID, event.properties.assistantMessageID)
          update(event.properties.sessionID, (draft) => {
            const currentAssistant = ownedAssistant(draft, event.properties.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.properties.error
          })
          break
        case "session.next.text.started":
          update(event.properties.sessionID, (draft) => {
            const assistant = ownedAssistant(draft, event.properties.assistantMessageID)
            if (!assistant || latestText(assistant, event.properties.textID)) return
            assistant.content.push({
              type: "text",
              id: event.properties.textID,
              text: "",
            })
          })
          break
        case "session.next.text.delta":
          if (
            latestText(
              ownedAssistant(store.messages[event.properties.sessionID] ?? [], event.properties.assistantMessageID),
              event.properties.textID,
            )
          ) {
            const key = streamingContentKey(
              event.properties.sessionID,
              event.properties.assistantMessageID,
              "text",
              event.properties.textID,
            )
            const buffer = streamingContentBuffers.get(key)
            if (buffer) buffer.text += event.properties.delta
            else
              streamingContentBuffers.set(key, {
                sessionID: event.properties.sessionID,
                assistantMessageID: event.properties.assistantMessageID,
                contentID: event.properties.textID,
                type: "text",
                text: event.properties.delta,
              })
            scheduleStreamingContentFlush()
          }
          break
        case "session.next.text.ended":
          flushStreamingContentItem(
            event.properties.sessionID,
            event.properties.assistantMessageID,
            "text",
            event.properties.textID,
          )
          update(event.properties.sessionID, (draft) => {
            const match = latestText(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.textID,
            )
            if (match) match.text = event.properties.text
          })
          break
        case "session.next.tool.input.started":
          update(event.properties.sessionID, (draft) => {
            const assistant = ownedAssistant(draft, event.properties.assistantMessageID)
            if (!assistant || latestTool(assistant, event.properties.callID)) return
            assistant.content.push({
              type: "tool",
              id: event.properties.callID,
              name: event.properties.name,
              time: { created: event.properties.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status === "pending") match.state.input += event.properties.delta
          })
          break
        case "session.next.tool.input.ended":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status === "pending") match.state.input = event.properties.text
          })
          break
        case "session.next.tool.called":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (!match) return
            match.time.ran = event.properties.timestamp
            match.provider = event.properties.provider
            match.state = { status: "running", input: event.properties.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status !== "running") return
            match.state.structured = event.properties.structured
            match.state.content = [...event.properties.content]
          })
          break
        case "session.next.tool.success":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.properties.structured,
              content: [...event.properties.content],
              result: event.properties.result,
            }
            match.provider = {
              executed: event.properties.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.properties.provider.metadata,
            }
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.tool.failed":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.callID,
            )
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.properties.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.properties.result,
            }
            match.provider = {
              executed: event.properties.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.properties.provider.metadata,
            }
            match.time.completed = event.properties.timestamp
          })
          break
        case "session.next.reasoning.started":
          update(event.properties.sessionID, (draft) => {
            const assistant = ownedAssistant(draft, event.properties.assistantMessageID)
            if (!assistant || latestReasoning(assistant, event.properties.reasoningID)) return
            assistant.content.push({
              type: "reasoning",
              id: event.properties.reasoningID,
              text: "",
              providerMetadata: event.properties.providerMetadata,
            })
          })
          break
        case "session.next.reasoning.delta":
          if (
            latestReasoning(
              ownedAssistant(store.messages[event.properties.sessionID] ?? [], event.properties.assistantMessageID),
              event.properties.reasoningID,
            )
          ) {
            const key = streamingContentKey(
              event.properties.sessionID,
              event.properties.assistantMessageID,
              "reasoning",
              event.properties.reasoningID,
            )
            const buffer = streamingContentBuffers.get(key)
            if (buffer) buffer.text += event.properties.delta
            else
              streamingContentBuffers.set(key, {
                sessionID: event.properties.sessionID,
                assistantMessageID: event.properties.assistantMessageID,
                contentID: event.properties.reasoningID,
                type: "reasoning",
                text: event.properties.delta,
              })
            scheduleStreamingContentFlush()
          }
          break
        case "session.next.reasoning.ended":
          flushStreamingContentItem(
            event.properties.sessionID,
            event.properties.assistantMessageID,
            "reasoning",
            event.properties.reasoningID,
          )
          update(event.properties.sessionID, (draft) => {
            const match = latestReasoning(
              ownedAssistant(draft, event.properties.assistantMessageID),
              event.properties.reasoningID,
            )
            if (match) {
              match.text = event.properties.text
              if (event.properties.providerMetadata !== undefined)
                match.providerMetadata = event.properties.providerMetadata
            }
          })
          break
        case "session.next.retried":
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          update(event.properties.sessionID, (draft) => {
            prepend(draft, {
              id: event.properties.messageID,
              type: "compaction",
              reason: event.properties.reason,
              summary: event.properties.text,
              recent: event.properties.recent,
              time: { created: event.properties.timestamp },
            })
          })
          break
      }
    }

    const unsubscribe = event.subscribe((event) => {
      if (duplicate(event.id)) return
      if (event.type === "session.deleted") {
        deleteSession(event.properties.info.id)
        return
      }
      if (
        "sessionID" in event.properties &&
        typeof event.properties.sessionID === "string" &&
        deletedSessions.has(event.properties.sessionID)
      )
        return
      if ("sessionID" in event.properties && typeof event.properties.sessionID === "string")
        buffering.get(event.properties.sessionID)?.push(event)
      apply(event)
    })

    onCleanup(() => {
      unsubscribe()
      if (streamingContentFlushTimer) clearTimeout(streamingContentFlushTimer)
      streamingContentBuffers.clear()
    })

    const result = {
      data: store,
      session: {
        message: {
          sync,
          fromSession(sessionID: string) {
            const messages = store.messages[sessionID]
            if (!messages) return []
            return messages
          },
        },
      },
    }

    return result
  },
})
