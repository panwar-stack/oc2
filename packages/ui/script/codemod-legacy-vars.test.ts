import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { rewriteLegacyVars, runCodemod } from "./codemod-legacy-vars"

test("rewrites only approved legacy variable mappings", () => {
  const input = [
    "color: var(--text-base);",
    "border: 1px solid var(--border-warning-strong);",
    "background: var(--surface-critical-weak);",
    "--code: var(--syntax-keyword);",
    "--unsupported-code: var(--syntax-property);",
    "--unknown: var(--icon-interactive-base);",
    "--specific: var(--surface-raised-stronger-non-alpha);",
  ].join("\n")
  const output = rewriteLegacyVars(input)

  expect(output).toContain("var(--v2-text-text-base)")
  expect(output).toContain("var(--v2-state-border-warning)")
  expect(output).toContain("var(--v2-state-bg-danger)")
  expect(output).toContain("var(--v2-syntax-keyword)")
  expect(output).toContain("var(--syntax-property)")
  expect(output).toContain("var(--icon-interactive-base)")
  expect(output).toContain("var(--surface-raised-stronger-non-alpha)")
  expect(rewriteLegacyVars(output)).toBe(output)
})

test("dry-run is non-mutating and applying twice is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oc2-legacy-vars-"))
  const titlebar = path.join(root, "packages/app/src/components/titlebar.tsx")
  const timeline = path.join(root, "packages/app/src/pages/session/message-timeline.tsx")
  await mkdir(path.dirname(titlebar), { recursive: true })
  await mkdir(path.dirname(timeline), { recursive: true })
  await Bun.write(titlebar, "const color = 'var(--text-base)'\n")
  await Bun.write(timeline, "const color = 'var(--icon-interactive-base)'\n")

  const lines: string[] = []
  const dryRun = await runCodemod({ root, dryRun: true, print: (line) => lines.push(line) })
  expect(dryRun.changed).toEqual(["packages/app/src/components/titlebar.tsx"])
  expect(await readFile(titlebar, "utf8")).toContain("--text-base")
  expect(lines.at(-1)).toBe("Would update 1 file(s)")

  const applied = await runCodemod({ root, print: () => {} })
  const repeated = await runCodemod({ root, print: () => {} })
  expect(applied.changed).toEqual(["packages/app/src/components/titlebar.tsx"])
  expect(repeated.changed).toEqual([])
  expect(await readFile(titlebar, "utf8")).toContain("--v2-text-text-base")
  await rm(root, { recursive: true, force: true })
})
