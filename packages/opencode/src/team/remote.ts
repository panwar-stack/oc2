import { Team } from "./team"
import {
  OC2_TEAM_LEAD_URL,
  OC2_TEAM_ID,
  OC2_TEAM_MEMBER_SESSION_ID,
  OC2_TEAM_SECRET,
} from "@oc2-ai/core/util/opencode-process"
import { Runner } from "@/effect/runner"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpBody, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Connection identity for the remote Team.Service control-plane client. */
export type Info = {
  leadURL: string
  teamID: string
  memberSessionID: string
  secret: string
  directory: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/TeamRemoteConfig") {
  static layer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get defaultLayer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const leadURL = process.env[OC2_TEAM_LEAD_URL]
        const teamID = process.env[OC2_TEAM_ID]
        const memberSessionID = process.env[OC2_TEAM_MEMBER_SESSION_ID]
        const secret = process.env[OC2_TEAM_SECRET]
        if (!leadURL || !teamID || !memberSessionID || !secret) {
          return yield* Effect.die(
            new Error(
              "TeamRemote.Config: missing teammate environment. Required: " +
                [OC2_TEAM_LEAD_URL, OC2_TEAM_ID, OC2_TEAM_MEMBER_SESSION_ID, OC2_TEAM_SECRET]
                  .filter((name) => !process.env[name])
                  .join(", "),
            ),
          )
        }
        return Config.of({
          leadURL,
          teamID,
          memberSessionID,
          secret,
          directory: process.cwd(),
        })
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Wire schemas (snake_case payload/result shapes that mirror groups/team.ts)
//
// The server serializers omit null/undefined optional JSON fields for tasks
// (toTask in handlers/team.ts spreads only non-null values), while member and
// message serializers always include every nullable field with an explicit
// null. Struct decoding here is intentionally non-exact (the default): extra
// response fields (for example the E7 context response's `session` and
// `messages`) are stripped, never rejected.
// ---------------------------------------------------------------------------

const WireTeamInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  goal: Schema.String,
  lead_session_id: Schema.String,
  status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const WireMemberModel = Schema.Struct({
  provider_id: Schema.String,
  model_id: Schema.String,
  variant: Schema.optional(Schema.String),
})

const WireMember = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  session_id: Schema.String,
  name: Schema.String,
  agent_type: Schema.String,
  model: Schema.NullOr(WireMemberModel),
  role_prompt: Schema.String,
  status: Schema.String,
  lifecycle: Schema.String,
  daemon_state: Schema.NullOr(Schema.String),
  daemon_last_active: Schema.NullOr(Schema.Number),
  daemon_error: Schema.NullOr(Schema.String),
  plan_mode: Schema.Boolean,
  work_mode: Schema.String,
  dependency_ids: Schema.NullOr(Schema.Array(Schema.String)),
  result: Schema.NullOr(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const WireMemberContext = Schema.Struct({
  team: WireTeamInfo,
  member: WireMember,
})

const WireTaskHandoff = Schema.Struct({
  summary: Schema.String,
  changed_paths: Schema.Array(Schema.String),
  verification: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      status: Schema.Literals(["passed", "failed", "not_run"]),
      detail: Schema.optional(Schema.String),
    }),
  ),
  risks: Schema.optional(Schema.Array(Schema.String)),
})

const WireTask = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  description: Schema.String,
  status: Schema.String,
  assignee: Schema.optional(Schema.String),
  dependency_ids: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  owned_paths: Schema.Array(Schema.String),
  handoff: Schema.NullOr(WireTaskHandoff),
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const WireMessage = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  sender: Schema.String,
  recipients: Schema.Array(Schema.String),
  body: Schema.String,
  delivery_status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const WireTeamSendMessagePayload = Schema.Struct({
  recipients: Schema.Array(Schema.String),
  body: Schema.String,
})

const WireTeamMemberResult = Schema.Struct({
  member_id: Schema.String,
  session_id: Schema.String,
  status: Schema.String,
})

const WireTeamRequestError = Schema.Struct({
  name: Schema.Literal("TeamRequestError"),
  data: Schema.Struct({
    message: Schema.String,
  }),
})

const WireEvalNode = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  ref: Schema.String,
  label: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const WireEvalReport = Schema.Struct({
  team_id: Schema.String,
  generated_at: Schema.Number,
  nodes: Schema.Array(WireEvalNode),
})

// ---------------------------------------------------------------------------
// Decoders: wire -> domain Team types
// ---------------------------------------------------------------------------

/** Decodes unknown input with a schema, returning undefined on any mismatch. */
const decodeWire = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(input))

const decodeTeamInfo = (input: unknown): Team.Info | undefined => {
  const wire = decodeWire(WireTeamInfo, input)
  if (!wire) return undefined
  return {
    id: wire.id,
    name: wire.name,
    goal: wire.goal,
    lead_session_id: wire.lead_session_id,
    status: wire.status as Team.Info["status"],
    // The transport omits these durable fields; the member process fills stable
    // defaults so callers observe the same shape the local service returns for
    // the member branch (the wire intentionally never shares the lead's
    // revision/final-report state with a member process).
    protocol_version: 0,
    revision: 0,
    final_report_revision: null,
    time_created: wire.time_created,
    time_updated: wire.time_updated,
  }
}

const wireModelToMemberModel = (model: typeof WireMemberModel.Type | null): Team.Member["model"] =>
  model == null
    ? null
    : {
        providerID: model.provider_id,
        modelID: model.model_id,
        ...(model.variant !== undefined ? { variant: model.variant } : {}),
      }

const toMemberFromWire = (wire: typeof WireMember.Type): Team.Member => ({
  id: wire.id,
  team_id: wire.team_id,
  session_id: wire.session_id,
  name: wire.name,
  agent_type: wire.agent_type,
  model: wireModelToMemberModel(wire.model),
  role_prompt: wire.role_prompt,
  status: wire.status as Team.MemberStatus,
  lifecycle: wire.lifecycle as Team.MemberLifecycle,
  daemon_state: wire.daemon_state as Team.MemberDaemonState | null,
  daemon_last_active: wire.daemon_last_active,
  daemon_error: wire.daemon_error,
  plan_mode: wire.plan_mode,
  work_mode: wire.work_mode as "plan" | "implement",
  dependency_ids: wire.dependency_ids ? [...wire.dependency_ids] : null,
  result: wire.result ?? undefined,
  // Not on the wire; the member process owns its defaults.
  failure_code: null,
  run_generation: 0,
  time_created: wire.time_created,
  time_updated: wire.time_updated,
})

const toTaskHandoff = (wire: typeof WireTaskHandoff.Type | null): Team.TaskHandoff | null => {
  if (wire == null) return null
  return {
    summary: wire.summary,
    changed_paths: [...wire.changed_paths],
    verification: wire.verification.map((entry) => ({
      command: entry.command,
      status: entry.status,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    })),
    ...(wire.risks !== undefined ? { risks: [...wire.risks] } : {}),
  }
}

const toTaskFromWire = (wire: typeof WireTask.Type): Team.Task => ({
  id: wire.id,
  team_id: wire.team_id,
  description: wire.description,
  status: wire.status as Team.TaskStatus,
  assignee: wire.assignee ?? null,
  dependency_ids: wire.dependency_ids ? [...wire.dependency_ids] : null,
  metadata: wire.metadata ?? null,
  owned_paths: [...wire.owned_paths],
  // The transport omits reservation rows; listing/claim/update over HTTP do not
  // expose the per-reservation ownership detail to a member process.
  reservations: [],
  handoff: toTaskHandoff(wire.handoff),
  time_created: wire.time_created,
  time_updated: wire.time_updated,
})

const toMessageFromWire = (wire: typeof WireMessage.Type): Team.Message => ({
  id: wire.id,
  team_id: wire.team_id,
  sender: wire.sender,
  recipients: [...wire.recipients],
  body: wire.body,
  delivery_status: wire.delivery_status as Team.Message["delivery_status"],
  time_created: wire.time_created,
  time_updated: wire.time_updated,
})

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Public error for control-plane operations that have no endpoint or whose
 * response is unusable. Kept defect-only in the `never` error-channel service
 * methods (the interface those methods implement declares no typed error) and
 * used as a typed `Error`-derived failure in the `Error`-channel methods such
 * as task claim/update. TaggedErrorClass instances extend Error. */
export class TeamRemoteError extends Schema.TaggedErrorClass<TeamRemoteError>()("Team.RemoteUnavailable", {
  message: Schema.String,
}) {}

/** Makes a "not remotely reachable" failure a defect so methods whose interface
 * declares no typed error channel still type-check and surface as a defect in
 * the calling tool (tools convert typed errors and defects identically through
 * Effect.orDie). */
const unavailable = (operation: string, detail: string): Effect.Effect<never> =>
  Effect.die(
    new TeamRemoteError({
      message: `Remote Team operation ${operation} is unavailable in a teammate process: ${detail}`,
    }),
  )

/** Username/secret pair shared by teammate processes. The server's auth
 * middleware only enforces credentials when OC2_SERVER_PASSWORD is set, and
 * compares the configured username (default "oc2"). */
const SERVER_USERNAME = "oc2"

// The layer tag read is deferred with Layer.suspend: remote.ts is imported by
// effect/run-service.ts, and run-service sits in a module cycle with team.ts
// (team.ts -> ... -> run-service -> remote -> team). Reading Team.Service
// eagerly at module scope throws a temporal-dead-zone error when the cycle
// re-enters remote.ts before team.ts finishes evaluating. The suspend defers
// the read until the layer is actually built.
export const remoteLayer = Layer.suspend(() =>
  Layer.effect(
    Team.Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const config = yield* Config
    const { leadURL, teamID, memberSessionID, secret, directory } = config
    const ownSession = memberSessionID
    const base = Buffer.from(`${SERVER_USERNAME}:${secret}`, "utf8").toString("base64")
    // The control-plane routing middleware resolves the instance directory from
    // the x-oc2-directory header when no explicit query value is present.
    const baseHeaders: Record<string, string> = {
      Authorization: `Basic ${base}`,
      "x-oc2-directory": directory,
    }

    const url = (path: string) => {
      const baseURL = leadURL.replace(/\/+$/, "")
      return path.startsWith("/") ? `${baseURL}${path}` : `${baseURL}/${path}`
    }
    const withSession = (path: string) =>
      `${path}${path.includes("?") ? "&" : "?"}sessionID=${encodeURIComponent(ownSession)}`
    // Every transport fault becomes a defect so service methods keep the exact
    // error channels their Team.Interface declarations require (tools convert
    // typed errors and defects identically through Effect.orDie).
    const exec = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(HttpClientRequest.setHeaders(request, baseHeaders)).pipe(Effect.orDie)
    /** GET an endpoint, returning the raw response so callers apply semantics. */
    const getResponse = (path: string) => exec(HttpClientRequest.get(withSession(url(path))).pipe(HttpClientRequest.acceptJson))
    /** POST a JSON payload, returning the raw response so callers apply semantics. */
    const postResponse = (path: string, payload: unknown) =>
      exec(
        HttpClientRequest.post(withSession(url(path)), { body: HttpBody.jsonUnsafe(payload) }).pipe(
          HttpClientRequest.acceptJson,
        ),
      )

    /** Reads a response body as unknown: JSON when parseable, otherwise text,
     * and empty string/nulls when there is no body. Fails as a defect when the
     * body cannot be read at all. */
    const responseBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<unknown> =>
      Effect.gen(function* () {
        const text = yield* response.text.pipe(Effect.orDie)
        if (text.trim() === "") return null
        try {
          return JSON.parse(text) as unknown
        } catch {
          return text
        }
      })

    const teamRequestErrorMessage = (body: unknown): string | undefined => decodeWire(WireTeamRequestError, body)?.data.message

    /** GET-and-decode a domain value. On 4xx the caller applies its own
     * semantics; decode mismatch and non-4xx failures become defects. */
    const getWire = <A>(path: string, decode: (input: unknown) => A | undefined) =>
      Effect.gen(function* () {
        const response = yield* getResponse(path)
        if (response.status >= 400 && response.status < 500) return { ok: false as const, status: response.status, body: yield* responseBody(response) }
        if (response.status < 200 || response.status >= 300) {
          const detail = yield* responseBody(response)
          return yield* unavailable("read", `HTTP ${response.status} for ${path}${typeof detail === "string" && detail ? `: ${detail}` : ""}`)
        }
        const body = yield* responseBody(response)
        const decoded = decode(body)
        if (decoded === undefined) return yield* unavailable("read", `response ${response.status} did not match the expected wire shape`)
        return { ok: true as const, status: response.status, body: decoded }
      })

    /** POST JSON and read the response as unknown, with the same 4xx/2xx
     * contract as getWire for mutation endpoints. */
    const postWire = <A>(path: string, payload: unknown, decode: (input: unknown) => A | undefined) =>
      Effect.gen(function* () {
        const response = yield* postResponse(path, payload)
        if (response.status >= 400 && response.status < 500) return { ok: false as const, status: response.status, body: yield* responseBody(response) }
        if (response.status < 200 || response.status >= 300) {
          const detail = yield* responseBody(response)
          return yield* unavailable("mutation", `HTTP ${response.status} for ${path}${typeof detail === "string" && detail ? `: ${detail}` : ""}`)
        }
        const body = yield* responseBody(response)
        const decoded = decode(body)
        if (decoded === undefined) return yield* unavailable("mutation", `response ${response.status} did not match the expected wire shape`)
        return { ok: true as const, status: response.status, body: decoded }
      })

    // --- lead-only / no-endpoint methods -------------------------------

    const create = Effect.fn("TeamRemote.create")(function* () {
      return yield* unavailable("create", "the lead session creates teams; a teammate process never runs team_create")
    })

    const addMember = Effect.fn("TeamRemote.addMember")(function* () {
      return yield* unavailable("addMember", "the lead session adds members; a teammate process never runs team_spawn")
    })

    const approveMemberPlan = Effect.fn("TeamRemote.approveMemberPlan")(function* () {
      return Option.none() as Option.Option<Team.Member>
    })

    const buildFinalReport = Effect.fn("TeamRemote.buildFinalReport")(function* () {
      return yield* unavailable("buildFinalReport", "final reports are lead-only; a teammate process never runs team_report")
    })

    const recordFinalReport = Effect.fn("TeamRemote.recordFinalReport")(function* () {
      return yield* unavailable("recordFinalReport", "final reports are lead-only; a teammate process never runs team_report")
    })

    const createUsageEvent = Effect.fn("TeamRemote.createUsageEvent")(function* (input: {
      teamID: string
      sessionID?: string
      memberID?: string
      type: Team.UsageEventType
      metadata?: Record<string, unknown>
    }) {
      // There is no control-plane endpoint for usage events. The member broadcast
      // tool must still render the identical shape it would locally, but the row is
      // intentionally NOT persisted remotely (the lead already audits the durable
      // send side). Audit-only synthetic success keeps member tool output identical.
      return {
        id: crypto.randomUUID(),
        team_id: input.teamID,
        session_id: input.sessionID,
        member_id: input.memberID,
        type: input.type,
        metadata: input.metadata ?? {},
        time_created: Date.now(),
      } satisfies Team.UsageEvent
    })

    const getUsageEvents = Effect.fn("TeamRemote.getUsageEvents")(function* () {
      return [] as Team.UsageEvent[]
    })

    const shutdown = Effect.fn("TeamRemote.shutdown")(function* () {
      return yield* unavailable("shutdown", "team shutdown is lead-only; a teammate process never runs team_shutdown")
    })

    // --- team/member reads ---------------------------------------------

    const getActive = Effect.fn("TeamRemote.getActive")(function* () {
      // A member session is never a lead session, so this read is always empty.
      // That matches the local service's behavior for the member process.
      return Option.none() as Option.Option<Team.Info>
    })

    const getByLeadSession = Effect.fn("TeamRemote.getByLeadSession")(function* (sessionID: string) {
      // A member session is never a lead session. The control-plane endpoint
      // additionally 400s when the query session is not an active team lead, so
      // the non-lead branch is equivalent to an empty read.
      if (sessionID !== ownSession) return Option.none() as Option.Option<Team.Info>
      const result = yield* getWire(`/team`, decodeTeamInfo)
      if (result.ok) return Option.some(result.body) as Option.Option<Team.Info>
      return Option.none() as Option.Option<Team.Info>
    })

    const get = Effect.fn("TeamRemote.get")(function* (teamID: string) {
      if (teamID !== config.teamID) return Option.none() as Option.Option<Team.Info>
      const result = yield* getWire(`/team/${encodeURIComponent(teamID)}`, decodeTeamInfo)
      if (result.ok) return Option.some(result.body) as Option.Option<Team.Info>
      return Option.none() as Option.Option<Team.Info>
    })

    const getMembers = Effect.fn("TeamRemote.getMembers")(function* (teamID: string) {
      if (teamID !== config.teamID) return [] as Team.Member[]
      const result = yield* getWire(`/team/${encodeURIComponent(teamID)}/eval`, (input) =>
        decodeWire(WireEvalReport, input),
      )
      if (!result.ok) return [] as Team.Member[]
      const nodes = result.body.nodes
      const resultNodes = new Map<string, string>()
      for (const node of nodes) {
        if (node.type === "result" && typeof node.metadata?.result === "string") {
          resultNodes.set(node.ref, node.metadata.result)
        }
      }
      const members: Team.Member[] = []
      for (const node of nodes) {
        if (node.type !== "member") continue
        const metadata = node.metadata ?? {}
        const id = metadata.member_id
        if (typeof id !== "string" || typeof node.ref !== "string") continue
        const agentType = metadata.agent_type
        if (typeof agentType !== "string") continue
        const dependencyIDs =
          Array.isArray(metadata.dependency_ids) && metadata.dependency_ids.every((v) => typeof v === "string")
            ? (metadata.dependency_ids as string[])
            : []
        // Eval member metadata carries the DB model object with camelCase keys.
        const rawModel = metadata.model as unknown
        const model: Team.Member["model"] =
          rawModel != null &&
          typeof rawModel === "object" &&
          typeof (rawModel as { providerID?: unknown }).providerID === "string" &&
          typeof (rawModel as { modelID?: unknown }).modelID === "string"
            ? {
                providerID: (rawModel as { providerID: string }).providerID,
                modelID: (rawModel as { modelID: string }).modelID,
                ...(typeof (rawModel as { variant?: unknown }).variant === "string"
                  ? { variant: (rawModel as { variant: string }).variant }
                  : {}),
              }
            : null
        members.push({
          id,
          team_id: teamID,
          session_id: node.ref,
          name: node.label ?? node.ref,
          agent_type: agentType,
          model,
          role_prompt: "",
          status: node.status as Team.MemberStatus,
          lifecycle: typeof metadata.lifecycle === "string"
            ? (metadata.lifecycle as Team.MemberLifecycle)
            : "task",
          daemon_state: typeof metadata.daemon_state === "string"
            ? (metadata.daemon_state as Team.MemberDaemonState)
            : null,
          daemon_last_active: typeof metadata.daemon_last_active === "number"
            ? (metadata.daemon_last_active as number)
            : null,
          daemon_error: typeof metadata.daemon_error === "string" ? (metadata.daemon_error as string) : null,
          failure_code: typeof metadata.failure_code === "string"
            ? (metadata.failure_code as Team.MemberFailureCode)
            : null,
          run_generation: 0,
          plan_mode: metadata.plan_mode === true,
          work_mode: metadata.work_mode === "plan" ? "plan" : "implement",
          dependency_ids: dependencyIDs,
          result: resultNodes.get(node.ref),
          time_created: node.time_created,
          time_updated: node.time_updated ?? node.time_created,
        })
      }
      return members
    })

    /** E7 pre-run context for the member's own session. Reused by several reads. */
    const ownContext = Effect.fn("TeamRemote.ownContext")(function* () {
      const result = yield* getWire(
        `/team/${encodeURIComponent(config.teamID)}/members/${encodeURIComponent(ownSession)}/context`,
        (input) => {
          const wire = decodeWire(WireMemberContext, input)
          if (!wire) return undefined
          const team = decodeTeamInfo(wire.team)
          if (!team) return undefined
          return { team, member: toMemberFromWire(wire.member) }
        },
      )
      if (!result.ok) return Option.none()
      return Option.some(result.body)
    })

    const getMemberBySession = Effect.fn("TeamRemote.getMemberBySession")(function* (sessionID: string) {
      if (sessionID !== ownSession) return Option.none() as Option.Option<Team.Member>
      const context = yield* ownContext()
      return Option.isSome(context)
        ? Option.some(context.value.member) as Option.Option<Team.Member>
        : Option.none() as Option.Option<Team.Member>
    })

    const getContext = Effect.fn("TeamRemote.getContext")(function* (sessionID: string) {
      if (sessionID !== ownSession) return Option.none() as Option.Option<{ team: Team.Info; member?: Team.Member }>
      const context = yield* ownContext()
      if (Option.isNone(context)) return Option.none() as Option.Option<{ team: Team.Info; member?: Team.Member }>
      return Option.some(context.value) as Option.Option<{ team: Team.Info; member?: Team.Member }>
    })

    // --- tasks ----------------------------------------------------------

    /** Exact-id match first, then a unique prefix; mirrors Team.resolveTaskID
     * semantics including the ambiguous-prefix Error wording so task tools
     * render the identical message the local service yields. */
    const resolveTaskID = Effect.fn("TeamRemote.resolveTaskID")(function* (teamID: string, taskID: string) {
      const tasks = yield* getTasks(teamID)
      const exact = tasks.find((task) => task.id === taskID)
      if (exact) return Option.some(exact)
      const matches = tasks.filter((task) => task.id.startsWith(taskID))
      if (matches.length === 0) return Option.none() as Option.Option<Team.Task>
      if (matches.length === 1 && matches[0]) return Option.some(matches[0])
      return yield* Effect.fail(
        new Error(
          `Ambiguous task ID prefix "${taskID}". Matching tasks: ${matches.map((task) => task.id.slice(0, 8)).join(", ")}`,
        ),
      )
    })

    const getTask = Effect.fn("TeamRemote.getTask")(function* (teamID: string, taskID: string) {
      return yield* resolveTaskID(teamID, taskID)
    })

    const getTasks = Effect.fn("TeamRemote.getTasks")(function* (teamID: string) {
      if (teamID !== config.teamID) return [] as Team.Task[]
      const result = yield* getWire(`/team/${encodeURIComponent(teamID)}/tasks`, (input) => {
        if (!Array.isArray(input)) return undefined
        const tasks: Team.Task[] = []
        for (const row of input) {
          const wire = decodeWire(WireTask, row)
          if (wire) tasks.push(toTaskFromWire(wire))
        }
        return tasks
      })
      return result.ok ? result.body : [] as Team.Task[]
    })

    const updateTask = Effect.fn("TeamRemote.updateTask")(function* (
      teamID: string,
      taskID: string,
      update: Partial<{
        status: Team.TaskStatus
        assignee: string
        handoff: Team.TaskHandoff
        handoffPathKeys?: string[]
      }>,
      _caller?: { sessionID: string; isLead: boolean },
    ) {
      const payload: {
        status?: Team.TaskStatus
        assignee?: string
        handoff?: {
          summary: string
          changed_paths: string[]
          verification: Array<{ command: string; status: "passed" | "failed" | "not_run"; detail?: string }>
          risks?: string[]
        }
        handoff_path_keys?: string[]
      } = {}
      if (update.status !== undefined) payload.status = update.status
      if (update.assignee !== undefined) payload.assignee = update.assignee
      if (update.handoff !== undefined) {
        payload.handoff = {
          summary: update.handoff.summary,
          changed_paths: [...update.handoff.changed_paths],
          verification: update.handoff.verification.map((entry) => ({
            command: entry.command,
            status: entry.status,
            ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          })),
          ...(update.handoff.risks !== undefined ? { risks: [...update.handoff.risks] } : {}),
        }
      }
      if (update.handoffPathKeys !== undefined) payload.handoff_path_keys = [...update.handoffPathKeys]
      const result = yield* postWire(
        `/team/${encodeURIComponent(teamID)}/tasks/${encodeURIComponent(taskID)}/update`,
        payload,
        (input) => {
          const wire = decodeWire(WireTask, input)
          return wire ? toTaskFromWire(wire) : undefined
        },
      )
      if (result.ok) return Option.some(result.body) as Option.Option<Team.Task>
      const message = teamRequestErrorMessage(result.body)
      // Task not found maps to the local service's empty Option; all other
      // validation failures keep the server's translated message as an Error so
      // tool catchIf(Error) renders the identical text the local service yields.
      if (result.status === 400 && (message === undefined || message === "Task not found.")) {
        return Option.none() as Option.Option<Team.Task>
      }
      return yield* Effect.fail(new Error(message ?? `Task update failed (HTTP ${result.status}).`))
    })

    const claimTask = Effect.fn("TeamRemote.claimTask")(function* (teamID: string, taskID: string) {
      const result = yield* postWire(
        `/team/${encodeURIComponent(teamID)}/tasks/${encodeURIComponent(taskID)}/claim`,
        {},
        (input) => {
          const wire = decodeWire(WireTask, input)
          return wire ? toTaskFromWire(wire) : undefined
        },
      )
      if (result.ok) return Option.some(result.body) as Option.Option<Team.Task>
      // The claim endpoint only returns 400 "Cannot claim this task." or an
      // ambiguous-prefix error; both map to the tool's empty-Option output text,
      // matching local claimTask returning Option.none for unclaimable tasks.
      return Option.none() as Option.Option<Team.Task>
    })

    const createTask = Effect.fn("TeamRemote.createTask")(function* () {
      return yield* unavailable("createTask", "the lead session creates shared tasks; a teammate process never runs team_task_create")
    })

    // --- messages -------------------------------------------------------

    const sendMessage = Effect.fn("TeamRemote.sendMessage")(function* (input: {
      teamID: string
      sender: string
      recipients: string[]
      body: string
    }) {
      if (input.teamID !== config.teamID) {
        return yield* Effect.fail(new Team.MessageToClosedTeam({ teamID: input.teamID }))
      }
      const payload: typeof WireTeamSendMessagePayload.Type = {
        recipients: [...input.recipients],
        body: input.body,
      }
      const result = yield* postWire(
        `/team/${encodeURIComponent(input.teamID)}/messages`,
        payload,
        (body) => {
          const wire = decodeWire(WireMessage, body)
          return wire ? toMessageFromWire(wire) : undefined
        },
      )
      if (result.ok) return result.body
      const message = teamRequestErrorMessage(result.body)
      if (message !== undefined && (message.endsWith("is not active") || message.includes("is not active"))) {
        return yield* Effect.fail(new Team.MessageToClosedTeam({ teamID: input.teamID }))
      }
      if (message !== undefined && message.includes("cannot receive messages")) {
        // The server flattens the terminal-recipient details into a message; the
        // typed error still needs the recipient structs. Reconstruct from the
        // member read so the error message matches the local service (tools
        // normally pre-check and never reach this race branch).
        const members = yield* getMembers(input.teamID)
        const terminal = input.recipients
          .map((sessionID) => members.find((member) => member.session_id === sessionID))
          .filter(
            (member): member is Team.Member & {
              status: "completed" | "cancelled" | "failed"
            } =>
              member !== undefined &&
              member.lifecycle === "task" &&
              (member.status === "completed" || member.status === "cancelled" || member.status === "failed"),
          )
          .map((member) => ({ sessionID: member.session_id, name: member.name, status: member.status }))
        return yield* Effect.fail(
          new Team.MessageToTerminalMember({ teamID: input.teamID, recipients: terminal }),
        )
      }
      return yield* unavailable("sendMessage", `HTTP ${result.status} for message send${message ? `: ${message}` : ""}`)
    })

    /** Validates own member is non-terminal in an active team (E7 context read). */
    const ownMemberAdmission = Effect.fn("TeamRemote.ownMemberAdmission")(function* () {
      const context = yield* ownContext()
      if (Option.isNone(context)) return false
      const team = context.value.team
      if (team.status !== "active") return false
      const member = context.value.member
      return !(member.status === "completed" || member.status === "cancelled" || member.status === "failed")
    })

    const admitWake = Effect.fn("TeamRemote.admitWake")(function* <E, R>(
      sessionID: string,
      wake: Effect.Effect<void, E, R>,
    ) {
      if (sessionID !== ownSession) return false
      if (!(yield* ownMemberAdmission())) return false
      yield* wake
      return true
    })

    const canWakeSession = Effect.fn("TeamRemote.canWakeSession")(function* (sessionID: string) {
      if (sessionID !== ownSession) return false
      return yield* ownMemberAdmission()
    })

    const getMessages = Effect.fn("TeamRemote.getMessages")(function* (teamID: string) {
      if (teamID !== config.teamID) return [] as Team.Message[]
      const result = yield* getWire(`/team/${encodeURIComponent(teamID)}/messages`, (input) => {
        if (!Array.isArray(input)) return undefined
        const messages: Team.Message[] = []
        for (const row of input) {
          const wire = decodeWire(WireMessage, row)
          if (wire) messages.push(toMessageFromWire(wire))
        }
        return messages
      })
      return result.ok ? result.body : [] as Team.Message[]
    })

    const getPendingMessages = Effect.fn("TeamRemote.getPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      if (teamID !== config.teamID) return [] as Team.Message[]
      const messages = yield* getMessages(teamID)
      return messages.filter(
        (message) => message.recipients.includes(recipientSession) && message.delivery_status === "pending",
      )
    })

    const hasPendingMailboxMessages = Effect.fn("TeamRemote.hasPendingMailboxMessages")(function* (
      recipientSession: string,
    ) {
      const messages = yield* getMessages(config.teamID)
      return messages.some(
        (message) => message.recipients.includes(recipientSession) && message.delivery_status === "pending",
      )
    })

    const claimPendingMessages = Effect.fn("TeamRemote.claimPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      if (teamID !== config.teamID) return [] as Team.Message[]
      const result = yield* postWire(`/team/${encodeURIComponent(teamID)}/messages/claim`, {}, (body) => {
        if (!Array.isArray(body)) return undefined
        const messages: Team.Message[] = []
        for (const row of body) {
          const wire = decodeWire(WireMessage, row)
          if (wire) messages.push(toMessageFromWire(wire))
        }
        return messages
      })
      if (result.ok) return result.body
      const message = teamRequestErrorMessage(result.body)
      if (message !== undefined && message.includes("paused")) {
        return yield* new Runner.Suspended()
      }
      // A paused session's claim is the only Runner.Suspended source. Other
      // 400s mean the caller is not a participant (or the team changed) and
      // read as an empty claim (member tools gate on getContext first).
      return [] as Team.Message[]
    })

    const releaseClaimedMessages = Effect.fn("TeamRemote.releaseClaimedMessages")(function* (
      messageIDs: readonly string[],
      recipientSession: string,
    ) {
      yield* Effect.forEach(
        messageIDs,
        (messageID) =>
          postWire(
            `/team/${encodeURIComponent(config.teamID)}/messages/${encodeURIComponent(messageID)}/release`,
            {},
            () => true,
          ).pipe(
            Effect.as(undefined),
            // Best-effort: a release that races a terminal settlement or an
            // already-acked message is a no-op locally, so ignore any failure.
            Effect.ignore,
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

    const markMessageDelivered = Effect.fn("TeamRemote.markMessageDelivered")(function* (
      messageID: string,
      recipientSession?: string,
    ) {
      const result = yield* postWire(
        `/team/${encodeURIComponent(config.teamID)}/messages/${encodeURIComponent(messageID)}/ack`,
        {},
        () => true,
      )
      if (result.ok) return
      // Local ack never fails for a participant even when no recipient row
      // matches; only non-participant calls are rejected and tools never make
      // those. Treat the rejected case as a no-op rather than a defect.
      if (result.status === 400) return
      return yield* unavailable("markMessageDelivered", `HTTP ${result.status} for message ack`)
    })

    // --- terminal result ------------------------------------------------

    const updateMemberStatus = Effect.fn("TeamRemote.updateMemberStatus")(function* (
      memberID: string,
      status: Team.MemberStatus,
      resultOrUpdate?: string | {
        result?: string
        failureCode?: Team.MemberFailureCode | null
        daemonState?: Team.MemberDaemonState | null
        daemonLastActive?: number | null
        daemonError?: string | null
      },
    ) {
      // A member process only reports its own terminal result to the lead. All
      // other status transitions are owned by the lead side and never invoked
      // remotely by member tool code. The member-result endpoint addresses the
      // member by SESSION id, so resolve our own session first.
      if (status !== "completed" && status !== "cancelled" && status !== "failed") {
        return Option.none() as Option.Option<Team.Member>
      }
      const ownMember = yield* getMemberBySession(ownSession)
      if (Option.isNone(ownMember) || ownMember.value.id !== memberID) {
        return Option.none() as Option.Option<Team.Member>
      }
      const update = typeof resultOrUpdate === "string" ? { result: resultOrUpdate } : resultOrUpdate
      const payload: {
        status: "completed" | "cancelled" | "failed"
        result?: string
        failure_code?: Team.MemberFailureCode | null
      } = { status }
      if (update?.result !== undefined) payload.result = update.result
      if (update?.failureCode !== undefined) payload.failure_code = update.failureCode
      const result = yield* postWire(
        `/team/${encodeURIComponent(config.teamID)}/members/${encodeURIComponent(ownSession)}/result`,
        payload,
        (body) => decodeWire(WireTeamMemberResult, body),
      )
      if (result.ok) {
        const wire = result.body
        if (wire.session_id !== ownSession) return Option.none() as Option.Option<Team.Member>
        // The lead returns only {member_id, session_id, status}. Re-fetch the
        // full member so the caller observes the same domain shape as local.
        const member = yield* getMemberBySession(ownSession)
        if (Option.isSome(member)) return member
        // Synthesize a minimal member when the context read races the close.
        return Option.some({
          id: wire.member_id,
          team_id: config.teamID,
          session_id: wire.session_id,
          name: wire.session_id,
          agent_type: "general",
          model: null,
          role_prompt: "",
          status: wire.status as Team.MemberStatus,
          lifecycle: "task",
          daemon_state: null,
          daemon_last_active: null,
          daemon_error: null,
          failure_code: null,
          run_generation: 0,
          plan_mode: false,
          work_mode: "implement",
          dependency_ids: [],
          result: update?.result,
          time_created: Date.now(),
          time_updated: Date.now(),
        } satisfies Team.Member)
      }
      // Local updateMemberStatus is idempotent for already-terminal members and
      // only returns empty when the member row is missing. A team that closed
      // between admission and this report is the reachable empty case here.
      return Option.none() as Option.Option<Team.Member>
    })

    return Team.Service.of({
      create,
      getActive,
      getByLeadSession,
      get,
      shutdown,
      addMember,
      updateMemberStatus,
      approveMemberPlan,
      getMembers,
      getMemberBySession,
      getContext,
      createTask,
      getTask,
      updateTask,
      claimTask,
      getTasks,
      sendMessage,
      admitWake,
      canWakeSession,
      getMessages,
      getPendingMessages,
      hasPendingMailboxMessages,
      claimPendingMessages,
      releaseClaimedMessages,
      markMessageDelivered,
      createUsageEvent,
      getUsageEvents,
      buildFinalReport,
      recordFinalReport,
    })
  }),
  ),
)

export const defaultLayer = remoteLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Config.defaultLayer),
)

export * as TeamRemote from "./remote"
