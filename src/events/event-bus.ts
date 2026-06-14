import { createRuntimeEvent, type RuntimeEvent, type RuntimeEventInput, type RuntimeEventListener, type RuntimeEventMap, type RuntimeEventProjector, type RuntimeEventType } from "./events"

export interface RuntimeEventBusOptions<TState = unknown> {
  readonly initialState?: TState
  readonly projector?: RuntimeEventProjector<TState>
  readonly onListenerError?: (error: unknown, event: RuntimeEvent) => void
  readonly onProjectorError?: (error: unknown, event: RuntimeEvent) => void
}

export interface RuntimeEventBus<TState = unknown> {
  publish<TType extends RuntimeEventType>(event: RuntimeEventInput<TType> | RuntimeEvent<TType>): RuntimeEvent<TType>
  subscribe<TType extends RuntimeEventType>(
    type: TType,
    listener: RuntimeEventListener<RuntimeEvent<TType>>,
  ): () => void
  all(listener: RuntimeEventListener): () => void
  getState(): TState
}

export const createRuntimeEventBus = <TState = undefined>(
  options: RuntimeEventBusOptions<TState> = {},
): RuntimeEventBus<TState> => {
  const typedListeners = new Map<RuntimeEventType, Set<RuntimeEventListener>>()
  const allListeners = new Set<RuntimeEventListener>()
  let state = options.initialState as TState

  const notify = (listener: RuntimeEventListener, event: RuntimeEvent) => {
    try {
      listener(event)
    } catch (error) {
      options.onListenerError?.(error, event)
    }
  }

  return {
    publish<TType extends RuntimeEventType>(input: RuntimeEventInput<TType> | RuntimeEvent<TType>): RuntimeEvent<TType> {
      const event = "id" in input ? input : createRuntimeEvent(input)

      if (options.projector) {
        try {
          state = options.projector(state, event)
        } catch (error) {
          options.onProjectorError?.(error, event)
        }
      }

      for (const listener of typedListeners.get(event.type) ?? []) {
        notify(listener, event)
      }
      for (const listener of allListeners) {
        notify(listener, event)
      }

      return event
    },

    subscribe<TType extends RuntimeEventType>(
      type: TType,
      listener: RuntimeEventListener<RuntimeEvent<TType>>,
    ): () => void {
      const listeners = typedListeners.get(type) ?? new Set<RuntimeEventListener>()
      listeners.add(listener as RuntimeEventListener)
      typedListeners.set(type, listeners)
      return () => listeners.delete(listener as RuntimeEventListener)
    },

    all(listener: RuntimeEventListener): () => void {
      allListeners.add(listener)
      return () => allListeners.delete(listener)
    },

    getState(): TState {
      return state
    },
  }
}

export type EventPayload<TType extends RuntimeEventType> = RuntimeEventMap[TType]
