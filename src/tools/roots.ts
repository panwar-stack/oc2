import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import type { WorkspaceRoot } from "../persistence/repositories/sessions"
import { ToolExecutionError } from "./tool"

export interface ResolvedWorkspacePath {
  readonly path: string
  readonly root: WorkspaceRoot
}

export interface ResolveWorkspacePathOptions {
  readonly writable?: boolean
  readonly cwd?: string
  readonly mustExist?: boolean
}

export const normalizeWorkspaceRoots = (roots: readonly WorkspaceRoot[], cwd = process.cwd()): readonly WorkspaceRoot[] => {
  if (roots.length === 0) {
    return [{ id: "cwd", path: resolve(cwd), readonly: false }]
  }
  return roots.map((root) => ({ ...root, path: resolve(root.path) }))
}

export const isInsidePath = (parent: string, child: string): boolean => {
  const relation = relative(resolve(parent), resolve(child))
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
}

export const resolveWorkspacePath = async (
  inputPath: string,
  roots: readonly WorkspaceRoot[],
  options: ResolveWorkspacePathOptions = {},
): Promise<ResolvedWorkspacePath> => {
  if (!inputPath.trim()) {
    throw new ToolExecutionError({ code: "invalid_path", message: "Path must not be empty" })
  }

  const normalizedRoots = normalizeWorkspaceRoots(roots, options.cwd)
  const base = options.cwd ? resolve(options.cwd) : normalizedRoots[0]?.path ?? process.cwd()
  const target = resolve(isAbsolute(inputPath) ? inputPath : resolve(base, inputPath))
  const checkPath = options.mustExist ? target : await nearestExistingAncestor(target)
  const realCheckPath = await realpath(checkPath).catch(() => checkPath)
  let realRoot = ""
  const root = await findWorkspaceRoot(normalizedRoots, target, realCheckPath, (canonicalRoot) => {
    realRoot = canonicalRoot
  })

  if (!root) {
    throw new ToolExecutionError({ code: "path_outside_workspace", message: `Path is outside workspace roots: ${inputPath}`, details: { path: inputPath } })
  }

  if (!isInsidePath(realRoot, realCheckPath)) {
    throw new ToolExecutionError({ code: "path_outside_workspace", message: `Path resolves outside workspace roots: ${inputPath}`, details: { path: inputPath, root: root.path } })
  }
  if (options.writable && root.readonly) {
    throw new ToolExecutionError({ code: "readonly_root", message: `Workspace root is read-only: ${root.path}`, details: { path: inputPath, root: root.path } })
  }
  if (options.mustExist) {
    try {
      await lstat(target)
    } catch {
      throw new ToolExecutionError({ code: "not_found", message: `Path does not exist: ${inputPath}`, details: { path: inputPath } })
    }
  }

  return { path: target, root }
}

const findWorkspaceRoot = async (
  roots: readonly WorkspaceRoot[],
  target: string,
  realCheckPath: string,
  onRoot: (realRoot: string) => void,
): Promise<WorkspaceRoot | undefined> => {
  for (const root of roots) {
    const realRoot = await realpath(root.path).catch(() => root.path)
    if (isInsidePath(root.path, target) || isInsidePath(realRoot, realCheckPath)) {
      onRoot(realRoot)
      return root
    }
  }
  return undefined
}

const nearestExistingAncestor = async (path: string): Promise<string> => {
  let current = path
  while (true) {
    try {
      await lstat(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}
