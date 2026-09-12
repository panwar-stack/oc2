import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config as AppConfig } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { Runner } from "@/effect/runner"
import { Session } from "@/session/session"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { Team } from "@/team/team"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { TeamMemberTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffectShared, pollWithTimeout, awaitWithTimeout } from "../lib/effect"
import { reply } from "../lib/llm-server"
import { SessionPrompt } from "@/session/prompt"

// The integration test spawns a real child teammate OS process over loopback
// TCP. The test process is the "lead": it hosts the control-plane HTTP server
// (shared memoMap so the /result handler reaches the same reconciler/DB), the
// lead session's prompt loop, and the durable team rows.

const opencodeRoot = path.resolve(import.meta.dir, "../../../..")
const cliEntry = path.join(opencodeRoot, "packages/opencode/src/index.ts")

// Use a dedicated on-disk sqlite file for this test so the in-test services and
// the HTTP server handlers (which the shared memoMap dedupes only when the
// layer graph is identical) read the same durable rows. The global test
// preload sets OC2_DB=:memory:, and distinct `:memory:` connections are
// distinct databases, which would make /result settlement see no admission.
import { mkdtempSync, rmSync } from "fs"
import os from "os"
const mpDbDir = mkdtempSync(path.join(os.tmpdir(), "oc2-mp-db-"))
process.env.OC2_DB = path.join(mpDbDir, "lead.sqlite")

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)

const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

// The lead stack: same services the HTTP handlers resolve (shared memoMap),
// plus the real prompt loop, reconciler, and the mock LLM server both the lead
// loop and the child reach over real TCP.
const it = testEffectShared(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    AppConfig.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    LifecycleReconciler.defaultLayer,
    Session.defaultLayer,
    SessionControl.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    SessionPrompt.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer({ experimentalEventSystem: true, experimentalBackgroundSubagents: true }),
    TestLLMServer.layer,
    httpApiLayer,
  ),
)

const originalEnv: Record<string, string | undefined> = {
  OC2_TEAM_LEAD_URL: process.env.OC2_TEAM_LEAD_URL,
  OC2_CLI_ENTRY: process.env.OC2_CLI_ENTRY,
}

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await disposeAllInstances()
  await resetDatabase()
  rmSync(mpDbDir, { recursive: true, force: true })
})

// Reads the lead control-plane base URL from the real TCP listener the test
// layer serves, so the child can reach it over loopback.
const controlPlaneUrl = HttpServer.HttpServer.use((server) =>
  Effect.succeed(HttpServer.formatAddress(server.address)),
)

// Builds the prompt ops the reconciler needs to wake the parked lead loop,
// matching InstanceBootstrap (src/project/bootstrap.ts:64-70).
const makePromptOps = (prompt: SessionPrompt.Interface): LifecycleReconciler.PromptOps => ({
  cancel: (sessionID) => prompt.cancel(sessionID),
  resolvePromptParts: (template) => prompt.resolvePromptParts(template),
  prompt: (input) => Runner.keepSuspended(prompt.prompt(input)),
  wake: (sessionID) => prompt.wake(sessionID),
  run: (sessionID) => prompt.loop({ sessionID }),
})

describe("multiprocess teammate member process", () => {
  it.live(
    "spawns a real child teammate over loopback and settles to one canonical completion",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const reconciler = yield* LifecycleReconciler.Service
          const prompt = yield* SessionPrompt.Service

          // The lead control-plane URL must be set before the reconciler spawn
          // path reads it, and the CLI entrypoint must point at the real CLI
          // because argv[1] under `bun test` is this test file.
          const url = yield* controlPlaneUrl
          process.env.OC2_TEAM_LEAD_URL = url
          process.env.OC2_CLI_ENTRY = cliEntry

          // Lead session + active team + one task member (the child).
          const lead = yield* sessions.create({ title: "Lead" })
          const memberSession = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const info = yield* team.create({ name: "loopback-team", goal: "Run one task", leadSessionID: lead.id })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: memberSession.id,
            name: "worker",
            agentType: "general",
            model: ref,
            rolePrompt: "Report the number five.",
          })

          // The lead's first durable user message. The real model loop below
          // turns it into a full run that reaches the finalization barrier.
          yield* prompt.prompt({
            sessionID: lead.id,
            agent: "build",
            model: ref,
            noReply: true,
            parts: [{ type: "text", text: "coordinate" }],
          })

          // The child's model request is answered by the same in-process mock
          // LLM. The teammate entrypoint prompts with the member's role prompt
          // text as the user message, so match on that.
          const childContent = (hit: { body?: Record<string, unknown> }) =>
            (((hit.body as Record<string, unknown> | undefined)?.messages as Array<{ content?: unknown }> | undefined) ??
              [])
              .map((message) =>
                typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
              )
              .join("\n")
          const isChildRequest = (hit: { body?: Record<string, unknown> }) =>
            childContent(hit).includes("Report the number five.")
          yield* llm.pushMatch(isChildRequest, reply().text("five").stop())
          yield* llm.pushMatch(isChildRequest, reply().text("five").stop())

          // Fork the lead loop. It produces its own finalization text turn and
          // then parks at the finalization barrier while the member runs.
          yield* llm.textMatch((hit) => !isChildRequest(hit), "lead done")
          const leadFiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)

          // Drive the reconciler to start the member. With the env + config
          // gate on, this spawns the real child OS process.
          const ops = makePromptOps(prompt)
          yield* reconciler.attach(ops)
          const outcome = yield* reconciler.startMember({ memberID: member.id, ops })
          expect(outcome).toContain("member process")

          // The child fetches context, runs its prompt loop against the mock
          // LLM, syncs its transcript, reports /result; the lead settles.
          const probe = Effect.gen(function* () {
            const row = yield* team.getMemberBySession(memberSession.id)
            return Option.isSome(row) && row.value.status === "completed"
              ? (row.value as Team.Member)
              : undefined
          })
          const current = yield* pollWithTimeout(probe, "member never reached terminal completed", "60 seconds")
          expect(current.status).toBe("completed")
          // Defect-1 regression: spawn persists the SHA-256 hash of the member
          // secret on the durable row the control-plane verifier reads. The child
          // also presents that secret as Basic auth. This test runs with no
          // shared OC2_SERVER_PASSWORD (preload deletes it), so auth is disabled
          // here and the control-plane request would be allowed regardless; this
          // assertion pins the durable verifier input. The httpapi-team
          // credential suite covers positive/negative verification with a
          // shared password configured.
          const { db } = yield* Database.Service
          const credential = yield* db
            .select({ credential_hash: TeamMemberTable.credential_hash })
            .from(TeamMemberTable)
            .where(eq(TeamMemberTable.id, member.id))
            .get()
            .pipe(Effect.orDie)
          expect(credential?.credential_hash).toMatch(/^[0-9a-f]{64}$/)

          // One canonical lifecycle notification and a terminal revision bump.
          const messages = yield* team.getMessages(info.id)
          const completion = messages.filter((message) => message.id === `lifecycle:member:${member.id}:completed:1`)
          expect(completion).toHaveLength(1)
          expect(completion[0]?.body).toContain("five")

          // The parked lead loop releases once the member is terminal.
          const leadResult = yield* awaitWithTimeout(Fiber.join(leadFiber), "lead loop never released", "30 seconds")
          expect(leadResult.info.role).toBe("assistant")
          expect(leadResult.info.role === "assistant" && leadResult.info.finish).toBe("stop")

          const leadHistory = yield* sessions.messages({ sessionID: lead.id })
          const syntheticPart = (parts: readonly SessionV1.Part[]) =>
            parts.some((part): boolean => part.type === "text" && "synthetic" in part && part.synthetic === true)
          expect(leadHistory.some((message) => message.info.role === "user" && syntheticPart(message.parts))).toBe(true)
        }),
        {
          git: true,
          config: (url) => ({
            ...testProviderConfig(url),
            compaction: { auto: false },
            experimental: { agent_teams: true, team_multiprocess: true },
          }),
        },
      ),
    90_000,
  )
})
