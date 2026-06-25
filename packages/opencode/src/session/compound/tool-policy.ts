export * as SessionCompoundToolPolicy from "./tool-policy"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
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

const loguDelegatedTools = {
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

export function validate(input: { config: SessionCompoundConfig.Config; mode?: "logu" }) {
  if (input.mode === "logu") return
  const loguOnlyPolicy = [
    ...input.config.branches.map((branch) => branch.toolPolicy),
    input.config.judge.toolPolicy,
    input.config.synthesizer.toolPolicy,
  ].find((policy) => policy === "parent_without_teams" || policy === "all")
  if (loguOnlyPolicy) throw new Error(`${loguOnlyPolicy} toolPolicy is only supported in logu mode`)
}

export function resolvePromptTools(
  policy: SessionCompoundConfig.ToolPolicy,
  mode: "logu" | undefined,
  permission: PermissionV1.Ruleset,
  role?: CompoundRole,
) {
  if (policy === "none") return noTools
  if (policy === "readonly") return readonlyTools
  if (mode !== "logu") throw new Error(`${policy} toolPolicy is only supported in logu mode`)
  if (isScratchRole(role)) return scratchTools
  if (policy === "all") return {}
  return {
    ...(Permission.evaluate("task", "*", permission).action === "deny" ? {} : { task: true }),
    ...loguDelegatedTools,
  }
}

export function resolveChildPermission(
  parent: PermissionV1.Ruleset,
  policy: SessionCompoundConfig.ToolPolicy,
  mode: "logu" | undefined,
  input?: { role?: CompoundRole; root: string },
) {
  const parentRules = parent.filter(
    (rule) => rule.action === "deny" || (rule.permission === "external_directory" && rule.action === "allow"),
  )
  if (mode === "logu" && isScratchRole(input?.role) && isWriteCapable(policy)) {
    return [
      { permission: "edit", pattern: "*", action: "deny" as const },
      { permission: "edit", pattern: tempEditPattern(input.role.tempDir, input.root), action: "allow" as const },
      { permission: "external_directory", pattern: tempExternalPattern(input.role.tempDir), action: "allow" as const },
      ...Object.keys(loguDelegatedTools).map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
      ...parentRules,
    ]
  }

  return [
    ...parentRules,
    ...(mode === "logu" && policy === "parent_without_teams"
      ? Object.keys(loguDelegatedTools).map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
      : []),
  ]
}

export function tempDirectory(input: {
  parentSessionID: string
  compoundRunID: string
  role: { type: "branch"; index: number } | { type: "judge" } | { type: "synthesizer" }
}) {
  if (input.role.type === "branch") {
    return path.join(os.tmpdir(), "opencode-local-fusion", input.parentSessionID, input.compoundRunID, `branch-${input.role.index}`)
  }
  if (input.role.type === "judge") {
    return path.join(os.tmpdir(), "opencode-local-fusion", input.parentSessionID, input.compoundRunID, "judge")
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
