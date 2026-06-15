import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { z } from "zod"

import { isInsidePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  name: z.string().min(1),
})

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url))

export const readSkillContent = async (name: string): Promise<string> => {
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new ToolExecutionError({
      code: "invalid_skill_name",
      message: `Invalid skill name: ${name}`,
      details: { name },
    })
  }

  const skillPath = resolve(skillsDir, `${name}.md`)
  if (!isInsidePath(skillsDir, skillPath)) {
    throw new ToolExecutionError({
      code: "invalid_skill_name",
      message: `Skill path resolves outside the skills directory: ${name}`,
      details: { name },
    })
  }

  const file = Bun.file(skillPath)
  if (!(await file.exists())) {
    throw new ToolExecutionError({
      code: "not_found",
      message: `Skill not found: ${name}`,
      details: { name },
    })
  }

  return file.text()
}

/** Creates the built-in skill loader tool for bounded reads from src/skills. */
export const createSkillTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "skill",
  description: "Load a bundled skill markdown file by name.",
  inputSchema,
  modelInputSchema: objectSchema(
    {
      name: stringProperty("Skill name without the .md extension"),
    },
    ["name"],
  ),
  async execute(input) {
    return { content: await readSkillContent(input.name) }
  },
})
