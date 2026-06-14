import { TUI_KEYMAP } from "../keymap"

export function Footer(): string {
  return `${TUI_KEYMAP.submit} submit | ${TUI_KEYMAP.toggleSidePanel} side panel | ${TUI_KEYMAP.toggleTeamPanel} team | ${TUI_KEYMAP.toggleMcpPanel}/empty Enter mcp | ${TUI_KEYMAP.escape} close | ${TUI_KEYMAP.cancel} cancel/exit`
}
