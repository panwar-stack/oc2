import { afterEach, describe, expect, test } from "bun:test"
import { ServerAddress } from "@/server/address"
import { TeamControlPlane } from "@/team/control-plane"

// The control-plane listener memoizes process-wide, and `ServerAddress` is
// process-global state. Each test restores both so the suite stays order
// independent: `ensureLeadControlPlaneListener()` in the first test must not
// leak its bridge into the second, and an explicit lead URL must never observe
// a URL published by an earlier test.
const originalLeadURL = process.env.OC2_TEAM_LEAD_URL

afterEach(() => {
  if (originalLeadURL === undefined) delete process.env.OC2_TEAM_LEAD_URL
  else process.env.OC2_TEAM_LEAD_URL = originalLeadURL
  TeamControlPlane.resetLeadControlPlaneListener()
  ServerAddress.setServerURL(undefined)
})

describe("lead control-plane listener", () => {
  test(
    "exposes a reachable loopback control plane when no lead URL or listener exists",
    async () => {
      delete process.env.OC2_TEAM_LEAD_URL
      ServerAddress.setServerURL(undefined)

      const url = await TeamControlPlane.ensureLeadControlPlaneListener()

      // Only the loopback prefix and a positive port are guaranteed: the bridge
      // prefers 4096 but falls back to an ephemeral port when 4096 is taken.
      expect(url).toStartWith("http://127.0.0.1:")
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d{1,5}$/)
      const port = Number(new URL(url).port)
      expect(port).toBeGreaterThan(0)

      // The bridge publishes its own URL through ServerAddress, so the resolver
      // returns the same reachable base URL the caller just received.
      expect(TeamControlPlane.resolveLeadControlPlaneURL()).toBe(url)

      const response = await fetch(new URL("/global/health", url))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ healthy: true })
    },
    // The first bridge request lazily imports the server graph, which can exceed
    // Bun's 5s default on a cold module cache.
    30_000,
  )

  test(
    "forwards a POST body and its JSON response through the bridge",
    async () => {
      delete process.env.OC2_TEAM_LEAD_URL
      ServerAddress.setServerURL(undefined)

      const url = await TeamControlPlane.ensureLeadControlPlaneListener()

      // `/sync/history` accepts a body-carried aggregate cursor and answers with
      // the durable event rows. An empty object is a valid payload, so a 200 with
      // a JSON array proves the bridge forwarded the method, the JSON body, and
      // the response. The row count is not asserted: it depends on prior writes.
      const response = await fetch(new URL("/sync/history", url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-oc2-directory": process.cwd() },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(200)
      expect(Array.isArray(await response.json())).toBe(true)
    },
    30_000,
  )

  test("is idempotent: concurrent callers share one listener and one URL", async () => {
    delete process.env.OC2_TEAM_LEAD_URL
    ServerAddress.setServerURL(undefined)

    const [first, second] = await Promise.all([
      TeamControlPlane.ensureLeadControlPlaneListener(),
      TeamControlPlane.ensureLeadControlPlaneListener(),
    ])
    expect(first).toBe(second)
    expect(ServerAddress.url?.origin).toBe(first)

    // A third call after the bind resolves returns the same memoized URL and
    // does not move the published origin.
    expect(await TeamControlPlane.ensureLeadControlPlaneListener()).toBe(first)
    expect(ServerAddress.url?.origin).toBe(first)
  })

  test("an explicit OC2_TEAM_LEAD_URL wins and no bridge is bound", async () => {
    process.env.OC2_TEAM_LEAD_URL = "http://127.0.0.1:59999"
    ServerAddress.setServerURL(undefined)

    expect(await TeamControlPlane.ensureLeadControlPlaneListener()).toBe("http://127.0.0.1:59999")

    // The explicit URL short-circuits before the bridge, so no listener binds
    // and no URL is published.
    expect(ServerAddress.url).toBeUndefined()
  })

  test("a reset racing an in-flight bind closes the late listener instead of leaking it", async () => {
    delete process.env.OC2_TEAM_LEAD_URL
    ServerAddress.setServerURL(undefined)

    // The bind resolves on a later 'listening' event, so the reset below is
    // observed synchronously while the bind is still in flight.
    const pending = TeamControlPlane.ensureLeadControlPlaneListener()
    TeamControlPlane.resetLeadControlPlaneListener()

    let rejection: unknown
    await pending.catch((error: unknown) => {
      rejection = error
    })
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection instanceof Error ? rejection.message : "").toMatch(/reset while binding/)
    // The late listener must not publish its URL.
    expect(ServerAddress.url).toBeUndefined()

    // The memo was cleared, so a fresh ensure binds a healthy listener.
    const fresh = await TeamControlPlane.ensureLeadControlPlaneListener()
    expect(ServerAddress.url?.origin).toBe(fresh)
    const response = await fetch(new URL("/global/health", fresh))
    expect(response.status).toBe(200)
  })
})
