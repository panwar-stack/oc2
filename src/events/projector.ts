import type { RuntimeEvent, RuntimeEventProjector, RuntimeEventType } from "./events"

/** Lightweight aggregate view maintained from runtime events. */
export interface RuntimeProjection {
  readonly counts: Readonly<Record<RuntimeEventType, number>>
  readonly latestByType: Readonly<Partial<Record<RuntimeEventType, RuntimeEvent>>>
}

/** Creates the initial projection state for a runtime event bus. */
export const createEmptyRuntimeProjection = (): RuntimeProjection => ({
  counts: {} as Record<RuntimeEventType, number>,
  latestByType: {},
})

/** Counts events by type and records the latest event of each type. */
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
