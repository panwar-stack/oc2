import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@oc2-ai/core/schema"
import { Global } from "@oc2-ai/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

const descriptions = {
  bash: "Clear, concise description of what this command does in 5-10 words.",
  powershell:
    "Clear, concise description of what this command does in 5-10 words.",
  cmd: "Clear, concise description of what this command does in 5-10 words.",
}

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema(description: string) {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
    description: Schema.String.annotate({ description }),
  })
}

export const Parameters = parameterSchema(descriptions.bash)
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell notes
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Prefer full cmdlet names like \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, and \`New-Item\` over aliases.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with the PowerShell backtick character.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell (5.1) does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
  }
  if (PS.has(name)) {
    return "If the commands depend on each other and must run sequentially, use one shell call with '&&' to chain them."
  }
  if (CMD.has(name)) {
    return "If the commands depend on each other and must run sequentially, use one shell call with `&&` to chain them."
  }
  return "If the commands depend on each other and must run sequentially, use one Bash call with '&&' to chain them."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `Before executing commands:
- If creating files or directories, first verify the parent exists and is the intended location.
- Always quote file paths that contain spaces with double quotes.
- Use the \`workdir\` parameter instead of \`cd <directory> && <command>\`.
- If no timeout is specified, commands will time out after ${defaultTimeoutMs}ms.
- If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. Use Read with offset/limit or Grep to inspect the saved output; do not use \`head\`, \`tail\`, or similar truncation commands.

Prefer dedicated tools for file work:
- File search: Use Glob, not find/ls.
- Content search: Use Grep, not grep/rg.
- Read files: Use Read, not cat/head/tail.
- Edit files: Use Edit, not sed/awk.
- Write files: Use Write, not echo/heredocs.

Multiple commands:
- If commands are independent and can run in parallel, issue multiple bash tool calls in one message.
- ${chain}
- Use ';' only when you need sequential execution even if an earlier command fails.
- Do not use newlines to separate commands.`
}

function powershellCommandSection(name: string, chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `${powershellNotes(name)}

Before executing commands:
- If creating files or directories, first verify the parent exists with \`Test-Path -LiteralPath <parent>\`.
- Always quote file paths that contain spaces with double quotes.
- Use the \`workdir\` parameter instead of changing directories inside the command.
- If no timeout is specified, commands will time out after ${defaultTimeoutMs}ms.
- If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. Use Read with offset/limit or Grep to inspect the saved output; do not use \`Select-Object -First\`, \`Select-Object -Last\`, or similar truncation commands.

Prefer dedicated tools for file work:
- File search: Use Glob, not Get-ChildItem.
- Content search: Use Grep, not Select-String.
- Read files: Use Read, not Get-Content.
- Edit files: Use Edit, not Set-Content.
- Write files: Use Write, not Set-Content/Out-File/here-strings.

Multiple commands:
- If commands are independent and can run in parallel, issue multiple shell tool calls in one message.
- ${chain}
- Use \`;\` only when you need sequential execution even if an earlier command fails.
- Do not use newlines to separate commands.`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell notes
- Use double quotes for paths with spaces.
- Use %VAR% for environment variables.
- Use \`if exist\` for existence checks.
- Use \`call\` when invoking batch files from another batch-style command.

Before executing commands:
- If creating files or directories, first verify the parent exists with \`if exist\`.
- Always quote file paths that contain spaces with double quotes.
- Use the \`workdir\` parameter instead of changing directories inside the command.
- If no timeout is specified, commands will time out after ${defaultTimeoutMs}ms.
- If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. Use Read with offset/limit or Grep to inspect the saved output; do not use \`more\` or similar pagination commands.

Prefer dedicated tools for file work:
- File search: Use Glob, not dir /s.
- Content search: Use Grep, not findstr.
- Read files: Use Read, not type.
- Edit files: Use Edit, not copy.
- Write files: Use Write, not echo redirection.

Multiple commands:
- If commands are independent and can run in parallel, issue multiple shell tool calls in one message.
- ${chain}
- Use \`&\` only when you need sequential execution even if an earlier command fails.
- Do not use newlines to separate commands.`
}

function profile(name: string, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      parameterDescription: descriptions.cmd,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes a given ${shellDisplayName(name)} command with optional timeout, ensuring proper handling and security measures.`,
      workdirSection:
        "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID changing directories inside the command - use `workdir` instead.",
      commandSection: powershellCommandSection(name, chain, limits, defaultTimeoutMs),
      parameterDescription: descriptions.powershell,
    }
  }
  return {
    intro:
      "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.",
    workdirSection:
      "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
    parameterDescription: descriptions.bash,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      toolName: ShellID.ToolID,
    }),
    parameters: parameterSchema(selected.parameterDescription),
  }
}

export * as ShellPrompt from "./prompt"
