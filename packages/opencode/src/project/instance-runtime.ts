import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { Effect } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceStore, type LoadInput } from "./instance-store"

// Bridge for Promise/ALS callers that cannot yet yield InstanceStore.Service.
// Delete this module once those callers are migrated to Effect boundaries that
// provide InstanceStore directly.

export const load = (input: LoadInput) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load(input)))
export const disposeInstance = (ctx: InstanceContext) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))
export const disposeAllInstances = () => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
export const disposeDirectory = (directory: string) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
export const provide = <A, E>(input: LoadInput, effect: Effect.Effect<A, E, AppServices | InstanceStore.Service>) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide(input, effect)))
export const run = <A, E>(input: LoadInput, effect: Effect.Effect<A, E, AppServices | InstanceStore.Service>) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.run(input, effect)))
export const reloadInstance = (input: LoadInput) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input)))

export * as InstanceRuntime from "./instance-runtime"
