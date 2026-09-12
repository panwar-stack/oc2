import { ServerAuth } from "@/server/auth"
import { Database } from "@oc2-ai/core/database/database"
import { Hash } from "@oc2-ai/core/util/hash"
import { TeamMemberTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import { Context, Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@oc2-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

/** Durable member identity a credential hash resolves to. */
interface MemberCredentialIdentity {
  readonly team_id: string
  readonly session_id: string
}

/**
 * Optional per-member control-plane credential verifier. It resolves a
 * presented Basic password to exactly one `team_member` row by comparing
 * `Hash.sha256(password)` with `team_member.credential_hash`, then binds the
 * credential to the team and member session named by the request.
 *
 * The service is optional on purpose: when the layer is absent the middleware
 * keeps its exact previous behavior, so default-off parity and the existing
 * authorization tests are preserved.
 *
 * Residual risk: `/sync/*` requests carry their aggregate identity in the
 * request body, which this middleware cannot read without consuming the body
 * stream the handler needs. Those requests are accepted on hash match alone;
 * the `/sync` handler still applies its own aggregate ownership checks.
 */
export interface MemberCredentialVerifierInterface {
  readonly verify: (
    credential: ServerAuth.DecodedCredentials,
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean>
}

export class MemberCredentialVerifier extends Context.Service<
  MemberCredentialVerifier,
  MemberCredentialVerifierInterface
>()("@opencode/MemberCredentialVerifier") {}

/**
 * True when a request bound to `member` cannot act as a different member:
 * - `/team/:teamID/members/:sessionID/...` must match the member row exactly.
 * - `/team/:teamID/...` with a `?sessionID=` query must match the row exactly.
 * - `/team/:teamID/...` without a session query is rejected (safer default).
 * - `/sync/*` carries its aggregate identity in the request body, which this
 *   middleware cannot read without consuming the body stream the handler needs,
 *   so it is accepted on hash match alone; the `/sync` handler still applies its
 *   own aggregate ownership checks. These are the only non-team paths a member
 *   process calls.
 * - Any other path is rejected: a member credential must not authorize unrelated
 *   instance routes (for example `/session/:id/abort`) for another session.
 */
function bindsToMember(url: URL, member: MemberCredentialIdentity): boolean {
  const memberPath = /^\/team\/([^/]+)\/members\/([^/]+)(?:\/|$)/.exec(url.pathname)
  if (memberPath) {
    return memberPath[1] === member.team_id && memberPath[2] === member.session_id
  }
  const teamPath = /^\/team\/([^/]+)(?:\/|$)/.exec(url.pathname)
  if (teamPath) {
    const sessionID = url.searchParams.get("sessionID")
    if (!sessionID) return false
    return teamPath[1] === member.team_id && sessionID === member.session_id
  }
  // `/sync/history` and `/sync/replay` are the only body-carried-identity
  // endpoints a member calls; everything else is out of scope for the credential.
  return url.pathname.startsWith("/sync/")
}

export const memberCredentialVerifierLayer = Layer.effect(
  MemberCredentialVerifier,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const verify = (
      credential: ServerAuth.DecodedCredentials,
      request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const secret = Redacted.value(credential.password)
        // An empty or missing password can never match a spawn-time hash.
        if (secret === "") return false
        const digest = Hash.sha256(secret)
        const members = yield* db
          .select({ team_id: TeamMemberTable.team_id, session_id: TeamMemberTable.session_id })
          .from(TeamMemberTable)
          .where(eq(TeamMemberTable.credential_hash, digest))
          .all()
          .pipe(Effect.orDie)
        // The spec requires the credential to map to exactly one member.
        if (members.length !== 1) return false
        return bindsToMember(new URL(request.url, "http://localhost"), members[0])
      })
    return MemberCredentialVerifier.of({ verify })
  }),
)

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

/**
 * Decides whether a decoded credential authorizes a request. The configured
 * shared password always wins and is checked first, exactly as before. When no
 * shared password is configured, server auth is disabled and every request is
 * allowed (legacy behavior; run with a password to enforce member credentials).
 * When a shared password is configured but does not match, the optional member
 * verifier is the only other accepted path.
 */
function membershipAllows(
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  verifier: Option.Option<MemberCredentialVerifierInterface>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (ServerAuth.authorized(credential, config)) return true
    if (!ServerAuth.required(config)) return true
    if (Option.isNone(verifier)) return false
    return yield* verifier.value.verify(credential, request)
  })
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  verifier: Option.Option<MemberCredentialVerifierInterface>,
) {
  return Effect.gen(function* () {
    if (yield* membershipAllows(credential, config, request, verifier)) return yield* effect
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new HttpApiError.Unauthorized({})
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
  verifier: Option.Option<MemberCredentialVerifierInterface>,
) {
  return Effect.gen(function* () {
    if (yield* membershipAllows(credential, config, request, verifier)) return yield* effect
    return HttpServerResponse.empty({
      status: UNAUTHORIZED,
      headers: { "www-authenticate": WWW_AUTHENTICATE },
    })
  })
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const verifier = yield* Effect.serviceOption(MemberCredentialVerifier)
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config, request, verifier)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const verifier = yield* Effect.serviceOption(MemberCredentialVerifier)
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, request, verifier)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, request, Option.none())),
        )
      }),
    )
  }),
)
