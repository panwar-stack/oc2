import { afterEach, describe, expect, mock, spyOn } from "bun:test"
import { Log } from "@oc2-ai/core/util/log"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

afterEach(() => {
  mock.restore()
})

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // The wrap ends with Effect.orDie, so the failure lives in the cause as a
      // defect. Recover the typed instance from there.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const args = error as Tool.InvalidArgumentsError
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.message).toContain(`["questions"][0]["question"]`)
    }),
  )

  it.effect("logs slow successful tool execution without input or output content", () =>
    Effect.gen(function* () {
      const logger = Log.create({ service: "tool" })
      const info = spyOn(logger, "info").mockImplementation(() => {})
      const warn = spyOn(logger, "warn").mockImplementation(() => {})
      const infoTool = yield* Tool.define(
        "slow-info-tool",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return TestClock.adjust(5_001).pipe(
              Effect.as({ title: "test", output: "secret output", metadata: { truncated: false } }),
            )
          },
        }),
      )
      const ctx = { ...makeCtx(), callID: "call-info" }
      const tool = yield* infoTool.init()

      yield* tool.execute({ input: "secret input" }, ctx)

      expect(info).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      expect(info.mock.calls[0]?.[0]).toBe("tool.slow")
      expect(info.mock.calls[0]?.[1]).toEqual({
        toolName: "slow-info-tool",
        toolCallID: "call-info",
        sessionID: ctx.sessionID,
        durationMs: 5_001,
        status: "success",
      })
    }),
  )

  it.effect("warns for very slow failed tool execution", () =>
    Effect.gen(function* () {
      const logger = Log.create({ service: "tool" })
      const info = spyOn(logger, "info").mockImplementation(() => {})
      const warn = spyOn(logger, "warn").mockImplementation(() => {})
      const warnTool = yield* Tool.define(
        "slow-warn-tool",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return TestClock.adjust(30_001).pipe(Effect.andThen(Effect.die("boom")))
          },
        }),
      )
      const ctx = { ...makeCtx(), callID: "call-warn" }
      const tool = yield* warnTool.init()
      const exit = yield* tool.execute({ input: "secret input" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(info).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toBe("tool.slow")
      expect(warn.mock.calls[0]?.[1]).toEqual({
        toolName: "slow-warn-tool",
        toolCallID: "call-warn",
        sessionID: ctx.sessionID,
        durationMs: 30_001,
        status: "error",
      })
    }),
  )
})
