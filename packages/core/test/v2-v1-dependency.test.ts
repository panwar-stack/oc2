import path from "path"
import { expect, test } from "bun:test"

const baseline = [
  "src/config.ts -> src/v1/config/config",
  "src/config.ts -> src/v1/config/migrate",
  "src/config/plugin/agent.ts -> src/v1/config/agent",
  "src/config/plugin/agent.ts -> src/v1/config/migrate",
  "src/session.ts -> src/v1/session",
  "src/session/projector.ts -> src/v1/session",
  "src/session/sql.ts -> src/v1/permission",
]

test("does not add V2-to-V1 dependencies", async () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const edges: string[] = []

  for await (const source of new Bun.Glob("src/**/*.ts").scan(".")) {
    if (source.startsWith("src/v1/")) continue
    for (const item of transpiler.scan(await Bun.file(source).text()).imports) {
      if (!item.path.startsWith(".")) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), item.path))
      if (target.startsWith("src/v1/")) edges.push(`${source} -> ${target}`)
    }
  }

  expect([...new Set(edges)].sort().filter((edge) => !baseline.includes(edge))).toEqual([])
})
