import { TUI_KEYMAP } from "../keymap"

export function Footer(): string {
  return `${TUI_KEYMAP.submit} submit | ${TUI_KEYMAP.toggleSidePanel} side panel | ${TUI_KEYMAP.cancel} cancel/exit`
}
