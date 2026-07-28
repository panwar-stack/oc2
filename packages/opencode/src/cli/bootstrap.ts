import { InstanceRuntime } from "../project/instance-runtime"
import { context } from "../project/instance-context"
import { InstanceRef } from "../effect/instance-ref"
import { Effect } from "effect"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return InstanceRuntime.run(
    { directory },
    Effect.gen(function* () {
      const ctx = yield* InstanceRef
      if (!ctx) return yield* Effect.die("InstanceRef not provided")
      return yield* Effect.promise(() => context.provide(ctx, cb))
    }),
  )
}
