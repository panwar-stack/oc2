export * as SessionCompoundToolPolicy from "./tool-policy"

import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionCompoundConfig } from "./config"
import os from "os"
import path from "path"

const readonlyTools = {
  "*": false,
  read: true,
  grep: true,
  glob: true,
  webfetch: true,
  websearch: true,
  lsp: true,
}

const noTools = { "*": false }

const parentDelegationDisabledTools = {
  team_create: false,
  team_spawn: false,
  local_fusion: false,
}

const scratchTools = {
  ...readonlyTools,
  write: true,
  edit: true,
  apply_patch: false,
}

export type CompoundRole =
  | { type: "branch"; index: number; tempDir: string }
  | { type: "judge"; tempDir: string }
  | { type: "synthesizer" }

export function validate(input: { config: SessionCompoundConfig.Config }) {
  void input
}

export function resolvePromptTools(
  policy: SessionCompoundConfig.ToolPolicy,
  permission: PermissionV1.Ruleset,
  role?: CompoundRole,
) {
  if (policy === "none") return noTools
  if (policy === "readonly") return readonlyTools
  if (isScratchRole(role)) return scratchTools
  if (policy === "all") return {}
  return {
    ...(Permission.evaluate("task", "*", permission).action === "deny" ? {} : { task: true }),
    ...parentDelegationDisabledTools,
  }
}

export function resolveChildPermission(
  parent: PermissionV1.Ruleset,
  policy: SessionCompoundConfig.ToolPolicy,
  input?: { role?: CompoundRole; root: string },
) {
  const parentRules = parent.filter(
    (rule) => rule.action === "deny" || (rule.permission === "external_directory" && rule.action === "allow"),
  )
  if (isScratchRole(input?.role) && isWriteCapable(policy)) {
    return [
      { permission: "edit", pattern: "*", action: "deny" as const },
      { permission: "edit", pattern: tempEditPattern(input.role.tempDir, input.root), action: "allow" as const },
      { permission: "apply_patch", pattern: "*", action: "deny" as const },
      { permission: "external_directory", pattern: tempExternalPattern(input.role.tempDir), action: "allow" as const },
      ...(policy === "parent_without_teams"
        ? Object.keys(parentDelegationDisabledTools).map((permission) => ({
            permission,
            pattern: "*",
            action: "deny" as const,
          }))
        : []),
      ...parentRules,
    ]
  }

  return [
    ...parentRules,
    ...(policy === "parent_without_teams"
      ? Object.keys(parentDelegationDisabledTools).map((permission) => ({
          permission,
          pattern: "*",
          action: "deny" as const,
        }))
      : []),
  ]
}

export function tempDirectory(input: {
  parentSessionID: string
  compoundRunID: string
  role: { type: "branch"; index: number } | { type: "judge" } | { type: "synthesizer" }
  rootDirectories?: string[]
}) {
  const base = tempBase(input.rootDirectories ?? [])
  if (input.role.type === "branch") {
    return path.join(
      base,
      "opencode-local-fusion",
      input.parentSessionID,
      input.compoundRunID,
      `branch-${input.role.index}`,
    )
  }
  if (input.role.type === "judge") {
    return path.join(base, "opencode-local-fusion", input.parentSessionID, input.compoundRunID, "judge")
  }
  throw new Error("Synthesizer does not use a local fusion scratch directory")
}

function isScratchRole(role?: CompoundRole): role is Extract<CompoundRole, { type: "branch" | "judge" }> {
  return role?.type === "branch" || role?.type === "judge"
}

function isWriteCapable(policy: SessionCompoundConfig.ToolPolicy) {
  return policy === "all" || policy === "parent_without_teams"
}

function tempEditPattern(tempDir: string, root: string) {
  return `${path.relative(root, tempDir).replaceAll("\\", "/")}/*`
}

function tempExternalPattern(tempDir: string) {
  return path.join(tempDir, "*").replaceAll("\\", "/")
}

function tempBase(rootDirectories: string[]) {
  const roots = rootDirectories.map((root) => path.resolve(root))
  const suffix = "opencode-local-fusion"
  let base = path.resolve(os.tmpdir())
  for (let attempt = 0; attempt <= roots.length; attempt++) {
    const scratchRoot = path.join(base, suffix)
    const containingRoot = roots
      .filter((root) => containsPath(root, scratchRoot))
      .sort((a, b) => b.length - a.length)[0]
    if (!containingRoot) return base

    const parent = path.dirname(containingRoot)
    if (parent === containingRoot) break
    base = path.join(parent, `${path.basename(containingRoot)}-${suffix}`)
  }
  throw new Error("Cannot create local fusion scratch directory outside session roots")
}

function containsPath(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
