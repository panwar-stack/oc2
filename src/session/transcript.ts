import type { SessionRecord } from "../persistence/repositories/sessions"
import type { SessionMessage } from "./message"

/** Plain-text projection of one message for human-readable exports. */
export interface TranscriptEntry {
  readonly role: SessionMessage["role"]
  readonly text: string
}

export interface SessionTranscript {
  readonly session: SessionRecord
  readonly messages: readonly SessionMessage[]
}

export interface SessionTranscriptCollection {
  readonly sessions: readonly SessionTranscript[]
}

/** Converts structured message parts into text markers suitable for transcript output. */
export const buildTranscriptEntries = (messages: readonly SessionMessage[]): readonly TranscriptEntry[] =>
  messages.map((message) => ({
    role: message.role,
    text: message.parts
      .map((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text
        if (part.type === "tool-call") return `[tool-call:${part.toolCall.name}]`
        if (part.type === "tool-result") return `[tool-result:${part.result.toolCallId}]`
        if (part.type === "file") return `[file:${part.path}]`
        return `[event:${part.eventId}]`
      })
      .join("\n"),
  }))

/** Renders a session transcript as Markdown grouped by message role. */
export const exportTranscriptMarkdown = (transcript: SessionTranscript): string => {
  const lines = [`# Session ${transcript.session.id}`, ""]
  for (const entry of buildTranscriptEntries(transcript.messages)) {
    lines.push(`## ${entry.role}`, "", entry.text, "")
  }
  return lines.join("\n").trimEnd() + "\n"
}

/** Renders a session transcript as stable, pretty-printed JSON. */
export const exportTranscriptJson = (transcript: SessionTranscript): string => JSON.stringify(transcript, null, 2)

/** Renders multiple transcripts as Markdown in their collection order. */
export const exportTranscriptCollectionMarkdown = (collection: SessionTranscriptCollection): string =>
  collection.sessions.map((transcript) => exportTranscriptMarkdown(transcript).trimEnd()).join("\n\n") + "\n"

/** Renders multiple transcripts as stable, pretty-printed JSON. */
export const exportTranscriptCollectionJson = (collection: SessionTranscriptCollection): string =>
  JSON.stringify(collection, null, 2)
