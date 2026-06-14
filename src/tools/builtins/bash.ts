import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { numberProperty, objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
})

export const createBashTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "bash",
  description: "Run a bash command in a writable workspace root. Docker sandboxing is not enabled.",
  inputSchema,
  modelInputSchema: objectSchema({ command: stringProperty("Command to execute"), cwd: stringProperty("Working directory"), timeoutMs: numberProperty("Command timeout in milliseconds") }, ["command"]),
  permission: { action: "execute", resource: (input) => input.command },
  async execute(input, context) {
    const cwd = await resolveWorkspacePath(input.cwd ?? ".", context.workspaceRoots, { cwd: context.cwd, writable: true, mustExist: true })
    const proc = Bun.spawn(["bash", "-lc", input.command], { cwd: cwd.path, stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timeout = input.timeoutMs ? setTimeout(() => {
      timedOut = true
      proc.kill()
    }, input.timeoutMs) : undefined
    const onAbort = () => proc.kill()
    context.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      if (context.signal.aborted) throw new ToolExecutionError({ code: "cancelled", message: "Tool was cancelled" })
      if (timedOut) throw new ToolExecutionError({ code: "timed_out", message: `Command timed out after ${input.timeoutMs}ms`, details: { command: input.command, exitCode } })
      return { command: input.command, cwd: cwd.path, exitCode, stdout, stderr }
    } finally {
      if (timeout) clearTimeout(timeout)
      context.signal.removeEventListener("abort", onAbort)
    }
  },
})
