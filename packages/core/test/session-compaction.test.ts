import { describe, expect, test } from "bun:test"
import { Effect, DateTime, Stream } from "effect"
import { LLM, LLMEvent, Message, Model, type LLMRequest } from "@oc2-ai/llm"
import * as OpenAIChat from "@oc2-ai/llm/protocols/openai-chat"
import { Config } from "@oc2-ai/core/config"
import { ConfigCompaction } from "@oc2-ai/core/config/compaction"
import { EventV2 } from "@oc2-ai/core/event"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionCompaction } from "@oc2-ai/core/session/compaction"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionMessage } from "@oc2-ai/core/session/message"
import { SessionV2 } from "@oc2-ai/core/session"
import { Token } from "@oc2-ai/core/util/token"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      source: { type: "data", data: base64 },
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

describe("SessionCompaction serializer drop_reasoning gating", () => {
  const created = DateTime.makeUnsafe(0)
  const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
  const assistantModel = { id: ModelV2.ID.make("compact"), providerID: ProviderV2.ID.make("fake") }
  const compactionModel = Model.make({
    id: "compact",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 100_000, output: 100 } }),
  })

  // The serialized form of the newest assistant message. When the flag is on the
  // reasoning line is omitted, so each test sizes the compaction `keep.tokens`
  // budget to the matching serialized length and keeps the newest message as the
  // persisted recent tail with all older messages in the summary head.
  const recentText = "[Assistant]: Ship the refactor."
  const recentWithReasoning = `${recentText}\n[Assistant reasoning]: Imports must be ordered topologically`
  const olderReasoning = "Older reasoning step for the plan"

  const assistantWithReasoning = (id: string, text: string, reasoning: string) =>
    new SessionMessage.Assistant({
      id: messageID(id),
      type: "assistant",
      agent: "build",
      model: assistantModel,
      content: [
        new SessionMessage.AssistantText({ type: "text", id: `${id}-text`, text }),
        new SessionMessage.AssistantReasoning({ type: "reasoning", id: `${id}-reasoning`, text: reasoning }),
      ],
      time: { created },
    })
  const user = (id: string, text: string) =>
    new SessionMessage.User({
      id: messageID(id),
      type: "user",
      text,
      time: { created },
    })

  // seq 0 (assistant with reasoning) and seq 1 (user) land in the summary head;
  // seq 2 (assistant with reasoning) lands in the persisted recent tail.
  const entries = [
    { seq: 0, message: assistantWithReasoning("older", "Plan approved.", olderReasoning) },
    { seq: 1, message: user("steer", "Continue with the refactor.") },
    { seq: 2, message: assistantWithReasoning("newest", "Ship the refactor.", "Imports must be ordered topologically") },
  ]

  const runCompaction = (input: { readonly dropReasoning: boolean; readonly recentTarget: string }) =>
    Effect.gen(function* () {
      const published: Array<{ readonly type: string; readonly data: Record<string, unknown> }> = []
      const summaryRequests: LLMRequest[] = []
      const events = {
        publish: <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
          Effect.sync(() => {
            published.push({ type: definition.type, data: data as unknown as Record<string, unknown> })
            return { id: EventV2.ID.make("evt_compaction_test"), type: definition.type, data } as EventV2.Payload<D>
          }),
      } as unknown as EventV2.Interface
      const llm = {
        stream: (request: LLMRequest) => {
          summaryRequests.push(request)
          return Stream.make(LLMEvent.textDelta({ id: "compaction", text: "compacted summary" }))
        },
      }
      const compaction = SessionCompaction.make({
        events,
        llm,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep: new ConfigCompaction.Keep({ tokens: Token.estimate(input.recentTarget) }),
              }),
            }),
          }),
        ],
      })
      const compacted = yield* compaction.compactAfterOverflow({
        sessionID: SessionV2.ID.make("ses_compaction_coherence"),
        entries,
        model: compactionModel,
        request: LLM.request({
          model: compactionModel,
          messages: [Message.user("Continue with the refactor.")],
          tools: [],
          generation: { maxTokens: 128 },
        }),
        dropReasoning: input.dropReasoning,
      })
      const ended = published.find((event) => event.type === SessionEvent.Compaction.Ended.type)
      return {
        compacted,
        summaryPromptJSON: JSON.stringify(summaryRequests[0]?.messages),
        recent: typeof ended?.data.recent === "string" ? ended.data.recent : "",
        summary: typeof ended?.data.text === "string" ? ended.data.text : "",
      }
    })

  test("omits assistant reasoning from the summary head and recent tail when dropReasoning is on", async () => {
    const result = await Effect.runPromise(runCompaction({ dropReasoning: true, recentTarget: recentText }))
    expect(result.compacted).toBe(true)
    expect(result.summary).toBe("compacted summary")
    expect(result.summaryPromptJSON).toContain("Plan approved.")
    expect(result.summaryPromptJSON).toContain("Continue with the refactor.")
    expect(result.summaryPromptJSON).not.toContain("[Assistant reasoning]")
    expect(result.summaryPromptJSON).not.toContain(olderReasoning)
    expect(result.summaryPromptJSON).not.toContain("Imports must be ordered topologically")
    expect(result.recent).toBe(recentText)
  })

  test("keeps assistant reasoning in the summary head and recent tail when dropReasoning is off", async () => {
    const result = await Effect.runPromise(runCompaction({ dropReasoning: false, recentTarget: recentWithReasoning }))
    expect(result.compacted).toBe(true)
    expect(result.summary).toBe("compacted summary")
    expect(result.summaryPromptJSON).toContain(`[Assistant reasoning]: ${olderReasoning}`)
    expect(result.recent).toBe(recentWithReasoning)
  })
})
