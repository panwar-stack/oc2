import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { Effect, Layer, Schema } from "effect"
import os from "os"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { SessionCompoundConfig } from "../../src/session/compound/config"
import { SessionCompoundJudge } from "../../src/session/compound/judge"
import type { BranchResult } from "../../src/session/compound/runner"
import type { SessionPrompt } from "../../src/session/prompt"
import type { TaskPromptOps } from "../../src/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
  ),
)

const branches: BranchResult = {
  successes: [
    {
      index: 0,
      sessionID: SessionID.descending(),
      model: "test/branch-a",
      output: "Branch A output",
    },
  ],
  failures: [{ index: 1, model: "test/branch-b", reason: "timed out", timedOut: true }],
}

const judgeResult: SessionCompoundJudge.Result = {
  consensus: ["shared point"],
  contradictions: [],
  uniqueInsights: [{ branch: "0", insight: "specific detail" }],
  blindSpots: ["needs verification"],
  failures: [{ branch: "1", reason: "timed out" }],
  confidence: "medium",
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  const model = SessionCompoundConfig.parseModel(
    `${input.model?.providerID ?? "test"}/${input.model?.modelID ?? "judge"}`,
  )
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function stubOps(input: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (prompt) =>
      Effect.sync(() => {
        input.onPrompt?.(prompt)
        return reply(prompt, input.text)
      }),
    wake: (sessionID) => Effect.succeed(reply({ sessionID, parts: [] }, "done")),
  }
}

describe("compound judge", () => {
  test("builds an analysis-only prompt from branches and failures", () => {
    const prompt = SessionCompoundJudge.buildPrompt({
      judge: { model: "test/judge" },
      branches,
      tempDir: "/tmp/opencode-local-fusion/test/judge",
    })

    expect(prompt).toContain("structured guidance for the synthesizer")
    expect(prompt).toContain("structured analysis only")
    expect(prompt).toContain("Do not edit workspace files")
    expect(prompt).toContain("/tmp/opencode-local-fusion/test/judge")
    expect(prompt).toContain("Branch A output")
    expect(prompt).toContain("timed out")
    expect(prompt).not.toContain("Original request")
    expect(prompt).not.toContain("Synthesize one final answer")
  })

  test("validates judge result shape", () => {
    expect(Schema.decodeUnknownSync(SessionCompoundJudge.Result)(judgeResult)).toEqual(judgeResult)
    expect(() =>
      Schema.decodeUnknownSync(SessionCompoundJudge.Result)({ ...judgeResult, confidence: "certain" }),
    ).toThrow()
  })

  test("request prep honors wildcard tool filtering", async () => {
    const disabled = await prepareTools({ "*": false })
    const readonly = await prepareTools({ "*": false, read: true })

    expect(Object.keys(disabled)).toEqual([])
    expect(Object.keys(readonly)).toEqual(["read"])
  })

  it.instance("executes with tools disabled and parses JSON analysis", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      const result = yield* SessionCompoundJudge.run({
        sessionID: parent.id,
        judge: { model: "test/judge", variant: "judge-high" },
        branches,
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input), text: JSON.stringify(judgeResult) }),
      })

      expect(result).toEqual(judgeResult)
      expect(String(prompts[0]?.model?.modelID)).toBe("judge")
      expect(prompts[0]?.variant).toBe("judge-high")
      expect(prompts[0]?.tools).toEqual({ "*": false })
      expect(prompts[0]?.format).toBeUndefined()
    }),
  )

  it.instance("applies readonly judge tool policy", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompoundJudge.run({
        sessionID: parent.id,
        judge: { model: "test/judge", toolPolicy: "readonly" },
        branches,
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input), text: JSON.stringify(judgeResult) }),
      })

      expect(prompts[0]?.tools).toEqual({
        "*": false,
        read: true,
        grep: true,
        glob: true,
        webfetch: true,
        websearch: true,
        lsp: true,
      })
    }),
  )

  it.instance("keeps judge scratch directory outside session roots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      yield* sessions.addRoot({
        sessionID: parent.id,
        directory: path.dirname(path.resolve(os.tmpdir())),
        name: "temp parent",
      })
      yield* sessions.addRoot({ sessionID: parent.id, directory: os.tmpdir(), name: "system temp" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompoundJudge.run({
        sessionID: parent.id,
        judge: { model: "test/judge", toolPolicy: "parent_without_teams" },
        branches,
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input), text: JSON.stringify(judgeResult) }),
      })
      const children = yield* sessions.children(parent.id)
      const childPermission = children[0]?.permission ?? []
      const tempEditAllow = childPermission.find(
        (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
      )
      const tempDir = path.resolve(parent.directory, tempEditAllow?.pattern.replace(/\/\*$/, "") ?? ".")

      expect(prompts[0]?.tools).toMatchObject({ write: true, edit: true, apply_patch: false })
      expect(containsPath(path.resolve(os.tmpdir()), tempDir)).toBe(false)
      expect(containsPath(path.dirname(path.resolve(os.tmpdir())), tempDir)).toBe(false)
      expect(Permission.evaluate("edit", "package.json", childPermission).action).toBe("deny")
      expect(
        Permission.evaluate("edit", tempEditAllow?.pattern.replace(/\/\*$/, "/scratch.txt") ?? "", childPermission)
          .action,
      ).toBe("allow")
    }),
  )

  it.instance("keeps parent edit deny above judge scratch edit allow", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({
        title: "parent",
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      yield* SessionCompoundJudge.run({
        sessionID: parent.id,
        judge: { model: "test/judge", toolPolicy: "all" },
        branches,
        promptOps: stubOps({ text: JSON.stringify(judgeResult) }),
      })
      const children = yield* sessions.children(parent.id)
      const childPermission = children[0]?.permission ?? []
      const tempEditAllow = childPermission.find(
        (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
      )

      expect(tempEditAllow).toBeDefined()
      expect(
        Permission.evaluate("edit", tempEditAllow?.pattern.replace(/\/\*$/, "/scratch.txt") ?? "", childPermission)
          .action,
      ).toBe("deny")
    }),
  )
})

function containsPath(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function prepareTools(tools: Record<string, boolean>) {
  return (
    await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: MessageID.ascending(),
          sessionID: SessionID.descending(),
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "model" },
          tools,
        } as any,
        sessionID: SessionID.descending(),
        model: {
          id: "test/model",
          providerID: "test",
          headers: {},
          options: {},
          capabilities: {},
          limit: { output: 4096 },
          api: { id: "model", npm: "@ai-sdk/openai" },
        } as any,
        agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "hello" }],
        tools: { bash: {} as any, read: {} as any },
        provider: { id: "test", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )
  ).tools
}
