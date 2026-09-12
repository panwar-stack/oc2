import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config as AppConfig } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { Runner } from "@/effect/runner"
import { Session } from "@/session/session"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { Team } from "@/team/team"
import { MemberProcess } from "@/team/member-process"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { Global } from "@oc2-ai/core/global"
import { Naming } from "@oc2-ai/core/naming"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { reply } from "../lib/llm-server"

// PR 5 two-process, two-data-directory loopback harness.
//
// The test process is the lead: it hosts the control-plane HTTP server (shared
// memoMap so the /result handler reaches the same reconciler/DB), the durable
// team rows, and the mock LLM. The reconciler then spawns two real child
// `teammate` OS processes over loopback TCP: one finite task member and one
// long-lived daemon member. Each child runs against its own OC2_DB transcript
// mirror; the lead DB is never opened by a child.
//
// Deterministic synchronization only: member status rows, mailbox delivery
// rows, projected transcript text, mirror files, and child process exit. No
// fixed sleep is used as a sync point.

const opencodeRoot = path.resolve(import.meta.dir, "../../../..")
const cliEntry = path.join(opencodeRoot, "packages/opencode/src/index.ts")

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

const it = testEffect(
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

/** Member session ids whose child processes this file may need to reap. */
const trackedSessions = new Set<string>()

/**
 * Reads the OS processes whose environment carries this member session id.
 * macOS/Linux expose a process environment through `ps`; Windows has no
 * portable equivalent, so it returns an empty list there and the process-exit
 * assertions degrade to the durable team-closed signal.
 */
function memberProcessLines(sessionID: string): string[] {
  if (process.platform === "win32") return []
  const needle = `OC2_TEAM_MEMBER_SESSION_ID=${sessionID}`
  try {
    const out = execFileSync("ps", ["axeww", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split("\n").filter((line) => line.includes(needle))
  } catch {
    return []
  }
}

function memberPids(sessionID: string): number[] {
  return memberProcessLines(sessionID)
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid > 0)
}

function killTrackedMemberProcesses() {
  for (const sessionID of trackedSessions) {
    for (const pid of memberPids(sessionID)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The child already exited.
      }
    }
  }
  trackedSessions.clear()
}

afterEach(async () => {
  killTrackedMemberProcesses()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await disposeAllInstances()
  await resetDatabase()
})

const controlPlaneUrl = HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

// The prompt ops the reconciler needs to drive member admission, matching
// InstanceBootstrap (src/project/bootstrap.ts).
const makePromptOps = (prompt: SessionPrompt.Interface): LifecycleReconciler.PromptOps => ({
  cancel: (sessionID) => prompt.cancel(sessionID),
  resolvePromptParts: (template) => prompt.resolvePromptParts(template),
  prompt: (input) => Runner.keepSuspended(prompt.prompt(input)),
  wake: (sessionID) => prompt.wake(sessionID),
  run: (sessionID) => prompt.loop({ sessionID }),
})

// The process-liveness witnesses below scan `ps axeww` output for the child's
// OC2_TEAM_MEMBER_SESSION_ID, which is not portable to Windows. Skipping the
// whole harness on win32 keeps the process-ALIVE polls from timing out there;
// macOS and Linux still run every assertion.
describe.skipIf(process.platform === "win32")("multiprocess two-process harness", () => {
  it.live(
    "spawns two member processes with distinct mirror databases, settles the task member, wakes the daemon across processes, and shutdown terminates them",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const reconciler = yield* LifecycleReconciler.Service
          const prompt = yield* SessionPrompt.Service

          // The lead control-plane URL is set before the reconciler spawn path
          // reads it. OC2_CLI_ENTRY must point at the real CLI because argv[1]
          // under `bun test` is this test file.
          const url = yield* controlPlaneUrl
          process.env.OC2_TEAM_LEAD_URL = url
          process.env.OC2_CLI_ENTRY = cliEntry

          const lead = yield* sessions.create({ title: "Lead" })
          const taskSession = yield* sessions.create({ parentID: lead.id, title: "Task worker" })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon worker" })
          trackedSessions.add(taskSession.id)
          trackedSessions.add(daemonSession.id)

          const info = yield* team.create({
            name: "harness-team",
            goal: "Exercise two member processes over loopback",
            leadSessionID: lead.id,
          })
          const task = yield* team.addMember({
            teamID: info.id,
            sessionID: taskSession.id,
            name: "task-worker",
            agentType: "general",
            model: ref,
            rolePrompt: "Report the number five.",
          })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "daemon-worker",
            agentType: "general",
            model: ref,
            rolePrompt: "Remain parked and answer mail.",
            lifecycle: "daemon",
            daemonState: "initializing",
            daemonLastActive: Date.now(),
          })

          // The two members must use separate transcript-mirror databases and
          // neither may be the lead DB. The spawner computes both paths from the
          // lead's data root; the assertions below verify the files exist.
          const taskMirror = MemberProcess.memberDbPath(taskSession.id)
          const daemonMirror = MemberProcess.memberDbPath(daemonSession.id)
          const leadDb = Database.path()
          expect(taskMirror).not.toBe(daemonMirror)
          expect(taskMirror).not.toBe(leadDb)
          expect(daemonMirror).not.toBe(leadDb)
          expect(taskMirror).toContain(path.join(Global.Path.data, MemberProcess.TEAMMATE_DATA_SUBDIR))
          expect(daemonMirror).toContain(path.join(Global.Path.data, MemberProcess.TEAMMATE_DATA_SUBDIR))
          expect(taskMirror).not.toContain(path.join(dir, ".oc2"))
          expect(daemonMirror).not.toContain(path.join(dir, ".oc2"))

          // The mock LLM answers each child's model call. Match on the
          // distinctive role prompt text, which stays in the conversation on the
          // daemon's later mail wake.
          const childContent = (hit: { body?: Record<string, unknown> }) =>
            (
              ((hit.body as Record<string, unknown> | undefined)?.messages as
                | Array<{ content?: unknown }>
                | undefined) ?? []
            )
              .map((message) =>
                typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
              )
              .join("\n")
          const isTaskChild = (hit: { body?: Record<string, unknown> }) =>
            childContent(hit).includes("Report the number five.")
          const isDaemonChild = (hit: { body?: Record<string, unknown> }) =>
            childContent(hit).includes("Remain parked and answer mail.")
          yield* llm.pushMatch(isTaskChild, reply().text("five").stop())
          yield* llm.pushMatch(isTaskChild, reply().text("five").stop())
          yield* llm.pushMatch(isDaemonChild, reply().text("daemon idle").stop())
          yield* llm.pushMatch(isDaemonChild, reply().text("daemon handled mail").stop())
          // Safety net for any unmatched call so a stray request cannot stall a run.
          yield* llm.push(reply().text("ok").stop())

          // Attach the reconciler; its poll loop spawns both `starting` members as
          // real child processes because the multiprocess flag is on.
          yield* reconciler.attach(makePromptOps(prompt))

          // Both children boot, fetch context, build their own mirror DB, and run.
          // File existence proves each child opened a separate OC2_DB.
          yield* pollWithTimeout(
            Effect.sync(() => (fs.existsSync(taskMirror) && fs.existsSync(daemonMirror) ? true : undefined)),
            "the two member mirror databases were never created",
            "90 seconds",
          )

          // The daemon parks for the whole run, so its process is the durable
          // liveness witness. Assert it is alive and its env names its own mirror.
          yield* pollWithTimeout(
            Effect.sync(() => (memberPids(daemonSession.id).length > 0 ? true : undefined)),
            "the daemon member process never started",
            "90 seconds",
          )
          yield* pollWithTimeout(
            Effect.sync(() =>
              memberProcessLines(daemonSession.id).some((line) => line.includes(`OC2_DB=${daemonMirror}`))
                ? true
                : undefined,
            ),
            "the daemon member process did not receive its own OC2_DB mirror path",
            "30 seconds",
          )

          // PHASE 1 (independent): the finite task member reaches terminal
          // `completed` through its real child process and produces exactly one
          // canonical completion notification.
          const taskOutcome = yield* pollWithTimeout(
            Effect.gen(function* () {
              const row = yield* team.getMemberBySession(taskSession.id)
              return Option.isSome(row) && row.value.status === "completed" ? (row.value as Team.Member) : undefined
            }),
            "the task member never reached terminal completed",
            "90 seconds",
          )
          expect(taskOutcome.status).toBe("completed")

          const messages = yield* team.getMessages(info.id)
          const completion = messages.filter((message) => message.id === `lifecycle:member:${task.id}:completed:1`)
          expect(completion).toHaveLength(1)
          expect(completion[0]?.body).toContain("five")

          // PHASE 2 (daemon): wait until the daemon process reports its initial
          // idle turn and parks, then send it mailbox mail from the lead.
          const daemonIdle = yield* pollWithTimeout(
            Effect.gen(function* () {
              const row = yield* team.getMemberBySession(daemonSession.id)
              return Option.isSome(row) && row.value.status === "idle" ? (row.value as Team.Member) : undefined
            }),
            "the daemon member never reached idle",
            "90 seconds",
          )
          expect(daemonIdle.daemon_state).toBe("idle")
          const lastActiveBeforeWake = daemonIdle.daemon_last_active ?? 0

          const mail = yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [daemonSession.id],
            body: "Harness mail: confirm the daemon woke in its own process.",
          })

          // Published signal: the mailbox recipient row moves to `delivered`
          // only after the daemon process claimed and acknowledged the message.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const list = yield* team.getMessages(info.id)
              const row = list.find((message) => message.id === mail.id)
              return row && row.delivery_status === "delivered" ? true : undefined
            }),
            "the daemon never claimed the mailbox message",
            "90 seconds",
          )

          // Stronger wake proof: the daemon's second run synced a transcript turn
          // whose text only the daemon process produced.
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const history = yield* sessions.messages({ sessionID: daemonSession.id })
              const text = history
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("\n")
              return text.includes("daemon handled mail") ? true : undefined
            }),
            "the daemon did not run the mail wake in its own process",
            "90 seconds",
          )

          // The daemon settlement after the wake refreshes its liveness clock; the
          // heartbeat may also advance it, so assert advancement only, never a value.
          const daemonAfterWake = yield* team.getMemberBySession(daemonSession.id)
          expect(Option.isSome(daemonAfterWake)).toBe(true)
          if (Option.isSome(daemonAfterWake)) {
            expect(daemonAfterWake.value.daemon_last_active ?? 0).toBeGreaterThanOrEqual(lastActiveBeforeWake)
          }

          // PHASE 3: shutdown must close the team and terminate the local member
          // processes. Drive the real HTTP shutdown handler, which owns the
          // process registry termination after the durable close commits.
          const shutdownStatus = yield* Effect.promise(() =>
            fetch(
              `${url}/team/${encodeURIComponent(info.id)}/shutdown?sessionID=${encodeURIComponent(lead.id)}&force=true&reason=${encodeURIComponent("harness complete")}`,
              { method: "POST", headers: { [Naming.headers.directory]: dir } },
            ).then((response) => response.status),
          )
          expect(shutdownStatus).toBe(200)

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const current = yield* team.get(info.id)
              return Option.isSome(current) && current.value.status === "closed" ? true : undefined
            }),
            "the team never closed",
            "15 seconds",
          )

          // Both member processes exit within a bounded window. The finite member
          // usually exited after its result; the daemon exits on team.closed or the
          // shutdown SIGTERM.
          yield* pollWithTimeout(
            Effect.sync(() => (memberPids(taskSession.id).length === 0 ? true : undefined)),
            "the task member process did not exit after shutdown",
            "30 seconds",
          )
          yield* pollWithTimeout(
            Effect.sync(() => (memberPids(daemonSession.id).length === 0 ? true : undefined)),
            "the daemon member process did not exit after shutdown",
            "30 seconds",
          )
          expect(memberPids(taskSession.id)).toHaveLength(0)
          expect(memberPids(daemonSession.id)).toHaveLength(0)
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
    180_000,
  )
})
