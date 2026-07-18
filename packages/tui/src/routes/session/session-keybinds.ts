export const SESSION_ALL_SESSIONS_KEY = "ctrl+o"
export const SESSION_TEAM_PANEL_KEY = "ctrl+y"

export const sessionBindingCommands = [
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.roots",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
  "team.cycle.lead",
  "team.member.first",
  "team.member.next",
  "team.member.previous",
  "team.panel.toggle",
  "team.task.list",
] as const

export const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

export const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const
