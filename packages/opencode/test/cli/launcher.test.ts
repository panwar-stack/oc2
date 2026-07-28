import { expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("direct executable forwards argv and target exit status", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "fake target.mjs")
  const capture = path.join(tmp.path, "argv.json")
  await writeFile(
    target,
    `#!/usr/bin/env node
import fs from "node:fs"
fs.writeFileSync(process.env.OC2_LAUNCHER_CAPTURE, JSON.stringify(process.argv.slice(2)))
process.exit(23)
`,
  )
  await chmod(target, 0o755)

  const launcher = path.resolve(import.meta.dir, "../../bin/oc2")
  const child = Bun.spawn([launcher, "alpha", "two words", "雪"], {
    env: { ...process.env, OC2_BIN_PATH: target, OC2_LAUNCHER_CAPTURE: capture },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(exitCode).toBe(23)
  expect(stdout).toBe("")
  expect(stderr).toBe("")
  expect(JSON.parse(await readFile(capture, "utf8"))).toEqual(["alpha", "two words", "雪"])
})
