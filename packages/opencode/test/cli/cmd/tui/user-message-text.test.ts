import { expect, test } from "bun:test"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { shouldRenderUserMessageTextPart } from "../../../../src/cli/cmd/tui/routes/session"

test("renders only non-synthetic and supervisor synthetic user text", () => {
  expect(shouldRenderUserMessageTextPart(part({ synthetic: false }))).toBe(true)
  expect(shouldRenderUserMessageTextPart(part({ synthetic: true }))).toBe(false)
  expect(shouldRenderUserMessageTextPart(part({ synthetic: true, metadata: { supervisor: { id: "rec_1" } } }))).toBe(true)
  expect(shouldRenderUserMessageTextPart(part({ synthetic: true, metadata: { other: true } }))).toBe(false)
})

function part(input: Pick<TextPart, "synthetic" | "metadata">): TextPart {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: "message",
    ...input,
  }
}
