import { ServerAddress } from "@/server/address"
import { OC2_TEAM_LEAD_URL } from "@oc2-ai/core/util/opencode-process"

/**
 * How long a spawned member process may go without refreshing its liveness
 * clock (`team_member.daemon_last_active`) before the lead treats it as lost.
 * The clock starts at spawn (`spawnRemoteMember`) and every heartbeat refreshes
 * it. Detection reuses the existing 500ms reconcile tick; this constant is only
 * the staleness threshold, not a poll interval.
 */
export const LOST_MEMBER_TIMEOUT_MS = 120_000

/**
 * Environment override for {@link LOST_MEMBER_TIMEOUT_MS}. It exists so tests
 * can exercise durable lost-member detection quickly and deterministically
 * without waiting two real minutes. The value must be a positive finite integer
 * (milliseconds); any other value falls back to the default constant. It is read
 * by the caller at reconcile time, not at module load, so a test can set it.
 */
export const OC2_TEAM_LOST_MEMBER_TIMEOUT_MS = "OC2_TEAM_LOST_MEMBER_TIMEOUT_MS"

/** Resolves the lost-member staleness threshold in milliseconds. An explicit
 * positive integer `OC2_TEAM_LOST_MEMBER_TIMEOUT_MS` wins; otherwise the
 * exported {@link LOST_MEMBER_TIMEOUT_MS} default applies. */
export function resolveLostMemberTimeoutMs(): number {
  const raw = process.env[OC2_TEAM_LOST_MEMBER_TIMEOUT_MS]?.trim()
  if (!raw) return LOST_MEMBER_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return LOST_MEMBER_TIMEOUT_MS
  return parsed
}

/**
 * Resolves the control-plane base URL a lead advertises to spawned member
 * processes. An explicit `OC2_TEAM_LEAD_URL` wins (trimmed, nonempty) so a
 * cross-VM deployment can pin a reachable host. Otherwise the URL this process
 * last listened on is used, which is the common same-host case.
 */
export function resolveLeadControlPlaneURL(): string | undefined {
  const configured = process.env[OC2_TEAM_LEAD_URL]?.trim()
  if (configured) return configured
  return ServerAddress.url?.origin
}

/**
 * True only when the opt-in multi-process transport is explicitly enabled.
 * The flag is absent by default, so the single-process path is unchanged.
 */
export function isMultiprocessEnabled(config: { experimental?: { team_multiprocess?: boolean } } | undefined): boolean {
  return config?.experimental?.team_multiprocess === true
}

export * as TeamControlPlane from "./control-plane"
