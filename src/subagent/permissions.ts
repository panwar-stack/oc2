import type { AgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import type { ToolPermissionRule } from "../tools/permissions"

const recursiveToolNames = [
  "subagent",
  "team_create",
  "team_spawn",
  "team_broadcast",
  "team_send_message",
  "team_get_messages",
  "team_task_create",
  "team_task_claim",
  "team_task_update",
  "team_task_list",
  "team_shutdown",
]

/** Builds the child config overlay that prevents privilege escalation from subagents. */
export function deriveSubAgentConfig(config: Oc2Config, profile: AgentProfile): Oc2Config {
  const tools: Oc2Config["tools"] = {}
  const toolNames = new Set([...Object.keys(config.tools), ...recursiveToolNames])

  for (const name of toolNames) {
    const current = config.tools[name]
    tools[name] = {
      enabled: recursiveToolNames.includes(name) ? false : (current?.enabled ?? true),
      permissions: [...(current?.permissions ?? []), ...profile.allowedTools, ...collectParentDenyRules(config, name)],
    }
  }

  return { ...config, tools }
}

/** Collects parent deny rules so child profile allow rules cannot override them. */
export function collectParentDenyRules(
  config: Pick<Oc2Config, "tools">,
  toolName: string,
): readonly ToolPermissionRule[] {
  return (config.tools[toolName]?.permissions ?? []).filter((rule) => rule.decision === "deny")
}

/** Lists tools that are disabled by default inside subagent child sessions. */
export function defaultDisabledSubAgentTools(): readonly string[] {
  return recursiveToolNames
}
