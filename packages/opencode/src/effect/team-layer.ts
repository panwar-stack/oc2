import { Layer } from "effect"
import { Team } from "@/team/team"
import { TeamRemote } from "@/team/remote"
import { OC2_PROCESS_ROLE, OC2_TEAM_LEAD_URL } from "@oc2-ai/core/util/opencode-process"

/**
 * Selects the Team.Service layer for the current process. A teammate process
 * (OC2_PROCESS_ROLE=teammate) that has a control-plane lead URL always talks to
 * the lead over HTTP through `TeamRemote.defaultLayer`. Every other process
 * (main, worker, or a teammate without a lead URL) keeps the existing local
 * `Team.defaultLayer` path unchanged.
 *
 * This lives outside `run-service.ts` on purpose: importing `@/team/team` from
 * run-service closed a module cycle (run-service -> team -> run-state -> session
 * -> project -> command -> bridge -> run-service) that threw a temporal-dead-zone
 * ReferenceError. Only the app-runtime assembly imports this module.
 */
export function teamLayerByRole(): Layer.Layer<Team.Service> {
  const role = process.env[OC2_PROCESS_ROLE]
  const leadURL = process.env[OC2_TEAM_LEAD_URL]
  if (role !== "teammate" || !leadURL) return Team.defaultLayer
  return TeamRemote.defaultLayer
}

export * as TeamLayer from "./team-layer"
