import type { Platform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"

export function directoryPickerKind(_platform: Platform["platform"], _server: ServerConnection.Any) {
  return "server" as const
}
