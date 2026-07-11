import path from "path"
import { expect, test } from "bun:test"
import ts from "typescript"

const transpiler = new Bun.Transpiler({ loader: "ts" })

const baseline = [
  "src/config.ts -> src/v1/config/config",
  "src/config.ts -> src/v1/config/migrate",
  "src/config/plugin/agent.ts -> src/v1/config/agent",
  "src/config/plugin/agent.ts -> src/v1/config/migrate",
  "src/session.ts -> src/v1/session",
  "src/session/projector.ts -> src/v1/session",
  "src/session/sql.ts -> src/v1/permission",
  "src/session/sql.ts -> src/v1/session",
]

function moduleSpecifiers(input: string) {
  const result = transpiler.scan(input).imports.map((item) => item.path)
  const source = ts.createSourceFile("source.ts", input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text)
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      result.push(node.moduleReference.expression.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      result.push(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return [...new Set(result)]
}

function dependencyEdges(source: string, input: string) {
  return moduleSpecifiers(input).flatMap((specifier) => {
    const target = specifier.startsWith("@oc2-ai/core/v1")
      ? path.posix.join("src", specifier.slice("@oc2-ai/core/".length))
      : specifier.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier))
        : undefined
    return target === "src/v1" || target?.startsWith("src/v1/") ? [`${source} -> ${target}`] : []
  })
}

test("finds runtime and type-only module specifiers", () => {
  const imports = moduleSpecifiers(`
    import type { Imported } from "./v1/imported"
    import type Legacy = require("./v1/legacy")
    export type { Exported } from "./v1/exported"
    type Queried = import("./v1/queried").Queried
    const loaded = import("./v1/loaded")
    const ignored = 'import type { Ignored } from "./v1/ignored"'
  `)

  expect(imports.sort()).toEqual(["./v1/exported", "./v1/imported", "./v1/legacy", "./v1/loaded", "./v1/queried"])
})

test("finds self-package V1 dependency edges", () => {
  const edges = dependencyEdges(
    "src/example.ts",
    `
      import "@oc2-ai/core/v1"
      type Session = import("@oc2-ai/core/v1/session").Session
    `,
  )

  expect(edges.sort()).toEqual(["src/example.ts -> src/v1", "src/example.ts -> src/v1/session"])
})

test("does not add V2-to-V1 dependencies", async () => {
  const edges: string[] = []

  for await (const source of new Bun.Glob("src/**/*.ts").scan(".")) {
    if (source.startsWith("src/v1/")) continue
    edges.push(...dependencyEdges(source, await Bun.file(source).text()))
  }

  expect([...new Set(edges)].sort().filter((edge) => !baseline.includes(edge))).toEqual([])
})
