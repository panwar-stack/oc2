import { expect, test } from "bun:test"
import { messagePrompt } from "../../../../src/cli/cmd/run/session.shared"

test("ignores synthetic user text", () => {
  const prompt = messagePrompt({
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: 1 },
    },
    parts: [
      {
        id: "prt_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "visible",
        synthetic: false,
      },
      {
        id: "prt_2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "hidden",
        synthetic: true,
        metadata: { supervisor: { id: "rec_1" } },
      },
    ],
  })

  expect(prompt.text).toBe("visible")
  expect(prompt.parts).toEqual([])
})
