import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { EventTable } from "@oc2-ai/core/event/sql"
import { InstallationVersion } from "@oc2-ai/core/installation/version"
import { ModelV2 } from "@oc2-ai/core/model"
import { Naming } from "@oc2-ai/core/naming"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { MessageTable, PartTable, SessionTable } from "@oc2-ai/core/session/sql"
import {
  OC2_PROCESS_ROLE,
  OC2_TEAM_DAEMON,
  OC2_TEAM_ID,
  OC2_TEAM_LEAD_URL,
  OC2_TEAM_LIFECYCLE,
  OC2_TEAM_MEMBER_SESSION_ID,
  OC2_TEAM_SECRET,
} from "@oc2-ai/core/util/opencode-process"
import { MemberTransport } from "@/team/member-transport"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { asc, eq } from "drizzle-orm"
import { Cause, Effect, Exit, Option } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { assistantResult } from "@/session/lifecycle-reconciler"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { CliError, effectCmd, fail } from "../effect-cmd"
import path from "path"

/** Control-plane fetch timeout for context/history/result reads. */
const CONTACT_TIMEOUT_MS = 15_000
/** Basic-auth username shared by the member env contract. */
const SERVER_USERNAME = "oc2"

/** Inline config env name for the spawned member process. The core process-role
 * constants file does not export this key yet, so it is declared locally (the
 * lead config loader reads it from `Flag.OC2_CONFIG_CONTENT`). */
const OC2_CONFIG_CONTENT = "OC2_CONFIG_CONTENT"

/** Member-local database env name. The core process-role constants file does
 * not export this key yet, so it is declared locally (the core database layer
 * reads it from `Flag.OC2_DB`). */
const OC2_DB = "OC2_DB"

/** Optional env name for the durable prompt message ID a member run should
 * use. The lead seeds this on a durable admission so a resumed member continues
 * the exact admitted prompt instead of allocating a fresh message ID. */
const OC2_TEAM_PROMPT_ID = "OC2_TEAM_PROMPT_ID"

const logTag = "teammate"

/** Member env contract read from process.env (specs/multiprocess-agent-teams.md). */
type MemberEnv = {
  leadURL: string
  teamID: string
  sessionID: string
  secret: string
  promptID?: string
  directory: string
  /** Daemon members park on the SSE stream and serve mailbox wakes instead of
   * running one finite task. Set by the spawner via `OC2_TEAM_LIFECYCLE=daemon`
   * (or `OC2_TEAM_DAEMON=1`); defaults to false so the task path is unchanged. */
  daemon: boolean
}

type WireModel = { provider_id: string; model_id: string; variant?: string }

/** Decoded member context (mirrors groups/team.ts TeamMemberContextSchema). */
type MemberContext = {
  member: {
    name: string
    agent_type: string
    role_prompt: string
    model: WireModel | null
    lifecycle: string
  }
  session?: {
    agent?: string
    model?: WireModel
    permission?: unknown
  }
  messages: SessionV1.WithParts[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeJson(text: string): unknown {
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function isTeamRequestError(body: unknown): body is { name: string; data: { message: string } } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { name?: unknown }).name === "TeamRequestError" &&
    typeof (body as { data?: { message?: unknown } }).data?.message === "string"
  )
}

function serverErrorDetail(body: unknown): string | undefined {
  if (isTeamRequestError(body)) return body.data.message
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  if (typeof body === "string" && body) return body
  return undefined
}

function sessionPath(worktree: string, directory: string) {
  return path.relative(path.resolve(worktree), directory).replaceAll("\\", "/")
}

const stripMessage = (info: SessionV1.Info): Omit<SessionV1.Info, "id" | "sessionID"> => {
  const { id: _id, sessionID: _sessionID, ...data } = info
  return data
}

const stripPart = (part: SessionV1.Part): Omit<SessionV1.Part, "id" | "sessionID" | "messageID"> => {
  const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = part
  return data
}

/** Decodes the lead context response. Extra fields are ignored, matching the
 * remote transport decoder in remote.ts. */
function decodeContext(body: unknown): MemberContext | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  const member = record.member
  const session = record.session
  if (typeof member !== "object" || member === null) return undefined
  const m = member as Record<string, unknown>
  if (typeof m.name !== "string" || typeof m.agent_type !== "string" || typeof m.role_prompt !== "string") {
    return undefined
  }
  const parseModel = (value: unknown): WireModel | null => {
    if (value === null || typeof value !== "object") return null
    const model = value as Record<string, unknown>
    if (typeof model.provider_id !== "string" || typeof model.model_id !== "string") return null
    return {
      provider_id: model.provider_id,
      model_id: model.model_id,
      ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
    }
  }
  const messages = record.messages
  const sessionCtx = (typeof session === "object" && session !== null ? session : undefined) as
    | Record<string, unknown>
    | undefined
  const permission = sessionCtx?.permission
  return {
    member: {
      name: m.name,
      agent_type: m.agent_type,
      role_prompt: m.role_prompt,
      model: parseModel(m.model),
      lifecycle: typeof m.lifecycle === "string" ? m.lifecycle : "task",
    },
    ...(sessionCtx
      ? {
          session: {
            ...(typeof sessionCtx.agent === "string" ? { agent: sessionCtx.agent } : {}),
            ...(parseModel(sessionCtx.model) ? { model: parseModel(sessionCtx.model)! } : {}),
            ...(permission !== undefined ? { permission } : {}),
          },
        }
      : {}),
    messages: Array.isArray(messages) ? (messages as SessionV1.WithParts[]) : [],
  }
}

/** Reads and validates the member env contract. Missing values produce a typed
 * CliError so the process exits nonzero and the lead owns the terminal state. */
function readMemberEnv(): MemberEnv {
  if (process.env[OC2_PROCESS_ROLE] !== "teammate") {
    throw new Error(`${logTag}: refuses to run outside the teammate process role (OC2_PROCESS_ROLE=teammate).`)
  }
  const required = [
    OC2_TEAM_LEAD_URL,
    OC2_TEAM_ID,
    OC2_TEAM_MEMBER_SESSION_ID,
    OC2_TEAM_SECRET,
    OC2_DB,
    OC2_CONFIG_CONTENT,
  ]
  const missing = required.filter((name) => !process.env[name])
  if (missing.length > 0) throw new Error(`${logTag}: missing required environment: ${missing.join(", ")}`)
  const lifecycle = process.env[OC2_TEAM_LIFECYCLE] ?? process.env[OC2_TEAM_DAEMON]
  return {
    leadURL: process.env[OC2_TEAM_LEAD_URL]!,
    teamID: process.env[OC2_TEAM_ID]!,
    sessionID: process.env[OC2_TEAM_MEMBER_SESSION_ID]!,
    secret: process.env[OC2_TEAM_SECRET]!,
    promptID: process.env[OC2_TEAM_PROMPT_ID],
    directory: process.cwd(),
    daemon: lifecycle === "daemon" || lifecycle === "1" || lifecycle === "true",
  }
}

/** Performs a control-plane request with Basic auth and the x-oc2-directory
 * header. Network failures become typed CliErrors. */
const controlPlaneRequest = (env: MemberEnv, url: string, init?: RequestInit): Effect.Effect<Response, CliError> =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers(init?.headers)
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${SERVER_USERNAME}:${env.secret}`, "utf8").toString("base64")}`,
      )
      headers.set(Naming.headers.directory, env.directory)
      if (init?.body) headers.set("Content-Type", "application/json")
      return fetch(url, { ...init, headers, signal: AbortSignal.timeout(CONTACT_TIMEOUT_MS) })
    },
    catch: (error) =>
      new CliError({
        message: `${logTag}: cannot reach control plane at ${env.leadURL}: ${errorText(error)}`,
      }),
  })

const responseBody = (response: Response): Effect.Effect<unknown, CliError> =>
  Effect.tryPromise({
    try: () => response.text().then((text) => safeJson(text)),
    catch: (error) => new CliError({ message: `${logTag}: invalid control-plane response: ${errorText(error)}` }),
  })

/** Performs a JSON control-plane request and fails on any non-2xx response
 * (TeamRequestError bodies surface their `data.message`). */
const requestExpectOk = (env: MemberEnv, url: string, init?: RequestInit): Effect.Effect<unknown, CliError> =>
  Effect.gen(function* () {
    const response = yield* controlPlaneRequest(env, url, init)
    const body = yield* responseBody(response)
    if (response.status < 200 || response.status >= 300) {
      const detail = serverErrorDetail(body)
      return yield* fail(`${logTag}: HTTP ${response.status} for ${url}${detail ? `: ${detail}` : ""}`)
    }
    return body
  })

function isSuspension(cause: Cause.Cause<unknown>): boolean {
  return Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof Runner.Suspended
}

const mirrorEventRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const env = readMemberEnv()
  return yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, env.sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
})

const mirrorSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const env = readMemberEnv()
  return yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionID.make(env.sessionID)))
    .get()
    .pipe(Effect.orDie)
})

/** Counts durable MessageTable rows in the mirror for the member session. A
 * zero count after hydration means no prior prompt ever committed, so the run
 * must use the fresh prompt path rather than `loop`. */
const countMirrorMessages = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const env = readMemberEnv()
  const rows = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, SessionID.make(env.sessionID)))
    .all()
    .pipe(Effect.orDie)
  return rows.length
})

/**
 * Headless role for a spawned teammate process. The lead cross-spawns the
 * current executable with `teammate` as the first argument and a fixed set of
 * OC2_TEAM_* environment variables (the member env contract in
 * specs/multiprocess-agent-teams.md).
 *
 * Run flow: validate the env contract, fetch the member pre-run context,
 * hydrate the local transcript mirror (SessionTable + MessageTable + PartTable
 * rows by direct insert; no session.created event and no lead history replay),
 * run the standard SessionPrompt loop to a terminal assistant turn, push the
 * run's new session events to `/transcript/sync`, report the terminal result to
 * `/result`, and exit 0.
 *
 * A typed CliError (nonzero exit) is how the process signals a failed or
 * cancelled run to the lead; the lead's `/result` or reconcile path then owns
 * the durable terminal state. External cancellation/interruption never reports
 * completion here.
 */
export const TeammateCommand = effectCmd({
  command: "teammate",
  describe: false,
  instance: true,
  handler: Effect.fn("Cli.teammate")(function* () {
    const env = yield* Effect.try({
      try: () => readMemberEnv(),
      catch: (error) => new CliError({ message: errorText(error) }),
    })
    const ctx = yield* InstanceState.context

    // The member context is the authoritative pre-run snapshot: role prompt,
    // agent, model, permission, and prior message history.
    const contextPath = `/team/${encodeURIComponent(env.teamID)}/members/${encodeURIComponent(env.sessionID)}/context`
    const contextBody = yield* requestExpectOk(
      env,
      `${env.leadURL}${contextPath}?sessionID=${encodeURIComponent(env.sessionID)}`,
    )
    const context = decodeContext(contextBody)
    if (!context) {
      return yield* fail(`${logTag}: context response did not match the expected member context shape`)
    }
    // The env hint wins, but the durable member row is authoritative for
    // daemon detection so a manually started member cannot skip its lifecycle.
    const daemon = env.daemon || context.member.lifecycle === "daemon"

    // Heartbeats are liveness transport, started before the run and stopped on
    // every exit so an idle daemon keeps its durable clock fresh between wakes
    // and a finite member reports liveness for the duration of its run. No
    // daemon_state is sent: the member heartbeat is liveness only and must not
    // change status fields the lead owns.
    const heartbeat = yield* MemberTransport.startMemberHeartbeat(env)
    const stopHeartbeat = Effect.sync(() => heartbeat())
    return yield* Effect.gen(function* () {
      if (daemon) {
        // The daemon beats for its whole parked lifetime; it stops with the process.
        yield* runDaemon(env, ctx, context)
        return
      }
      const result = yield* runMember(env, ctx, context, true)
      // Stop liveness before reporting the terminal result so no heartbeat races
      // the terminal settlement. The client is a best-effort fire-and-forget POST.
      yield* stopHeartbeat
      return yield* settleAfterRun(env, result)
    }).pipe(Effect.ensuring(stopHeartbeat))
  }),
})

/** Builds the transport connection identity from the validated member env. */
const transportConfig = (env: MemberEnv): MemberTransport.MemberTransportConfig => ({
  leadURL: env.leadURL,
  teamID: env.teamID,
  sessionID: env.sessionID,
  secret: env.secret,
  directory: env.directory,
})

/**
 * Hydrates the local transcript mirror and runs one prompt loop to a terminal
 * assistant turn. `fresh` allows the initial prompt path when the mirror has no
 * durable user message (the first run of a member session); it is false on
 * resumed daemon wakes where the mirror already holds the prior turn.
 */
const runMember = (
  env: MemberEnv,
  ctx: InstanceContext,
  context: MemberContext,
  allowFresh: boolean,
): Effect.Effect<
  Exit.Exit<SessionV1.WithParts, unknown> | undefined,
  CliError,
  Database.Service | SessionPrompt.Service
> =>
  Effect.gen(function* () {
    // RESUME vs FRESH: a SessionTable row for the member session in the mirror
    // means a prior run may have hydrated durable rows. Decide after hydration:
    // a genuine resume always has at least the durable user prompt message the
    // lead returned in context (the lead owns the admitted prompt), while a
    // crash between creating the mirror session row and the first prompt leaves
    // an empty mirror that must run the fresh prompt path. FRESH hydrates by
    // direct inserts only — never a session.created event and never a replay of
    // lead history.
    const existing = yield* mirrorSession
    if (!existing) {
      yield* createMirrorSession(env, ctx, context)
    } else {
      yield* syncMirrorSession(env, ctx, context)
    }
    yield* hydrateContextMessages(env, context.messages)
    const mirrorMessages = yield* countMirrorMessages

    const prompt = yield* SessionPrompt.Service
    if (existing && mirrorMessages > 0) {
      return yield* prompt.loop({ sessionID: SessionID.make(env.sessionID) }).pipe(Effect.exit)
    }
    if (!allowFresh) {
      // A resume with no durable user prompt has no admitted prompt to run, so
      // there is no turn to settle. The daemon stays parked and keeps beating.
      return undefined
    }
    const agentName = context.session?.agent ?? context.member.agent_type ?? "build"
    const model = context.session?.model ?? context.member.model
    return yield* prompt
      .prompt({
        sessionID: SessionID.make(env.sessionID),
        messageID: env.promptID ? MessageID.make(env.promptID) : MessageID.ascending(),
        agent: agentName,
        model: model
          ? {
              providerID: ProviderV2.ID.make(model.provider_id),
              modelID: ModelV2.ID.make(model.model_id),
            }
          : undefined,
        variant: model?.variant,
        parts: [{ type: "text", text: context.member.role_prompt }],
      })
      .pipe(Effect.exit)
  })

/**
 * Daemon lifecycle. The process reports its initial idle state, then parks on
 * the SSE events stream. A wake (mail, run request, or plan decision) claims
 * the mailbox and runs the standard prompt loop; between wakes only the
 * heartbeat keeps the durable liveness clock fresh. The stream exits cleanly on
 * `team.closed`, on a terminal member event, or on abort (interruption), and
 * the daemon then stops without reporting a terminal result — the lead owns
 * daemon settlement.
 */
const runDaemon = (
  env: MemberEnv,
  ctx: InstanceContext,
  context: MemberContext,
): Effect.Effect<void, CliError, Database.Service | SessionPrompt.Service> =>
  Effect.gen(function* () {
    // One initial run so the daemon's admission turn reaches a terminal
    // assistant turn, matching the in-process daemon path.
    const initial = yield* runMember(env, ctx, context, true)
    yield* settleAfterRun(env, initial)
    // A failed or errored initial turn already reported a terminal outcome. The
    // lead settled the daemon to cancelled, so parking would wait forever on an
    // event this process missed: exit instead. A successful turn parks below.
    if (initial !== undefined && Exit.isFailure(initial)) return
    if (initial !== undefined && Exit.isSuccess(initial)) {
      const terminal = assistantResult(initial.value.info, initial.value.parts)
      if (terminal?.state === "error") return
    }

    const handle = (event: MemberTransport.MemberEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "team.closed":
            return "stop" as const
          case "team.member.updated": {
            const status = event.properties.status
            return status === "completed" || status === "cancelled" || status === "failed"
              ? ("stop" as const)
              : ("continue" as const)
          }
          case "team.mail":
          case "team.run":
          case "team.wake": {
            const result = yield* runMember(env, ctx, context, false)
            yield* settleAfterRun(env, result)
            return "continue" as const
          }
          default:
            return "continue" as const
        }
      })

    yield* MemberTransport.openMemberEventsStream(transportConfig(env), handle)
  })

/** Converts a run exit into the transcript sync + result report sequence. An
 * undefined result means there was no admitted turn to run or settle (a daemon
 * wake with an empty mirror), so the process reports nothing. */
const settleAfterRun = (
  env: MemberEnv,
  result: Exit.Exit<SessionV1.WithParts, unknown> | undefined,
): Effect.Effect<void, CliError, Database.Service> =>
  Effect.gen(function* () {
    if (result === undefined) return
    if (Exit.isFailure(result)) {
      const cause = result.cause
      // External cancellation/interruption is not an outcome we settle here: the
      // process exits nonzero and the lead owns the terminal transition.
      if (Cause.hasInterrupts(cause)) {
        return yield* Effect.interrupt
      }
      if (isSuspension(cause)) {
        return yield* fail(`${logTag}: run suspended without reaching a terminal assistant turn`)
      }
      const text = errorText(Cause.squash(cause))
      const pushed = yield* syncTranscript(env)
      yield* reportResult(env, "cancelled", pushed, { result: text, failureCode: "provider_error" })
      return
    }
    const turn = result.value
    const terminal = assistantResult(turn.info, turn.parts)
    if (!terminal) {
      // A nonterminal assistant turn (tool-calls finish or a missing finish) is
      // not a durable terminal fact. The process exits 0 without reporting a
      // terminal outcome; the lead reconcile loop owns any later resume.
      return
    }
    const pushed = yield* syncTranscript(env)
    if (terminal.state === "error") {
      yield* reportResult(env, "cancelled", pushed, { result: terminal.text, failureCode: "provider_error" })
      return
    }
    yield* reportResult(env, "completed", pushed, { result: terminal.text })
  })

/** Inserts the member mirror SessionTable row for a fresh mirror. The row
 * satisfies the same required columns the core projector writes (see
 * `sessionRow` in projector.ts), with directory === the member's cwd. */
const createMirrorSession = (
  env: MemberEnv,
  ctx: InstanceContext,
  context: MemberContext,
): Effect.Effect<void, CliError, Database.Service> =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const model = context.session?.model ?? context.member.model
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionID.make(env.sessionID),
        project_id: ctx.project.id,
        slug: `member-${env.sessionID.slice(0, 8)}`,
        directory: env.directory,
        path: sessionPath(ctx.worktree, env.directory),
        title: `Member ${context.member.name}`,
        version: InstallationVersion,
        agent: context.session?.agent ?? context.member.agent_type,
        model: model
          ? {
              id: model.model_id,
              providerID: model.provider_id,
              ...(model.variant ? { variant: model.variant } : {}),
            }
          : undefined,
        permission: Array.isArray(context.session?.permission) ? context.session.permission : null,
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** A resumed mirror already has a session row. Refresh its agent/model/
 * permission/path columns from the lead context so the current run honors the
 * lead's durable session settings. */
const syncMirrorSession = (
  env: MemberEnv,
  ctx: InstanceContext,
  context: MemberContext,
): Effect.Effect<void, CliError, Database.Service> =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const model = context.session?.model ?? context.member.model
    yield* db
      .update(SessionTable)
      .set({
        agent: context.session?.agent ?? context.member.agent_type,
        model: model
          ? {
              id: model.model_id,
              providerID: model.provider_id,
              ...(model.variant ? { variant: model.variant } : {}),
            }
          : undefined,
        permission: Array.isArray(context.session?.permission) ? context.session.permission : null,
        path: sessionPath(ctx.worktree, env.directory),
        time_updated: Date.now(),
      })
      .where(eq(SessionTable.id, SessionID.make(env.sessionID)))
      .run()
      .pipe(Effect.orDie)
  })

/** Inserts lead context messages and their parts that are not already present
 * in the mirror. Message rows are deduped by id and part rows by part id, so a
 * crash between the two inserts never duplicates history. Parts are inserted
 * only after their parent message row exists. */
const hydrateContextMessages = (
  env: MemberEnv,
  history: readonly SessionV1.WithParts[],
): Effect.Effect<void, CliError, Database.Service> =>
  Effect.gen(function* () {
    if (history.length === 0) return
    const { db } = yield* Database.Service
    const sessionID = SessionID.make(env.sessionID)
    const existingRows = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const existing = new Set(existingRows.map((row) => String(row.id)))
    for (const msg of history) {
      const created = msg.info.time?.created ?? Date.now()
      if (!existing.has(String(msg.info.id))) {
        yield* db
          .insert(MessageTable)
          .values({
            id: msg.info.id,
            session_id: sessionID,
            time_created: created,
            data: stripMessage(msg.info),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
      for (const part of msg.parts) {
        yield* db
          .insert(PartTable)
          .values({
            id: part.id,
            message_id: msg.info.id,
            session_id: sessionID,
            time_created: created,
            data: stripPart(part),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    }
  })

/** Pushes the mirror EventTable rows the lead has not yet seen, assigning
 * contiguous sequence numbers that start at the lead aggregate tail. Returns
 * the transcript cursor (`leadTail + pushed count`) to report with the result. */
const syncTranscript = (env: MemberEnv): Effect.Effect<number, CliError, Database.Service> =>
  Effect.gen(function* () {
    const rows = yield* mirrorEventRows
    if (rows.length === 0) return 0

    // Ask the lead for the aggregate's full history with lastSeq 0. The rows are
    // EventTable rows; the member aggregate tail is the maximum seq returned.
    const historyBody: Record<string, number> = { [env.sessionID]: 0 }
    const history = yield* requestExpectOk(env, `${env.leadURL}/sync/history`, {
      method: "POST",
      body: JSON.stringify(historyBody),
    })
    const historyRows = Array.isArray(history)
      ? (history as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>)
      : []
    const ownRows = historyRows.filter((row) => row.aggregate_id === env.sessionID)
    const leadTail = ownRows.reduce((max, row) => (row.seq > max ? row.seq : max), 0)
    const knownIDs = new Set(ownRows.map((row) => row.id))
    const fresh = rows.filter((row) => !knownIDs.has(String(row.id)))
    if (fresh.length === 0) return leadTail

    const events: EventV2.SerializedEvent[] = fresh.map((row, index) => ({
      id: row.id,
      aggregateID: env.sessionID,
      seq: leadTail + index + 1,
      type: row.type,
      data: row.data,
    }))
    const syncPath = `/team/${encodeURIComponent(env.teamID)}/transcript/sync`
    yield* requestExpectOk(env, `${env.leadURL}${syncPath}?sessionID=${encodeURIComponent(env.sessionID)}`, {
      method: "POST",
      body: JSON.stringify({ directory: env.directory, events }),
    })
    return leadTail + events.length
  })

/** Reports a terminal outcome to the lead with the transcript cursor. A 2xx
 * response (including a retry-admitted lead outcome) ends the process
 * successfully; a non-2xx response becomes a typed CliError (nonzero exit). */
const reportResult = (
  env: MemberEnv,
  status: "completed" | "cancelled",
  transcriptCursor: number,
  input?: { result?: string; failureCode?: "provider_error" },
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const payload: Record<string, unknown> = {
      status,
      transcript_cursor: String(transcriptCursor),
    }
    if (input?.result !== undefined) payload.result = input.result
    if (input?.failureCode !== undefined) payload.failure_code = input.failureCode
    const resultPath = `/team/${encodeURIComponent(env.teamID)}/members/${encodeURIComponent(env.sessionID)}/result`
    yield* requestExpectOk(env, `${env.leadURL}${resultPath}?sessionID=${encodeURIComponent(env.sessionID)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  })
