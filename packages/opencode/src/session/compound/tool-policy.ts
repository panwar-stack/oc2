export * as SessionCompoundToolPolicy from "./tool-policy"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionCompoundConfig } from "./config"

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
) {
  if (policy === "none") return noTools
  if (policy === "readonly") return readonlyTools
  if (mode !== "logu") throw new Error(`${policy} toolPolicy is only supported in logu mode`)
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
) {
  return [
    ...parent.filter((rule) => rule.action === "deny" || (rule.permission === "external_directory" && rule.action === "allow")),
    ...(mode === "logu" && policy === "parent_without_teams"
      ? Object.keys(loguDelegatedTools).map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
      : []),
  ]
}
