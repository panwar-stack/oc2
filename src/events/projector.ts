import type { RuntimeEvent, RuntimeEventProjector, RuntimeEventType } from "./events"

export interface RuntimeProjection {
  readonly counts: Readonly<Record<RuntimeEventType, number>>
  readonly latestByType: Readonly<Partial<Record<RuntimeEventType, RuntimeEvent>>>
}

export const createEmptyRuntimeProjection = (): RuntimeProjection => ({
  counts: {} as Record<RuntimeEventType, number>,
  latestByType: {},
})

export const runtimeProjectionProjector: RuntimeEventProjector<RuntimeProjection> = (state, event) => ({
  counts: {
    ...state.counts,
    [event.type]: (state.counts[event.type] ?? 0) + 1,
  },
  latestByType: {
    ...state.latestByType,
    [event.type]: event,
  },
})
