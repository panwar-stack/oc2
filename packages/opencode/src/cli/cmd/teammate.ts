import { Effect } from "effect"
import { effectCmd, fail, CliError } from "../effect-cmd"
import {
  OC2_PROCESS_ROLE,
  OC2_TEAM_LEAD_URL,
  OC2_TEAM_MEMBER_SESSION_ID,
  OC2_TEAM_ID,
  OC2_TEAM_SECRET,
} from "@oc2-ai/core/util/opencode-process"

const CONTACT_TIMEOUT_MS = 3_000
const SERVER_USERNAME = "oc2"

/**
 * Headless role for a spawned teammate process. The lead cross-spawns the
 * current executable with `teammate` as the first argument and a fixed set of
 * OC2_TEAM_* environment variables (the member env contract in
 * specs/multiprocess-agent-teams.md). This command validates that contract,
 * verifies it can reach the lead's control plane, and exits cleanly when the
 * connection is refused. The full member run loop arrives in later PRs.
 */
export const TeammateCommand = effectCmd({
  command: "teammate",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.teammate")(function* () {
    const role = process.env[OC2_PROCESS_ROLE]
    if (role !== "teammate") {
      return yield* fail(`teammate: refuses to run outside the teammate process role (OC2_PROCESS_ROLE=teammate).`)
    }

    const required = [OC2_TEAM_LEAD_URL, OC2_TEAM_ID, OC2_TEAM_MEMBER_SESSION_ID, OC2_TEAM_SECRET]
    const missing = required.filter((name) => !process.env[name])
    if (missing.length > 0) {
      return yield* fail(`teammate: missing required environment: ${missing.join(", ")}`)
    }

    const leadURL = process.env[OC2_TEAM_LEAD_URL]!
    const teamID = process.env[OC2_TEAM_ID]!
    const sessionID = process.env[OC2_TEAM_MEMBER_SESSION_ID]!
    const secret = process.env[OC2_TEAM_SECRET]!
    const contextURL = `${leadURL}/team/${teamID}/members/${sessionID}/context`
    const basic = Buffer.from(`${SERVER_USERNAME}:${secret}`, "utf8").toString("base64")

    yield* Effect.tryPromise({
      try: () =>
        fetch(contextURL, {
          headers: { Authorization: `Basic ${basic}` },
          signal: AbortSignal.timeout(CONTACT_TIMEOUT_MS),
        }).then(() => undefined),
      catch: (error) =>
        new CliError({
          message: `teammate: cannot reach control plane at ${leadURL}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
    })

    console.log(`teammate connected to ${leadURL}`)
  }),
})
