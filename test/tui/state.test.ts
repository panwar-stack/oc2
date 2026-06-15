import { expect, test } from "bun:test"

import {
  appendLocalMessage,
  applyTuiEvent,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  hydrateTuiState,
  closeActivePanel,
  toggleMcpPanel,
  toggleSidePanel,
  toggleTeamPanel,
} from "../../src/tui/state"
import { RuntimeError } from "../../src/events/events"
import { parseTuiKey } from "../../src/tui/keymap"

test("projects model streaming into an assistant message", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "model.started",
    payload: { sessionId: "s1", taskId: "m1", model: "test" },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "model.delta",
    payload: { sessionId: "s1", taskId: "m1", delta: "hello" },
  })
  state = applyTuiEvent(state, {
    id: "3",
    timestamp: new Date(),
    type: "model.delta",
    payload: { sessionId: "s1", taskId: "m1", delta: " world" },
  })

  expect(state.running).toBe(true)
  expect(state.streamingText).toBe("hello world")

  state = applyTuiEvent(state, {
    id: "4",
    timestamp: new Date(),
    type: "model.completed",
    payload: { sessionId: "s1", taskId: "m1" },
  })

  expect(state.running).toBe(false)
  expect(state.streamingText).toBe("")
  expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "hello world", status: "completed" })
})

test("projects tool status and errors", () => {
  const error = new RuntimeError({ code: "task_failed", message: "denied", kind: "tool" }).toJSON()
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "tool.started",
    payload: { sessionId: "s1", taskId: "t1", toolName: "bash" },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "tool.failed",
    payload: { sessionId: "s1", taskId: "t1", toolName: "bash", error },
  })

  expect(state.toolCalls).toEqual([{ id: "t1", name: "bash", status: "failed", error: "denied" }])
})

test("toggles side panel and hydrates persisted transcript", () => {
  const state = hydrateTuiState(
    toggleSidePanel(createInitialTuiState(true)),
    [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        createdAt: "now",
        updatedAt: "now",
        parts: [{ type: "text", text: "hello" }],
        status: "completed",
      },
    ],
    [],
  )

  expect(state.sidePanel).toBe(false)
  expect(state.sessionId).toBe("s1")
  expect(state.messages).toEqual([{ id: "m1", role: "user", text: "hello", status: "completed" }])
})

test("runtime events preserve hydrated and locally submitted messages", () => {
  let state = hydrateTuiState(
    createInitialTuiState(true),
    [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        createdAt: "now",
        updatedAt: "now",
        parts: [{ type: "text", text: "previous" }],
        status: "completed",
      },
    ],
    [],
  )
  state = appendLocalMessage(state, "user", "next")
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "model.started",
    payload: { sessionId: "s1", taskId: "m2", model: "test" },
  })

  expect(state.messages.map((message) => message.text)).toEqual(["previous", "next"])
})

test("run completion helpers preserve cancellation and surface submit errors", () => {
  const running = { ...createInitialTuiState(true), running: true, status: "running" as const }

  expect(completeTuiRun(running, { sessionId: "s1", status: "failed" }, true)).toMatchObject({
    running: false,
    status: "cancelled",
  })

  const failed = failTuiRun(running, new Error("bad resume"), false)
  expect(failed).toMatchObject({ running: false, status: "failed" })
  expect(failed.errors).toEqual(["bad resume"])
})

test("projects pending plan approvals and report availability", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "team.member.updated",
    payload: {
      teamId: "team-1",
      memberId: "member-1",
      memberName: "planner",
      status: "plan_pending",
      planStatus: "submitted",
    },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "team.updated",
    payload: { teamId: "team-1", status: "active", reportAvailable: true },
  })

  expect(state.pendingPlanApprovals).toEqual([
    { teamId: "team-1", memberId: "member-1", memberName: "planner", status: "plan_pending" },
  ])
  expect(state.teamReportAvailable).toBe(true)

  state = applyTuiEvent(state, {
    id: "3",
    timestamp: new Date(),
    type: "team.member.updated",
    payload: { teamId: "team-1", memberId: "member-1", status: "starting", planStatus: "approved" },
  })
  expect(state.pendingPlanApprovals).toEqual([])
})

test("clears pending plan approvals when a team shuts down", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "team.member.updated",
    payload: {
      teamId: "team-1",
      memberId: "member-1",
      memberName: "planner",
      status: "plan_pending",
      planStatus: "submitted",
    },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "team.updated",
    payload: { teamId: "team-1", status: "shutdown" },
  })

  expect(state.pendingPlanApprovals).toEqual([])
})

test("projects rich team panel data", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "team.updated",
    payload: { teamId: "team-1", status: "active", name: "frontend", goal: "ship panels" },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "team.member.updated",
    payload: {
      teamId: "team-1",
      memberId: "member-1",
      memberName: "reviewer",
      status: "active",
      lifecycle: "daemon",
      dependencyIds: ["member-0"],
      daemonState: "running",
    },
  })
  state = applyTuiEvent(state, {
    id: "3",
    timestamp: new Date(),
    type: "team.task.updated",
    payload: {
      teamId: "team-1",
      taskId: "task-1",
      status: "in_progress",
      description: "verify narrow UI",
      assignee: "reviewer",
      dependencyIds: ["task-0"],
    },
  })
  state = applyTuiEvent(state, {
    id: "4",
    timestamp: new Date(),
    type: "team.message.delivered",
    payload: { teamId: "team-1", messageId: "msg-1", recipientId: "lead", sender: "reviewer", body: "ready" },
  })

  expect(state.teams[0]).toMatchObject({ id: "team-1", name: "frontend", goal: "ship panels" })
  expect(state.teams[0]?.members[0]).toMatchObject({ name: "reviewer", lifecycle: "daemon", daemonState: "running" })
  expect(state.teams[0]?.tasks[0]).toMatchObject({ description: "verify narrow UI", assignee: "reviewer" })
  expect(state.teams[0]?.mailbox[0]).toMatchObject({ sender: "reviewer", body: "ready" })
})

test("redacts free-form team and question projection fields", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "team.updated",
    payload: { teamId: "team-1", status: "active", name: "sk-1234567890", goal: "Bearer abc123456789" },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "team.task.updated",
    payload: { teamId: "team-1", taskId: "task-1", status: "pending", description: "use openai-1234567890" },
  })
  state = applyTuiEvent(state, {
    id: "3",
    timestamp: new Date(),
    type: "permission.requested",
    payload: {
      permissionId: "q1",
      toolName: "question",
      question: {
        header: "Bearer token123456789",
        question: "Use sk-abcdefghijkl?",
        options: [{ label: "openai-1234567890", description: "Bearer abc123456789" }],
      },
    },
  })

  expect(state.teams[0]?.name).toBe("[REDACTED]")
  expect(state.teams[0]?.goal).toBe("Bearer [REDACTED]")
  expect(state.teams[0]?.tasks[0]?.description).toBe("use [REDACTED]")
  expect(state.questionPrompt?.header).toBe("Bearer [REDACTED]")
  expect(state.questionPrompt?.question).toBe("Use [REDACTED]?")
  expect(state.questionPrompt?.options[0]).toEqual({ label: "[REDACTED]", description: "Bearer [REDACTED]" })
})

test("projects MCP, permission, question, diagnostics, and agent status", () => {
  const error = new RuntimeError({ code: "task_failed", message: "token redacted", kind: "mcp" }).toJSON()
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, {
    id: "1",
    timestamp: new Date(),
    type: "mcp.status",
    payload: {
      serverId: "browser",
      status: "auth_required",
      authState: "callback_pending",
      toolCount: 2,
      tools: ["mcp_browser_open"],
      resourceCount: 3,
      promptCount: 4,
      authUrl: "http://127.0.0.1:7331/callback",
      error,
    },
  })
  state = applyTuiEvent(state, {
    id: "2",
    timestamp: new Date(),
    type: "permission.requested",
    payload: {
      permissionId: "perm-1",
      toolName: "bash",
      action: "execute",
      resource: "npm test",
      question: { header: "Proceed?", question: "Run tests?", options: [{ label: "Yes" }], multiple: false },
    },
  })
  state = applyTuiEvent(state, {
    id: "3",
    timestamp: new Date(),
    type: "permission.resolved",
    payload: { permissionId: "perm-1", decision: "deny", toolName: "bash", reason: "user rejected" },
  })
  state = applyTuiEvent(state, {
    id: "4",
    timestamp: new Date(),
    type: "diagnostic.warning",
    payload: { message: "narrow terminal", code: "tui.narrow" },
  })
  state = applyTuiEvent(state, {
    id: "5",
    timestamp: new Date(),
    type: "scheduler.task.updated",
    payload: { taskId: "agent-1", kind: "team-member", status: "running" },
  })

  expect(state.mcpServers[0]).toMatchObject({
    serverId: "browser",
    authRequired: true,
    authState: "callback_pending",
    toolCount: 2,
    resourceCount: 3,
    promptCount: 4,
    authUrl: "http://127.0.0.1:7331/callback",
  })
  expect(state.permissions[0]).toMatchObject({ permissionId: "perm-1", status: "deny", reason: "user rejected" })
  expect(state.questionPrompt).toBeUndefined()
  expect(state.diagnostics).toEqual([{ message: "narrow terminal", code: "tui.narrow" }])
  expect(state.agentTasks).toEqual([{ id: "agent-1", kind: "team-member", status: "running" }])
})

test("toggles PR14 panels and parses shortcuts", () => {
  let state = createInitialTuiState(true)
  state = toggleTeamPanel(state)
  expect(state.activePanel).toBe("team")
  state = toggleMcpPanel(state)
  expect(state.activePanel).toBe("mcp")
  state = closeActivePanel({
    ...state,
    questionPrompt: { permissionId: "q1", question: "Q?", options: [], multiple: false },
  })
  expect(state.activePanel).toBe("session")
  expect(state.questionPrompt).toBeUndefined()

  expect(parseTuiKey("\u0014")).toEqual({ action: "toggle-team-panel" })
  expect(parseTuiKey("\u001b[77~")).toEqual({ action: "toggle-mcp-panel" })
  expect(parseTuiKey("\u001b")).toEqual({ action: "escape" })
  expect(parseTuiKey("\r")).toEqual({ action: "submit" })
})
