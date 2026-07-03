#!/usr/bin/env bun
import { existsSync, statSync } from "fs"
import path from "path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "..")
const args = new Set(Bun.argv.slice(2))
const includeGraph = args.has("--graph")
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts"]
const scanRoots = ["src", "test", "tests", ".storybook", "script", "scripts"]
const internalRoots = new Set(["src", "test", "tests", "script", "scripts", "gen", "generated", "dist", "out"])
const allowedHighLayerEdges = new Set(["@opencode-ai/core -> @opencode-ai/llm"])

type WorkspacePackage = {
  name: string
  root: string
  relativeRoot: string
}

type BaselineException = {
  source: string
  import: string
  target: string
  reason: string
}

type ImportRecord = {
  specifier: string
  line: number
}

type Violation = {
  source: string
  specifier: string
  target: string
  line: number
  sourcePackage: WorkspacePackage
  targetPackage: WorkspacePackage
  baseline?: BaselineException
}

const rootPackage = await Bun.file(path.join(root, "package.json")).json()
const packages = await discoverPackages(rootPackage.workspaces?.packages ?? [])
const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]))
const baseline = await loadBaseline()
const packageEdges = new Set<string>()
const fileEdges = new Map<string, Set<string>>()
const incomingFiles = new Map<string, Set<string>>()
const violations: Violation[] = []

for (const pkg of packages) {
  for (const file of await scanPackageFiles(pkg)) {
    const source = relative(file)
    for (const record of await parseImports(file)) {
      if (record.specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(file, record.specifier)
        if (!resolved) continue
        const target = relative(resolved)
        addFileEdge(source, target)
        const targetPackage = packageForFile(resolved)
        if (!targetPackage || targetPackage === pkg) continue
        packageEdges.add(edgeKey(pkg.name, targetPackage.name))
        if (!isInternalPackagePath(targetPackage, resolved)) continue
        violations.push({
          source,
          specifier: record.specifier,
          target,
          line: record.line,
          sourcePackage: pkg,
          targetPackage,
          baseline: baseline.get(baselineKey(source, record.specifier)),
        })
        continue
      }

      const targetPackage = packageForSpecifier(record.specifier)
      if (!targetPackage || targetPackage === pkg) continue
      packageEdges.add(edgeKey(pkg.name, targetPackage.name))
    }
  }
}

let hasNewViolations = false
for (const violation of violations) {
  if (violation.baseline) {
    warning(
      violation,
      `allowed existing package boundary violation: ${violation.sourcePackage.name} imports ${violation.targetPackage.name} internals (${violation.baseline.reason})`,
    )
    continue
  }

  hasNewViolations = true
  error(
    violation,
    `new package boundary violation: relative import crosses from ${violation.sourcePackage.name} into ${violation.targetPackage.name} internals`,
  )
}

const matchedBaseline = new Set(
  violations.filter((violation) => violation.baseline).map((violation) => baselineKey(violation.source, violation.specifier)),
)
for (const [key, exception] of baseline) {
  if (matchedBaseline.has(key)) continue
  console.warn(`::warning file=${exception.source}::package boundary baseline entry did not match an import: ${exception.import}`)
}

printBoundarySummary(violations)

if (includeGraph) {
  printGraphReport()
}

if (hasNewViolations) {
  process.exitCode = 1
}

async function discoverPackages(workspaces: string[]) {
  const seen = new Set<string>()
  const result: WorkspacePackage[] = []
  for (const workspace of workspaces) {
    for await (const packageJson of new Bun.Glob(`${workspace}/package.json`).scan({ cwd: root, absolute: true })) {
      const packageRoot = path.dirname(packageJson)
      if (seen.has(packageRoot) || !existsFile(packageJson)) continue
      seen.add(packageRoot)
      const data = await Bun.file(packageJson).json()
      if (!data.name) continue
      result.push({
        name: data.name,
        root: packageRoot,
        relativeRoot: relative(packageRoot),
      })
    }
  }
  return result.sort((a, b) => b.root.length - a.root.length)
}

async function loadBaseline() {
  const baselinePath = path.join(root, "script/package-boundary-baseline.jsonc")
  if (!existsFile(baselinePath)) return new Map<string, BaselineException>()
  const parsed = ts.parseConfigFileTextToJson(baselinePath, await Bun.file(baselinePath).text())
  if (parsed.error) {
    const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")
    throw new Error(`Invalid package boundary baseline: ${message}`)
  }
  const exceptions = (parsed.config.exceptions ?? []) as BaselineException[]
  return new Map(exceptions.map((entry) => [baselineKey(entry.source, entry.import), entry]))
}

async function scanPackageFiles(pkg: WorkspacePackage) {
  const files: string[] = []
  for (const dir of scanRoots) {
    const scanRoot = path.join(pkg.root, dir)
    if (!existsDirectory(scanRoot)) continue
    for await (const file of new Bun.Glob("**/*").scan({ cwd: scanRoot, absolute: true, onlyFiles: true })) {
      if (extensions.includes(path.extname(file))) files.push(file)
    }
  }
  return files.sort()
}

async function parseImports(file: string) {
  const text = await Bun.file(file).text()
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const records: ImportRecord[] = []

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      records.push(record(sourceFile, node.moduleSpecifier))
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier && ts.isStringLiteral(specifier)) records.push(record(sourceFile, specifier))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return records
}

function record(sourceFile: ts.SourceFile, literal: ts.StringLiteral): ImportRecord {
  const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile))
  return {
    specifier: literal.text,
    line: position.line + 1,
  }
}

function resolveRelativeImport(sourceFile: string, specifier: string) {
  const candidate = path.resolve(path.dirname(sourceFile), specifier)
  if (existsFile(candidate)) return candidate
  for (const ext of extensions) {
    const withExtension = `${candidate}${ext}`
    if (existsFile(withExtension)) return withExtension
  }
  if (existsDirectory(candidate)) {
    for (const ext of extensions) {
      const indexFile = path.join(candidate, `index${ext}`)
      if (existsFile(indexFile)) return indexFile
    }
  }
  return undefined
}

function packageForFile(file: string) {
  return packages.find((pkg) => file === pkg.root || file.startsWith(`${pkg.root}${path.sep}`))
}

function packageForSpecifier(specifier: string) {
  const [scope, name] = specifier.split("/")
  if (!scope) return undefined
  const packageName = specifier.startsWith("@") ? (name ? `${scope}/${name}` : undefined) : scope
  return packageName ? packageByName.get(packageName) : undefined
}

function isInternalPackagePath(pkg: WorkspacePackage, file: string) {
  const [first] = path.relative(pkg.root, file).split(path.sep)
  return internalRoots.has(first ?? "")
}

function addFileEdge(source: string, target: string) {
  const outgoing = fileEdges.get(source) ?? new Set<string>()
  outgoing.add(target)
  fileEdges.set(source, outgoing)
  const incoming = incomingFiles.get(target) ?? new Set<string>()
  incoming.add(source)
  incomingFiles.set(target, incoming)
}

function printBoundarySummary(found: Violation[]) {
  const allowed = found.filter((violation) => violation.baseline).length
  console.log(`Package boundary check: ${found.length - allowed} new violation(s), ${allowed} allowed existing violation(s).`)
}

function printGraphReport() {
  console.log("\nDependency graph report")

  const edges = [...packageEdges].sort()
  const cycles = stronglyConnectedComponents(edges)
  if (cycles.length === 0) {
    console.log("Package cycles: none")
  } else {
    console.log("Package cycles:")
    for (const cycle of cycles) console.log(`- ${cycle.join(" -> ")}`)
  }

  const highFanIn = [...incomingFiles]
    .filter(([file]) => isImplementationFile(file))
    .map(([file, incoming]) => ({ file, count: incoming.size }))
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, 10)

  if (highFanIn.length === 0) {
    console.log("High fan-in implementation files: none")
  } else {
    console.log("High fan-in implementation files:")
    for (const entry of highFanIn) console.log(`- ${entry.file}: ${entry.count} incoming file edge(s)`)
  }

  const highLayer = edges.filter(isHighLayerEdge)
  if (highLayer.length === 0) {
    console.log("High-layer package edges: none")
    return
  }
  console.log("High-layer package edges:")
  for (const edge of highLayer) {
    const label = allowedHighLayerEdges.has(edge) ? "allowed" : "unlisted"
    if (label === "unlisted") console.warn(`::warning::unlisted high-layer package edge: ${edge}`)
    console.log(`- ${edge} (${label})`)
  }
}

function stronglyConnectedComponents(edges: string[]) {
  const graph = new Map<string, Set<string>>()
  for (const pkg of packages) graph.set(pkg.name, new Set())
  for (const edge of edges) {
    const [from, to] = edge.split(" -> ")
    if (!from || !to) continue
    graph.get(from)?.add(to)
  }

  let index = 0
  const stack: string[] = []
  const indexes = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const onStack = new Set<string>()
  const result: string[][] = []

  const connect = (node: string) => {
    indexes.set(node, index)
    lowlinks.set(node, index)
    index++
    stack.push(node)
    onStack.add(node)

    for (const next of graph.get(node) ?? []) {
      if (!indexes.has(next)) {
        connect(next)
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, lowlinks.get(next) ?? 0))
        continue
      }
      if (onStack.has(next)) lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, indexes.get(next) ?? 0))
    }

    if (lowlinks.get(node) !== indexes.get(node)) return
    const component: string[] = []
    while (stack.length > 0) {
      const next = stack.pop()!
      onStack.delete(next)
      component.push(next)
      if (next === node) break
    }
    if (component.length > 1) result.push(component.sort())
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) connect(node)
  }
  return result.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))
}

function isHighLayerEdge(edge: string) {
  return edge.startsWith("@opencode-ai/core -> ")
}

function isImplementationFile(file: string) {
  return file.includes("/src/") && extensions.includes(path.extname(file))
}

function warning(violation: Violation, message: string) {
  console.warn(`::warning file=${violation.source},line=${violation.line}::${message}: ${violation.specifier} -> ${violation.target}`)
}

function error(violation: Violation, message: string) {
  console.error(`::error file=${violation.source},line=${violation.line}::${message}: ${violation.specifier} -> ${violation.target}`)
}

function existsFile(file: string) {
  return existsSync(file) && statSync(file).isFile()
}

function existsDirectory(file: string) {
  return existsSync(file) && statSync(file).isDirectory()
}

function baselineKey(source: string, specifier: string) {
  return `${source}\u0000${specifier}`
}

function edgeKey(from: string, to: string) {
  return `${from} -> ${to}`
}

function relative(file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}
