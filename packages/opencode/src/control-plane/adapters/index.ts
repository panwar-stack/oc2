import type { ProjectV2 } from "@oc2-ai/core/project"
import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"
import { WorktreeAdapter } from "./worktree"

const BUILTIN: Record<string, WorkspaceAdapter> = {
  worktree: WorktreeAdapter,
}

const state = new Map<ProjectV2.ID, Map<string, WorkspaceAdapter>>()
const staged = new Map<string, Map<string, WorkspaceAdapter>>()
const owners = new Map<ProjectV2.ID, string[]>()

export function getAdapter(projectID: ProjectV2.ID, type: string, owner?: string): WorkspaceAdapter {
  const active = owner && owners.get(projectID)?.includes(owner) ? owner : undefined
  const custom = (active ? staged.get(active)?.get(type) : undefined) ?? state.get(projectID)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN[type]
  if (builtin) return builtin

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export function listAdapters(projectID: ProjectV2.ID, owner?: string): WorkspaceAdapterEntry[] {
  return registeredAdapters(projectID, owner).map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
}

export function registeredAdapters(projectID: ProjectV2.ID, owner?: string): [string, WorkspaceAdapter][] {
  const adapters = new Map(Object.entries(BUILTIN))
  for (const [type, adapter] of state.get(projectID)?.entries() ?? []) adapters.set(type, adapter)
  const active = owner && owners.get(projectID)?.includes(owner) ? owner : undefined
  for (const [type, adapter] of (active ? staged.get(active) : undefined)?.entries() ?? []) adapters.set(type, adapter)
  return [...adapters.entries()]
}

/** Retains active adapters omitted by a candidate under the candidate owner until process restart. */
export function retainRemovedAdapters(projectID: ProjectV2.ID, activeOwner: string, candidateOwner: string): string[] {
  const candidate = staged.get(candidateOwner) ?? new Map<string, WorkspaceAdapter>()
  const removed: string[] = []
  if (!owners.get(projectID)?.includes(activeOwner)) return removed
  for (const [type, adapter] of staged.get(activeOwner)?.entries() ?? []) {
    if (candidate.has(type)) continue
    candidate.set(type, adapter)
    removed.push(type)
  }
  if (removed.length) staged.set(candidateOwner, candidate)
  return removed
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectV2.ID.global`
export function registerAdapter(projectID: ProjectV2.ID, type: string, adapter: WorkspaceAdapter, owner?: string) {
  if (owner) {
    const adapters = staged.get(owner) ?? new Map<string, WorkspaceAdapter>()
    adapters.set(type, adapter)
    staged.set(owner, adapters)
    return
  }
  const adapters = state.get(projectID) ?? new Map<string, WorkspaceAdapter>()
  adapters.set(type, adapter)
  state.set(projectID, adapters)
}

export function activateAdapters(projectID: ProjectV2.ID, owner: string) {
  const active = owners.get(projectID) ?? []
  if (!active.includes(owner)) active.push(owner)
  owners.set(projectID, active)
}

export function releaseAdapters(projectID: ProjectV2.ID, owner: string) {
  staged.delete(owner)
  const active = owners.get(projectID)?.filter((item) => item !== owner) ?? []
  if (active.length) owners.set(projectID, active)
  else owners.delete(projectID)
}
