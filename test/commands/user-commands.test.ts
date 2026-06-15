import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

import { createDefaultCommandRegistry, loadUserCommands } from "../../src/commands/user-commands"

test("loads command markdown files from commands and command directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-user-commands-"))
  try {
    await mkdir(join(root, "commands"), { recursive: true })
    await mkdir(join(root, "command"), { recursive: true })
    await writeFile(
      join(root, "commands", "review.md"),
      [
        "---",
        'description: "Review staged changes"',
        'aliases: ["rev", "check"]',
        "subtask: true",
        'agent: "reviewer"',
        'model: "fake/test"',
        "---",
        "Review: $ARGUMENTS",
      ].join("\n"),
    )
    await writeFile(join(root, "command", "plain.md"), "Plain command body")

    const commands = await loadUserCommands([root])

    expect(commands.find((command) => command.name === "review")).toMatchObject({
      description: "Review staged changes",
      aliases: ["rev", "check"],
      source: "user",
      template: "Review: $ARGUMENTS",
      subtask: true,
      agent: "reviewer",
      model: "fake/test",
    })
    expect(commands.find((command) => command.name === "plain")).toMatchObject({
      description: "plain",
      template: "Plain command body",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed frontmatter does not crash command loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc2-user-commands-"))
  try {
    await mkdir(join(root, "commands"), { recursive: true })
    await writeFile(join(root, "commands", "broken.md"), "---\ndescription: Broken\nBody stays whole")

    const commands = await loadUserCommands([root])

    expect(commands).toEqual([
      expect.objectContaining({
        name: "broken",
        description: "broken",
        template: "---\ndescription: Broken\nBody stays whole",
      }),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("default command registry applies file and config precedence", async () => {
  const project = await mkdtemp(join(tmpdir(), "oc2-project-commands-"))
  const user = await mkdtemp(join(tmpdir(), "oc2-user-commands-"))
  try {
    await mkdir(join(project, "commands"), { recursive: true })
    await mkdir(join(user, "commands"), { recursive: true })
    await writeFile(join(project, "commands", "review.md"), "Project review")
    await writeFile(join(user, "commands", "review.md"), "User review")
    await writeFile(join(user, "commands", "deploy.md"), "Deploy $ARGUMENTS")

    const registry = await createDefaultCommandRegistry({
      config: {
        commands: {
          deploy: { description: "Inline deploy", template: "Inline deploy $ARGUMENTS", aliases: ["ship"] },
        },
      },
      paths: {
        projectConfigPaths: [join(project, "oc2.jsonc")],
        userConfigPath: join(user, "config.jsonc"),
      },
    })

    expect(registry.get("review")?.template).toBe("User review")
    expect(registry.get("deploy")).toMatchObject({ description: "Inline deploy", template: "Inline deploy $ARGUMENTS" })
    expect(registry.get("ship")?.name).toBe("deploy")
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(user, { recursive: true, force: true })
  }
})
