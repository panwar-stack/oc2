import type { SessionRecord } from "../persistence/repositories/sessions"
import type { SessionMessage } from "./message"

export interface TranscriptEntry {
  readonly role: SessionMessage["role"]
  readonly text: string
}

export interface SessionTranscript {
  readonly session: SessionRecord
  readonly messages: readonly SessionMessage[]
}

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

export const exportTranscriptMarkdown = (transcript: SessionTranscript): string => {
  const lines = [`# Session ${transcript.session.id}`, ""]
  for (const entry of buildTranscriptEntries(transcript.messages)) {
    lines.push(`## ${entry.role}`, "", entry.text, "")
  }
  return lines.join("\n").trimEnd() + "\n"
}

export const exportTranscriptJson = (transcript: SessionTranscript): string => JSON.stringify(transcript, null, 2)
