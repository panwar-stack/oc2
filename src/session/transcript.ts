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
