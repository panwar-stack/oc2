import path from "path"
import { createHash } from "crypto"
import { FSUtil } from "@oc2-ai/core/fs-util"

export interface ConfigSnapshot {
  readonly revision: number
  readonly globalEpoch: number
  readonly fingerprint: string
  readonly dependencies: readonly string[]
  readonly config: unknown
  readonly directories: readonly string[]
}

export interface ConfigConsumer {
  readonly directory: string
  readonly workspaceID?: string
  readonly generation: number
}

function stable(value: unknown, root = true): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item, false))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && (!root || (key !== "$schema" && key !== "plugin_origins")))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item, false)]),
  )
}

export function immutable<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  const output: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value) as object)
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key)
    if (descriptor && "value" in descriptor) descriptor.value = immutable(descriptor.value)
    if (descriptor) Object.defineProperty(output, key, descriptor)
  }
  return Object.freeze(output) as T
}

/** Hashes only effective merged configuration, independent of source formatting and discovery order. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")
}

export function canonicalConfigPath(input: string): string {
  return FSUtil.resolve(path.normalize(input))
}

/**
 * The index is replaced only at generation activation. Failed candidates never become change consumers.
 * Candidate paths are included whether or not they existed while the generation was evaluated.
 */
export class DependencyIndex {
  private readonly paths = new Map<string, Map<string, ConfigConsumer>>()
  private readonly generation = new Map<string, readonly string[]>()

  commit(consumer: ConfigConsumer, dependencies: Iterable<string>) {
    const key = `${consumer.directory}\0${consumer.workspaceID ?? ""}\0${consumer.generation}`
    const next = [...new Set([...dependencies].map(canonicalConfigPath))]
    this.removeKey(key)
    this.generation.set(key, next)
    for (const dependency of next) {
      const consumers = this.paths.get(dependency) ?? new Map<string, ConfigConsumer>()
      consumers.set(key, consumer)
      this.paths.set(dependency, consumers)
    }
  }

  replace(previous: ConfigConsumer | undefined, consumer: ConfigConsumer, dependencies: Iterable<string>) {
    const next = [...new Set([...dependencies].map(canonicalConfigPath))]
    if (previous) this.removeKey(this.key(previous))
    const key = this.key(consumer)
    this.removeKey(key)
    this.generation.set(key, next)
    for (const dependency of next) {
      const consumers = this.paths.get(dependency) ?? new Map<string, ConfigConsumer>()
      consumers.set(key, consumer)
      this.paths.set(dependency, consumers)
    }
  }

  remove(consumer: ConfigConsumer) {
    this.removeKey(this.key(consumer))
  }

  consumers(input: string): readonly ConfigConsumer[] {
    return [...(this.paths.get(canonicalConfigPath(input))?.values() ?? [])]
  }

  dependencies(consumer: ConfigConsumer): readonly string[] {
    return this.generation.get(this.key(consumer)) ?? []
  }

  clear() {
    this.paths.clear()
    this.generation.clear()
  }

  private removeKey(key: string) {
    const previous = this.generation.get(key)
    if (!previous) return
    this.generation.delete(key)
    for (const dependency of previous) {
      const consumers = this.paths.get(dependency)
      consumers?.delete(key)
      if (consumers?.size === 0) this.paths.delete(dependency)
    }
  }

  private key(consumer: ConfigConsumer) {
    return `${consumer.directory}\0${consumer.workspaceID ?? ""}\0${consumer.generation}`
  }
}

export const dependencyIndex = new DependencyIndex()
