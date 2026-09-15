import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { memberEnvContract, OC2_CLI_ENTRY, spawnMemberProcess } from "@/team/member-process"

const legacyPromptEnv = "OC2_TEAM_MEMBER_PROMPT"
const originalCliEntry = process.env[OC2_CLI_ENTRY]
const originalLegacyPrompt = process.env[legacyPromptEnv]
const dirs: string[] = []

afterEach(() => {
  if (originalCliEntry === undefined) delete process.env[OC2_CLI_ENTRY]
  else process.env[OC2_CLI_ENTRY] = originalCliEntry
  if (originalLegacyPrompt === undefined) delete process.env[legacyPromptEnv]
  else process.env[legacyPromptEnv] = originalLegacyPrompt
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const input = (memberPrompt: string, cwd: string) => ({
  teamID: "team-test",
  memberSessionID: "session-test",
  memberID: "member-test",
  leadURL: "http://127.0.0.1:1",
  secret: "secret-test",
  dbPath: path.join(cwd, "member.sqlite"),
  configContent: "{}",
  memberPrompt,
  cwd,
})

describe("member process", () => {
  test("sends the exact prompt through stdin and removes legacy prompt environment data", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "oc2-member-process-"))
    dirs.push(dir)
    const output = path.join(dir, "payload.json")
    const script = path.join(dir, "member.ts")
    const memberPrompt = "Member prompt: café 漢字\n".repeat(20_000)
    await Bun.write(
      script,
      `await Bun.write(${JSON.stringify(output)}, JSON.stringify({ prompt: await Bun.stdin.text(), legacyPrompt: process.env.${legacyPromptEnv} }))`,
    )

    process.env[OC2_CLI_ENTRY] = script
    process.env[legacyPromptEnv] = "inherited prompt must not leak"
    expect(memberEnvContract(input(memberPrompt, dir))[legacyPromptEnv]).toBeUndefined()

    await Effect.runPromise(spawnMemberProcess(input(memberPrompt, dir)))
    const payload = await waitForPayload(output)
    expect(payload).toEqual({ prompt: memberPrompt })
  })

  test("closes stdin after an empty prompt payload", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "oc2-member-process-empty-"))
    dirs.push(dir)
    const output = path.join(dir, "payload.json")
    const script = path.join(dir, "member.ts")
    await Bun.write(script, `await Bun.write(${JSON.stringify(output)}, JSON.stringify({ prompt: await Bun.stdin.text() }))`)

    process.env[OC2_CLI_ENTRY] = script
    await Effect.runPromise(spawnMemberProcess(input("", dir)))

    expect(await waitForPayload(output)).toEqual({ prompt: "" })
  })
})

async function waitForPayload(output: string): Promise<unknown> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const file = Bun.file(output)
    if (await file.exists()) return file.json()
    await Bun.sleep(20)
  }
  throw new Error("member process did not write its stdin payload")
}
