import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { Effect, Stream } from "effect"
import type { Framing } from "../route/framing"
import { ProviderShared } from "./shared"

// Bedrock streams responses using the AWS event stream binary protocol — each
// frame is `[length:4][headers-length:4][prelude-crc:4][headers][payload][crc:4]`.
// We use `@smithy/eventstream-codec` to validate framing and CRCs, then
// reconstruct the JSON wrapping by `:event-type` or `:exception-type` so the
// chunk schema can match Smithy events and modeled exceptions.
const eventCodec = new EventStreamCodec(toUtf8, fromUtf8)
const utf8 = new TextDecoder()

// Cursor-tracking buffer state. Bytes accumulate in `buffer`; `offset` is the
// read position. Reading by `subarray` is zero-copy. We only allocate a fresh
// buffer when a new network chunk arrives and we need to append.
interface FrameBufferState {
  readonly buffer: Uint8Array
  readonly offset: number
}

const initialFrameBuffer: FrameBufferState = { buffer: new Uint8Array(0), offset: 0 }

type FrameInput = { readonly type: "chunk"; readonly value: Uint8Array } | { readonly type: "eof" }

const appendChunk = (state: FrameBufferState, chunk: Uint8Array): FrameBufferState => {
  const remaining = state.buffer.length - state.offset
  // Compact: drop the consumed prefix and append the new chunk in one alloc.
  // This bounds buffer growth to at most one network chunk past the live
  // window, regardless of stream length.
  const next = new Uint8Array(remaining + chunk.length)
  next.set(state.buffer.subarray(state.offset), 0)
  next.set(chunk, remaining)
  return { buffer: next, offset: 0 }
}

const consumeFrames = (route: string) => (state: FrameBufferState, input: FrameInput) =>
  Effect.gen(function* () {
    if (input.type === "eof") {
      return state.buffer.length === state.offset
        ? ([state, []] as const)
        : ([
            initialFrameBuffer,
            [
              {
                bedrockEventStreamError: {
                  message: "Bedrock Converse event stream ended with an incomplete binary frame",
                },
              },
            ],
          ] as const)
    }

    let cursor = appendChunk(state, input.value)
    const out: object[] = []
    while (cursor.buffer.length - cursor.offset >= 4) {
      const view = cursor.buffer.subarray(cursor.offset)
      const totalLength = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, false)
      if (view.length < totalLength) break

      const decoded = yield* Effect.try({
        try: () => eventCodec.decode(view.subarray(0, totalLength)),
        catch: (error) =>
          ProviderShared.eventError(
            route,
            `Failed to decode Bedrock Converse event-stream frame: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      })
      cursor = { buffer: cursor.buffer, offset: cursor.offset + totalLength }

      const messageType = decoded.headers[":message-type"]?.value
      const eventType =
        messageType === "event"
          ? decoded.headers[":event-type"]?.value
          : messageType === "exception"
            ? decoded.headers[":exception-type"]?.value
            : undefined
      if (messageType === "error") {
        const code = decoded.headers[":error-code"]?.value
        const message = decoded.headers[":error-message"]?.value
        out.push({
          bedrockEventStreamError: {
            code: typeof code === "string" ? code : undefined,
            message: typeof message === "string" && message ? message : "UnknownError",
          },
        })
        continue
      }
      if (typeof eventType !== "string") continue
      const payload = utf8.decode(decoded.body)
      if (!payload && messageType !== "exception") continue
      // The AWS event stream pads short payloads with a `p` field. Drop it
      // before handing the object to the chunk schema. JSON decode goes
      // through the shared Schema-driven codec to satisfy the package rule
      // against ad-hoc `JSON.parse` calls.
      const parsed = payload
        ? yield* ProviderShared.parseJson(route, payload, "Failed to parse Bedrock Converse event-stream payload")
        : {}
      if (ProviderShared.isRecord(parsed)) delete parsed.p
      out.push({ [eventType]: parsed })
    }
    return [cursor, out] as const
  })

/**
 * AWS event-stream framing for Bedrock Converse. Each frame is decoded by
 * `@smithy/eventstream-codec` (length + header + payload + CRC) and rewrapped
 * under its Smithy event or exception type header so the chunk schema can
 * match the JSON payload directly. An incomplete final frame becomes a parser
 * event so pending authoritative usage can accompany the terminal failure.
 */
export const framing = (route: string): Framing<object> => ({
  id: "aws-event-stream",
  frame: (bytes) =>
    bytes.pipe(
      Stream.map((value): FrameInput => ({ type: "chunk", value })),
      Stream.concat(Stream.succeed<FrameInput>({ type: "eof" })),
      Stream.mapAccumEffect(() => initialFrameBuffer, consumeFrames(route)),
    ),
})

export * as BedrockEventStream from "./bedrock-event-stream"
