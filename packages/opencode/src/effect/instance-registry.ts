import type { InstanceContext } from "@/project/instance-context"

interface RegisteredDisposer {
  readonly dispose: (ctx: InstanceContext) => Promise<void>
  readonly activeOnly: boolean
}

const disposers = new Set<RegisteredDisposer>()

export function registerDisposer(disposer: (ctx: InstanceContext) => Promise<void>, options?: { activeOnly?: boolean }) {
  const registered = { dispose: disposer, activeOnly: options?.activeOnly === true }
  disposers.add(registered)
  return () => {
    disposers.delete(registered)
  }
}

export async function disposeInstance(ctx: InstanceContext, options: { activated: boolean }) {
  await Promise.allSettled(
    [...disposers]
      .filter((registered) => options.activated || !registered.activeOnly)
      .map((registered) => registered.dispose(ctx)),
  )
}
