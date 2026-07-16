import { randomUUID } from "crypto"

const header = "x-oc2-automation-safe"
const token = randomUUID()

export function markAutomationSafe(request: Request) {
  request.headers.set(header, token)
  return request
}

export function isAutomationSafe(headers: Record<string, string | undefined>) {
  return headers[header] === token
}
