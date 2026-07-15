import type { Session } from "@oc2-ai/sdk/v2/client"
import { directoryKey } from "./utils"

const key = (directory: string, sessionID: string) => `${directoryKey(directory)}\n${sessionID}`

export function preserveSessionAggregates(current: Session, incoming: Session): Session {
  return {
    ...incoming,
    cost: current.cost,
    tokens: current.tokens,
    time: { ...incoming.time, processing: current.time.processing },
  }
}

export function mergeSessionAggregates(current: Session, authoritative: Session): Session {
  return {
    ...current,
    cost: authoritative.cost,
    tokens: authoritative.tokens,
    time: { ...current.time, processing: authoritative.time.processing },
  }
}

export function createSessionAuthority() {
  let generation = 0
  const versions = new Map<string, number>()
  const lists = new Map<string, number>()
  const tombstones = new Set<string>()

  const beginSession = (directory: string, sessionID: string) => {
    const next = ++generation
    versions.set(key(directory, sessionID), next)
    return next
  }

  return {
    beginSession,
    beginList(directory: string) {
      const next = ++generation
      lists.set(directoryKey(directory), next)
      return next
    },
    accepts(directory: string, sessionID: string, request: number) {
      const id = key(directory, sessionID)
      return !tombstones.has(id) && versions.get(id) === request
    },
    deleted(directory: string, sessionID: string) {
      return tombstones.has(key(directory, sessionID))
    },
    remove(directory: string, sessionID: string) {
      const id = key(directory, sessionID)
      versions.set(id, ++generation)
      tombstones.add(id)
    },
    create(directory: string, sessionID: string) {
      const id = key(directory, sessionID)
      tombstones.delete(id)
      versions.set(id, ++generation)
    },
    update(directory: string, sessionID: string) {
      versions.set(key(directory, sessionID), ++generation)
    },
    reset(directory: string) {
      const normalized = directoryKey(directory)
      const prefix = `${normalized}\n`
      lists.delete(normalized)
      for (const id of versions.keys()) {
        if (id.startsWith(prefix)) versions.delete(id)
      }
      for (const id of tombstones) {
        if (id.startsWith(prefix)) tombstones.delete(id)
      }
    },
    reconcileList(_directory: string, request: number, current: readonly Session[], incoming: readonly Session[]) {
      const directory = directoryKey(_directory)
      const latest = lists.get(directory)
      if (latest === undefined || latest > request) {
        return current
          .filter((session) => !tombstones.has(key(directory, session.id)))
          .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }
      const currentByID = new Map(current.map((session) => [session.id, session]))
      const incomingIDs = new Set(incoming.map((session) => session.id))
      const next = incoming.flatMap((session) => {
        const id = key(directory, session.id)
        if (tombstones.has(id)) return []
        if ((versions.get(id) ?? 0) > request) {
          const retained = currentByID.get(session.id)
          return retained ? [retained] : []
        }
        versions.set(id, request)
        return [session]
      })
      for (const session of current) {
        const id = key(directory, session.id)
        if (incomingIDs.has(session.id) || tombstones.has(id)) continue
        if ((versions.get(id) ?? 0) > request) {
          next.push(session)
          continue
        }
        versions.set(id, request)
      }
      return next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
  }
}
