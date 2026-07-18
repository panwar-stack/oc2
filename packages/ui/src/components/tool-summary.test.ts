import { describe, expect, test } from "bun:test"
import {
  isDeniedToolError,
  safeWebHref,
  toolAggregate,
  toolDetails,
  toolDuration,
  toolErrorSummary,
  toolState,
  toolSummary,
} from "./tool-summary"

describe("transcript tool metadata", () => {
  test("maps wire states and durations to canonical grammar", () => {
    expect(["pending", "running", "completed", "error"].map((status) => toolState(status))).toEqual([
      { glyph: "pending", label: "Pending", tone: "muted", status: "pending" },
      { glyph: "running", label: "Running", tone: "active", status: "running" },
      { glyph: "done", label: "Completed", tone: "success", status: "completed" },
      { glyph: "failed", label: "Failed", tone: "error", status: "error" },
    ])
    expect(toolState("error", true)).toEqual({ glyph: "failed", label: "Denied", tone: "error", status: "denied" })
    expect(toolDuration({ time: { start: 1_000, end: 1_425 } })).toBe("425ms")
    expect(toolDuration({ time: { start: 1_000, end: 3_250 } })).toBe("2.3s")
    expect(toolDuration({ time: { start: 3_250 } }, 5_500)).toBe("2.3s")
  })

  test("fails unknown and secret-bearing inputs closed", () => {
    expect(
      toolSummary({
        tool: "custom_provider_tool",
        input: {
          token: "sk-secret",
          command: "deploy --token secret",
          body: "secret body",
          headers: { Authorization: "Bearer secret" },
        },
      }),
    ).toBeUndefined()
    expect(toolDetails({ tool: "custom_provider_tool", input: { password: "hunter2" } })).toEqual([])
  })

  test("uses explicit read, search, and web allowlists", () => {
    expect(
      toolSummary({
        tool: "read",
        input: { filePath: "src/index.ts", offset: 2, limit: 10, token: "secret" },
      }),
    ).toBe("filePath=src/index.ts · offset=2 · limit=10")
    expect(
      toolSummary({
        tool: "grep",
        input: { pattern: "needle", path: "src", include: "*.ts", headers: { auth: "secret" } },
      }),
    ).toBe("pattern=needle · path=src · include=*.ts")
    expect(
      toolSummary({
        tool: "webfetch",
        input: { url: "https://user:password@example.com/private?token=secret#fragment" },
      }),
    ).toBe("https://example.com/private")
    expect(safeWebHref("javascript:alert(sk-secret)")).toBeUndefined()
    expect(toolSummary({ tool: "webfetch", input: { url: "not a URL?secret=yes" } })).toBe("Web request")
  })

  test("never summarizes shell commands, patches, or edit content", () => {
    expect(
      toolSummary({
        tool: "bash",
        input: { command: "deploy sk-secret", env: { TOKEN: "secret" } },
        metadata: { exit: 17, output: "secret output" },
      }),
    ).toBe("Shell command · exit=17")
    expect(toolSummary({ tool: "write", input: { filePath: "src/write.ts", content: "sk-secret" } })).toBe(
      "filePath=src/write.ts",
    )
    expect(
      toolSummary({
        tool: "apply_patch",
        input: { patchText: "+const token = 'secret'" },
        metadata: { files: [{ filePath: "src/a.ts", patch: "secret" }, { relativePath: "src/b.ts" }] },
      }),
    ).toBe("src/a.ts, src/b.ts")
  })

  test("summarizes remaining structured tools without bodies", () => {
    expect(
      toolSummary({
        tool: "task",
        input: { subagent_type: "explore", session_id: "child-1", prompt: "secret prompt" },
        metadata: { status: "working", result: "secret result" },
      }),
    ).toBe("subagent_type=explore · session_id=child-1 · status=working")
    expect(toolSummary({ tool: "todowrite", input: { todos: [{ content: "secret", status: "pending" }] } })).toBe(
      "1 pending",
    )
    expect(toolSummary({ tool: "question", input: { questions: [{ question: "secret" }] } })).toBe(
      "1 question · 1 single-select",
    )
    expect(toolSummary({ tool: "team_send_message", input: { recipient: "lead", body: "secret" } })).toBe(
      "recipient=lead",
    )
  })

  test("computes aggregate status and denied grammar", () => {
    expect(toolAggregate([{ status: "completed" }, { status: "completed" }])).toEqual({
      glyph: "done",
      label: "all ok",
      tone: "green",
    })
    expect(toolAggregate([{ status: "completed" }, { status: "running" }]).label).toBe("running")
    expect(toolAggregate([{ status: "pending", approval: true }])).toEqual({
      glyph: "needs-you",
      label: "1 approval",
      tone: "purple",
    })
    expect(toolAggregate([{ status: "error", error: "permission denied by user" }])).toEqual({
      glyph: "failed",
      label: "1 denied",
      tone: "red",
    })
    expect(isDeniedToolError("QuestionRejectedError: user dismissed")).toBe(true)
    expect(toolErrorSummary("permission denied: token=secret")).toBe("permission denied")
    expect(toolErrorSummary("Process exited with code 17: secret output")).toBe("exit 17")
    expect(toolErrorSummary("provider returned sk-secret")).toBe("failed")
  })
})
