import * as Log from "@oc2-ai/core/util/log"
import { Bonjour } from "bonjour-service"

const log = Log.create({ service: "mdns" })

let bonjour: Bonjour | undefined
let currentPort: number | undefined

export function publish(port: number, domain?: string) {
  if (currentPort === port) return
  if (bonjour) unpublish()

  try {
    bonjour = new Bonjour()
    const published = [
      { name: `oc2-${port}`, host: domain ?? "oc2.local" },
      ...(domain ? [] : [{ name: `opencode-${port}`, host: "opencode.local" }]),
    ]

    for (const entry of published) {
      const service = bonjour.publish({
        name: entry.name,
        type: "http",
        host: entry.host,
        port,
        txt: { path: "/" },
      })

      service.on("up", () => {
        log.info("mDNS service published", { name: entry.name, host: entry.host, port })
      })

      service.on("error", (err) => {
        log.error("mDNS service error", { name: entry.name, host: entry.host, error: err })
      })
    }

    currentPort = port
  } catch (err) {
    log.error("mDNS publish failed", { error: err })
    if (bonjour) {
      try {
        bonjour.destroy()
      } catch {}
    }
    bonjour = undefined
    currentPort = undefined
  }
}

export function unpublish() {
  if (bonjour) {
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    } catch (err) {
      log.error("mDNS unpublish failed", { error: err })
    }
    bonjour = undefined
    currentPort = undefined
    log.info("mDNS service unpublished")
  }
}

export * as MDNS from "./mdns"
