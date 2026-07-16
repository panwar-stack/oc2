import { describe, expect, test } from "bun:test"

describe("merge queue CI scope", () => {
  test("always selects every expensive check for merge_group", async () => {
    const child = Bun.spawn([process.execPath, "script/ci-scope.ts", "--event=merge_group", "--files=docs/readme.md"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("full=true")
    expect(stdout).toContain("run_typecheck=true")
    expect(stdout).toContain("run_unit=true")
    expect(stdout).toContain("run_httpapi=true")
    expect(stdout).toContain("run_e2e=true")
    expect(stdout).toContain("turbo_filter=")
  })

  test("has no stale master fallback when a PR base cannot be resolved", async () => {
    const source = await Bun.file(new URL("ci-scope.ts", import.meta.url)).text()
    expect(source).not.toContain('?? "master"')
    expect(source).not.toContain("origin/master...HEAD")
    expect(source).toContain('throw new Error("unable to resolve CI base ref")')
  })

  test("candidate jobs retain no write or persisted checkout credential", async () => {
    for (const path of [".github/workflows/test.yml", ".github/workflows/typecheck.yml"]) {
      const workflow = await Bun.file(new URL(`../${path}`, import.meta.url)).text()
      expect(workflow).toContain("permissions: {}")
      expect(workflow).not.toContain("checks: write")
      expect(workflow).not.toContain("contents: write")
      expect(workflow.match(/persist-credentials: false/g)?.length).toBeGreaterThanOrEqual(1)
    }
  })
})
