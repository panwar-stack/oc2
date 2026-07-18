import { expect, test } from "bun:test"

for (const script of ["check-themes.ts", "check-redesign.ts"]) {
  test(`${script} passes as part of the standard UI suite`, async () => {
    const process = Bun.spawn(["bun", "run", `${import.meta.dir}/../../script/${script}`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await process.exited, await new Response(process.stderr).text()).toBe(0)
  })
}
