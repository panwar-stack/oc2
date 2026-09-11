/**
 * Process-local record of the last server URL this process listened on.
 *
 * A lead process publishes the control-plane URL here after `Server.listen`
 * binds a port. That lets lifecycle code resolve the lead control plane in the
 * same process even when no explicit `OC2_TEAM_LEAD_URL` was exported. A member
 * process never calls `listen`, so the value stays undefined there.
 */
export let url: URL | undefined

export function setServerURL(value: URL | undefined) {
  url = value
}

export * as ServerAddress from "./address"
