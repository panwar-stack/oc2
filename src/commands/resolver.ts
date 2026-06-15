import { readSkillContent } from "../tools/builtins/skill"
import type { SlashCommand } from "./types"

const SKILL_PREFIX = "skill:"

export const resolveCommandTemplate = async (command: SlashCommand, args = ""): Promise<string> => {
  const template = command.template ?? ""
  const resolvedTemplate = template.startsWith(SKILL_PREFIX)
    ? await readSkillContent(template.slice(SKILL_PREFIX.length))
    : template
  const prompt = resolvedTemplate.replaceAll("$ARGUMENTS", args)

  return command.subtask ? `[SUBTASK] ${prompt}` : prompt
}
