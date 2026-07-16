// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OC2_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cliIt, testModelID } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

type AutomationResult =
  | { status: "ok"; sessionID: string; text: string }
  | {
      status: "error"
      sessionID: string | null
      error:
        | "invalid_input"
        | "invalid_agent"
        | "invalid_model"
        | "invalid_variant"
        | "invalid_command"
        | "permission_denied"
        | "tool_error"
        | "provider_error"
        | "session_error"
        | "cancelled"
        | "timeout"
    }

function automationResult(stdout: string) {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]) as AutomationResult
}

const git = Effect.fn("RunProcessTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
  })
})

describe("opencode run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  cliIt.live(
    "automation exits 0 only after an explicitly selected identity succeeds",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("automation completed")
        const result = yield* opencode.run("do the work", {
          automation: true,
          agent: "build",
          variant: "high",
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("automation completed")
      }),
    60_000,
  )

  cliIt.live(
    "automation avoids project bootstrap and instruction side effects",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const marker = path.join(home, "plugin-initialized")
        const mcpMarker = path.join(home, "mcp-initialized")
        const lspMarker = path.join(home, "lsp-initialized")
        const formatterMarker = path.join(home, "formatter-initialized")
        const plugin = path.join(home, "plugin.ts")
        const localInstruction = path.join(home, "hostile-instruction.md")
        const instructionHits = { value: 0 }
        const instructionServer = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch() {
                instructionHits.value++
                return new Response("REMOTE_INSTRUCTION_SECRET")
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(home, "AGENTS.md"), "PROJECT_INSTRUCTION_SECRET"),
            Bun.write(localInstruction, "LOCAL_INSTRUCTION_SECRET"),
            Bun.write(
              plugin,
              [
                "export default async () => {",
                `  await Bun.write(${JSON.stringify(marker)}, "initialized")`,
                "  return {}",
                "}",
                "",
              ].join("\n"),
            ),
          ]),
        )
        const source = path.join(home, "reference-source")
        const remoteRoot = path.join(home, "reference-remotes")
        const remoteDir = path.join(remoteRoot, "issue-safe-reference")
        yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "reference"))
        yield* git(source, ["init"])
        yield* git(source, ["add", "."])
        yield* git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"])
        yield* Effect.promise(() => fs.mkdir(remoteDir, { recursive: true }))
        yield* git(remoteRoot, ["clone", "--bare", source, path.join(remoteDir, "repo.git")])

        const target = path.join(home, "safe.repro")
        yield* Effect.promise(() => Bun.write(target, "before"))
        const env = {
          OC2_PURE: "false",
          OC2_EXPERIMENTAL_REFERENCES: "true",
          OC2_REPO_CLONE_GITHUB_BASE_URL: `file://${remoteRoot}/`,
          OC2_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            plugin: [pathToFileURL(plugin).href],
            instructions: [localInstruction, instructionServer.url.toString()],
            reference: { docs: "issue-safe-reference/repo" },
            mcp: {
              unsafe: {
                type: "local",
                command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(mcpMarker)}, "initialized")`],
              },
            },
            lsp: {
              unsafe: {
                command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(lspMarker)}, "initialized")`],
                extensions: [".repro"],
              },
            },
            formatter: {
              unsafe: {
                command: [
                  process.execPath,
                  "-e",
                  `await Bun.write(${JSON.stringify(formatterMarker)}, "initialized")`,
                  "$FILE",
                ],
                extensions: [".repro"],
              },
            },
          }),
        }

        yield* llm.tool("read", { filePath: target })
        yield* llm.tool("edit", { filePath: target, oldString: "before", newString: "after" })
        yield* llm.text("safe automation completed")
        const result = yield* opencode.run("do safe work", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          env,
        })

        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(mcpMarker).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(lspMarker).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(formatterMarker).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("after")
        expect(instructionHits.value).toBe(0)
        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).not.toContain("PROJECT_INSTRUCTION_SECRET")
        expect(inputs).not.toContain("LOCAL_INSTRUCTION_SECRET")
        expect(inputs).not.toContain("REMOTE_INSTRUCTION_SECRET")
        expect(
          yield* Effect.promise(() =>
            Bun.file(
              path.join(home, ".local", "share", "oc2", "repos", "github.com", "issue-safe-reference", "repo"),
            ).exists(),
          ),
        ).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "result-json emits exactly one terminal-safe success object",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const text =
          "safe result \u001b]8;;https://attacker.invalid\u0007link\u001b]8;;\u0007 \u009b31m " + "x".repeat(900_000)
        yield* llm.push(reply().reason("REASONING_SECRET").text(text).stop())
        const result = yield* opencode.run("return a hostile-looking result", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          printLogs: true,
        })

        opencode.expectExit(result, 0)
        expect(result.stderr).toBe("")
        expect(result.stdout).not.toContain("\u001b")
        expect(result.stdout).not.toContain("\u009b")
        const parsed = automationResult(result.stdout)
        expect(parsed).toMatchObject({ status: "ok", sessionID: expect.any(String) })
        expect(parsed.status === "ok" && parsed.text === text).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "result-json reports invalid invocation with exit 2 and no UI output",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "run",
          "--automation",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
          "hello",
        ])

        opencode.expectExit(result, 2)
        expect(result.stderr).toBe("")
        expect(automationResult(result.stdout)).toEqual({
          status: "error",
          sessionID: null,
          error: "invalid_agent",
        })

        const hostile = "\u001b]8;;https://attacker.invalid\u0007HOSTILE_ARGUMENT\u001b]8;;\u0007"
        const parserFailure = yield* opencode.spawn([
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
          "--unknown-option",
          hostile,
        ])
        opencode.expectExit(parserFailure, 2)
        expect(parserFailure.stderr).toBe("")
        expect(parserFailure.stdout).not.toContain("\u001b")
        expect(parserFailure.stdout).not.toContain("HOSTILE_ARGUMENT")
        expect(automationResult(parserFailure.stdout)).toEqual({
          status: "error",
          sessionID: null,
          error: "invalid_input",
        })

        const base = [
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
        ]
        const help = yield* opencode.spawn([...base, "--help"])
        const helpValue = yield* opencode.spawn([...base, "--help=true"])
        const shortHelpValue = yield* opencode.spawn([...base, "-h=true"])
        const version = yield* opencode.spawn([...base, "--version"])
        const versionValue = yield* opencode.spawn([...base, "--version=true"])
        const shortVersionValue = yield* opencode.spawn([...base, "-v=true"])
        const shortCluster = yield* opencode.spawn([...base, "-hv"])
        const completion = yield* opencode.spawn([...base, "--get-yargs-completions=true"])
        const duplicate = yield* opencode.spawn([...base, "--format", "result-json", "hello"])
        const conflicting = yield* opencode.spawn([...base, "--format=json", "hello"])
        for (const invalid of [
          help,
          helpValue,
          shortHelpValue,
          version,
          versionValue,
          shortVersionValue,
          shortCluster,
          completion,
          duplicate,
          conflicting,
        ]) {
          opencode.expectExit(invalid, 2)
          expect(invalid.stderr).toBe("")
          expect(automationResult(invalid.stdout)).toEqual({
            status: "error",
            sessionID: null,
            error: "invalid_input",
          })
        }
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "result-json rejects requested sessions as invalid automation input",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("continue missing session", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          extraArgs: ["--session", "ses_missing"],
        })

        opencode.expectExit(result, 2)
        expect(result.stderr).toBe("")
        expect(automationResult(result.stdout)).toEqual({
          status: "error",
          sessionID: null,
          error: "invalid_input",
        })
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation rejects empty session and attach values before bootstrap",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const marker = path.join(home, "empty-option-bootstrap")
        const plugin = path.join(home, "empty-option-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            plugin,
            `export default async () => { await Bun.write(${JSON.stringify(marker)}, "initialized"); return {} }`,
          ),
        )
        const base = [
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
          "do work",
        ]
        const env = {
          OC2_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            plugin: [pathToFileURL(plugin).href],
          }),
        }

        for (const option of ["--session=", "--attach="]) {
          const result = yield* opencode.spawn([...base, option], { env })
          opencode.expectExit(result, 2)
          expect(result.stderr).toBe("")
          expect(automationResult(result.stdout)).toEqual({
            status: "error",
            sessionID: null,
            error: "invalid_input",
          })
        }
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation sanitizes promise defects in plain and result-json formats",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const secret = "PROMISE_DEFECT_SECRET"
        const socketPath = path.join(home, `${secret}.sock`)
        yield* Effect.acquireRelease(
          Effect.sync(() => Bun.listen({ unix: socketPath, socket: { data() {} } })),
          (server) => Effect.sync(() => server.stop(true)),
        )

        const plain = yield* opencode.run("read the socket", {
          automation: true,
          agent: "build",
          variant: "high",
          file: [socketPath],
        })
        opencode.expectExit(plain, 1)
        expect(plain.stdout).toBe("")
        expect(plain.stderr).toContain("Automation run failed")
        expect(plain.stderr).not.toContain(secret)
        expect(plain.stderr).not.toContain("EOPNOTSUPP")

        const resultJson = yield* opencode.run("read the socket", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          file: [socketPath],
        })
        opencode.expectExit(resultJson, 1)
        expect(resultJson.stderr).toBe("")
        expect(resultJson.stdout).not.toContain(secret)
        expect(automationResult(resultJson.stdout)).toEqual({
          status: "error",
          sessionID: null,
          error: "session_error",
        })
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation rejects session continuation, forking, and unsafe attach before execution",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const base = [
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
          "do work",
        ]
        for (const flags of [
          ["--session", "ses_existing"],
          ["--continue"],
          ["--fork"],
          ["--attach", "http://127.0.0.1:1"],
        ]) {
          const result = yield* opencode.spawn([...base, ...flags])
          opencode.expectExit(result, 2)
          expect(result.stderr).toBe("")
          expect(automationResult(result.stdout)).toEqual({
            status: "error",
            sessionID: null,
            error: "invalid_input",
          })
        }
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation rejects session reuse before project bootstrap",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const marker = path.join(home, "rejected-automation-bootstrap")
        const plugin = path.join(home, "rejected-automation-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            plugin,
            `export default async () => { await Bun.write(${JSON.stringify(marker)}, "initialized"); return {} }`,
          ),
        )
        const base = [
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "--format",
          "result-json",
          "do work",
        ]
        const env = {
          OC2_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            plugin: [pathToFileURL(plugin).href],
          }),
        }

        for (const flags of [["--session", "ses_existing"], ["--continue"], ["--fork"]]) {
          const result = yield* opencode.spawn([...base, ...flags], { env })
          opencode.expectExit(result, 2)
          expect(result.stderr).toBe("")
          expect(automationResult(result.stdout)).toEqual({
            status: "error",
            sessionID: null,
            error: "invalid_input",
          })
        }
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "plain automation redacts unexpected bootstrap errors",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const secret = "CONFIG_BOOTSTRAP_SECRET"
        const result = yield* opencode.spawn([
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "--variant",
          "high",
          "hello",
        ], {
          env: { OC2_CONFIG_CONTENT: `{${secret}` },
        })

        opencode.expectExit(result, 2)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("Invalid automation invocation")
        expect(result.stderr).not.toContain(secret)
        expect(result.stderr).not.toContain("SyntaxError")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "completion rejects result-json before emitting its script",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const positional = yield* opencode.spawn(["completion", "--automation", "--format", "result-json"])
        const shell = yield* opencode.spawn(["completion", "bash", "--automation", "--format=result-json"])

        for (const invalid of [positional, shell]) {
          opencode.expectExit(invalid, 2)
          expect(invalid.stderr).toBe("")
          expect(automationResult(invalid.stdout)).toEqual({
            status: "error",
            sessionID: null,
            error: "invalid_input",
          })
          expect(invalid.stdout).not.toContain("yargs command completion script")
        }

        const ordinary = yield* opencode.spawn(["completion"])
        opencode.expectExit(ordinary, 0)
        expect(ordinary.stderr).toBe("")
        expect(ordinary.stdout).toContain("###-begin-oc2-completions-###")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation treats hostile command arguments literally without ambient file inclusion",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const secret = path.join(home, "ambient-secret.txt")
        const marker = path.join(home, "shell-expansion-marker")
        yield* Effect.promise(() => Bun.write(secret, "AMBIENT_FILE_SECRET"))
        yield* llm.text("hostile arguments stayed literal")

        const literalReplacementPatterns = "literal-$&-$'-$`"
        const result = yield* opencode.run(`!\`touch ${marker}\` @ambient-secret.txt ${literalReplacementPatterns}`, {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          command: "hostile-arguments",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              command: { "hostile-arguments": { template: "$ARGUMENTS" } },
            }),
          },
        })

        opencode.expectExit(result, 0)
        expect(automationResult(result.stdout)).toMatchObject({
          status: "ok",
          text: "hostile arguments stayed literal",
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain("@ambient-secret.txt")
        expect(input).toContain(literalReplacementPatterns)
        expect(input).not.toContain("AMBIENT_FILE_SECRET")
      }),
    60_000,
  )

  cliIt.live(
    "explicit file parts reach ordinary and configured-command runs",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const attachment = path.join(home, "context.txt")
        yield* Effect.promise(() => Bun.write(attachment, "EXPLICIT_ATTACHMENT_CONTEXT"))

        yield* llm.text("ordinary attachment accepted")
        const ordinary = yield* opencode.run("inspect the explicit attachment", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          file: [attachment],
        })
        opencode.expectExit(ordinary, 0)

        yield* llm.text("command attachment accepted")
        const command = yield* opencode.run("inspect the explicit attachment", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          command: "attachment-test",
          file: [attachment],
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              command: { "attachment-test": { template: "$ARGUMENTS" } },
            }),
          },
        })
        opencode.expectExit(command, 0)

        expect(automationResult(ordinary.stdout)).toMatchObject({ status: "ok", text: "ordinary attachment accepted" })
        expect(automationResult(command.stdout)).toMatchObject({ status: "ok", text: "command attachment accepted" })
        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs.match(/EXPLICIT_ATTACHMENT_CONTEXT/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      }),
    60_000,
  )

  cliIt.live(
    "explicit file MIME is sniffed from bytes instead of the filename",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const fakePng = path.join(home, "plain-text.png")
        const fakePdf = path.join(home, "plain-text.pdf")
        const realPng = path.join(home, "pixel.bin")
        yield* Effect.promise(() => Bun.write(fakePng, "PLAIN_TEXT_NAMED_PNG"))
        yield* Effect.promise(() => Bun.write(fakePdf, "PLAIN_TEXT_NAMED_PDF"))
        yield* Effect.promise(() =>
          Bun.write(
            realPng,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
        )
        const config = testProviderConfig(llm.url)
        const trustedConfig = {
          ...config,
          provider: {
            ...config.provider,
            test: {
              ...config.provider.test,
              models: {
                ...config.provider.test.models,
                "test-model": {
                  ...config.provider.test.models["test-model"],
                  attachment: true,
                  modalities: { input: ["text", "image"], output: ["text"] },
                },
              },
            },
          },
        }

        for (const file of [fakePng, fakePdf, realPng]) {
          yield* llm.text("attachment accepted")
          const result = yield* opencode.run("inspect the attachment", {
            automation: true,
            agent: "build",
            variant: "high",
            format: "result-json",
            file: [file],
            trustedConfig,
          })
          opencode.expectExit(result, 0)
        }

        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).toContain("PLAIN_TEXT_NAMED_PNG")
        expect(inputs).toContain("PLAIN_TEXT_NAMED_PDF")
        expect(inputs).toContain('"image_url"')
      }),
    60_000,
  )

  cliIt.live(
    "automation requires explicit agent, model, and variant flags",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const missingAgent = yield* opencode.spawn([
          "run",
          "--automation",
          "--model",
          testModelID,
          "--variant",
          "high",
          "hello",
        ])
        const missingModel = yield* opencode.spawn([
          "run",
          "--automation",
          "--agent",
          "build",
          "--variant",
          "high",
          "hello",
        ])
        const missingVariant = yield* opencode.spawn([
          "run",
          "--automation",
          "--agent",
          "build",
          "--model",
          testModelID,
          "hello",
        ])

        expect(missingAgent.exitCode).not.toBe(0)
        expect(missingAgent.stderr).toContain("--automation requires --agent")
        expect(missingModel.exitCode).not.toBe(0)
        expect(missingModel.stderr).toContain("--automation requires --model")
        expect(missingVariant.exitCode).not.toBe(0)
        expect(missingVariant.stderr).toContain("--automation requires --variant")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation rejects missing, disabled, subagent, and inexact agents without fallback",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const unknown = yield* opencode.run("hello", {
          automation: true,
          agent: "missing",
          variant: "high",
        })
        const subagent = yield* opencode.run("hello", {
          automation: true,
          agent: "general",
          variant: "high",
        })
        const disabled = yield* opencode.run("hello", {
          automation: true,
          agent: "disabled",
          variant: "high",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: { disabled: { disable: true } },
            }),
          },
        })
        const renamed = yield* opencode.run("hello", {
          automation: true,
          agent: "renamed-key",
          variant: "high",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: { "renamed-key": { name: "different-name", mode: "primary" } },
            }),
          },
        })

        expect(unknown.exitCode).not.toBe(0)
        expect(subagent.exitCode).not.toBe(0)
        expect(disabled.exitCode).not.toBe(0)
        expect(renamed.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(0)
      }),
    90_000,
  )

  cliIt.live(
    "automation rejects unknown models, variants, and commands before execution",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const model = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          model: "test/missing",
          variant: "high",
        })
        const variant = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          variant: "missing",
        })
        const command = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          variant: "high",
          command: "missing",
        })

        expect(model.exitCode).not.toBe(0)
        expect(variant.exitCode).not.toBe(0)
        expect(command.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "explicit automation identity overrides configured command agent and model",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("explicit identity won")
        const result = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          variant: "high",
          command: "automation-test",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              command: {
                "automation-test": {
                  template: "$ARGUMENTS",
                  agent: "missing-agent",
                  model: "test/missing-model",
                },
              },
            }),
          },
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("explicit identity won")
      }),
    60_000,
  )

  cliIt.live(
    "configured command identity remains authoritative outside automation",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("hello", {
          agent: "build",
          command: "command-identity-test",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              command: {
                "command-identity-test": {
                  template: "$ARGUMENTS",
                  agent: "missing-agent",
                  model: "test/missing-model",
                },
              },
            }),
          },
        })

        expect(result.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation rejects permission bypass and raw event output combinations",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const skipped = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          variant: "high",
          extraArgs: ["--dangerously-skip-permissions"],
        })
        const raw = yield* opencode.run("hello", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "json",
        })

        expect(skipped.exitCode).not.toBe(0)
        expect(raw.exitCode).not.toBe(0)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // Locks in the current behavior: when the LLM stream errors mid-response
  // (the prompt was accepted, then the upstream provider failed), opencode
  // emits a session.error event and the process exits 0 today.
  //
  // This is debatable — a future cleanup might flip it to exit 1. If you're
  // changing this expectation, do it deliberately and say so in the PR.
  cliIt.concurrent(
    "mid-stream LLM error still exits 0 today (contract lock-in)",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* opencode.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero on a mid-stream provider failure",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("PARTIAL_SECRET").streamError("upstream provider exploded mid-stream"))
        const result = yield* opencode.run("trigger midstream error", {
          automation: true,
          agent: "build",
          variant: "high",
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero on a provider request failure",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(400, { error: { message: "provider rejected request" } })
        const result = yield* opencode.run("trigger provider error", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
        })
        opencode.expectExit(result, 1)
        expect(result.stderr).toBe("")
        expect(automationResult(result.stdout)).toMatchObject({ status: "error", error: "provider_error" })
      }),
    60_000,
  )

  cliIt.live(
    "automation remains nonzero when an HTTP provider retry recovers",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(500, { error: { message: "temporary provider failure" } })
        yield* llm.text("RECOVERED_SECRET")
        const result = yield* opencode.run("retry provider request", {
          automation: true,
          agent: "build",
          variant: "high",
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
      }),
    60_000,
  )

  cliIt.live(
    "automation remains nonzero when a stream timeout retry recovers",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("PARTIAL_SECRET").hang())
        yield* llm.text("RECOVERED_SECRET")
        const config = testProviderConfig(llm.url)
        const result = yield* opencode.run("retry stalled stream", {
          automation: true,
          agent: "build",
          variant: "high",
          trustedConfig: {
            ...config,
            provider: {
              test: {
                ...config.provider.test,
                options: { ...config.provider.test.options, chunkTimeout: 50 },
              },
            },
          },
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
      }),
    60_000,
  )

  cliIt.live(
    "automation classifies a rejected edit permission",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const target = path.join(home, "permission-target.txt")
        yield* Effect.promise(() => Bun.write(target, "before"))
        yield* llm.tool("edit", { filePath: target, oldString: "before", newString: "after" })
        yield* llm.text("POST_PERMISSION_SECRET")
        const result = yield* opencode.run("request permission", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              permission: { edit: "ask" },
            }),
          },
        })
        opencode.expectExit(result, 1)
        expect(automationResult(result.stdout)).toMatchObject({ status: "error", error: "permission_denied" })
        expect(result.stdout).not.toContain("POST_PERMISSION_SECRET")
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("before")
      }),
    60_000,
  )

  cliIt.live(
    "automation classifies unavailable bash as a tool error",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("PRE_TOOL_PROGRESS").tool("bash", {
            command: "sleep 1",
            timeout: 10,
            description: "Wait beyond the configured tool timeout",
          }),
        )
        yield* llm.text("continued after tool failure")
        const result = yield* opencode.run("trigger tool timeout", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
        })
        opencode.expectExit(result, 1)
        expect(automationResult(result.stdout)).toMatchObject({ status: "error", error: "tool_error" })
        expect(result.stdout).not.toContain("PRE_TOOL_PROGRESS")
        expect(result.stdout).not.toContain("continued after tool failure")
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero without leaking unavailable tool details",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("PRE_TOOL_SECRET").tool("unavailable_sensitive_tool", {
            detail: "RAW_ARGUMENT_SECRET",
          }),
        )
        yield* llm.text("POST_TOOL_SECRET")
        const result = yield* opencode.run("call an unavailable tool", {
          automation: true,
          agent: "build",
          variant: "high",
          format: "result-json",
        })
        opencode.expectExit(result, 1)
        expect(automationResult(result.stdout)).toMatchObject({ status: "error", error: "tool_error" })
        expect(result.stdout).not.toContain("PRE_TOOL_SECRET")
        expect(result.stdout).not.toContain("POST_TOOL_SECRET")
        expect(result.stdout).not.toContain("unavailable_sensitive_tool")
        expect(result.stdout).not.toContain("RAW_ARGUMENT_SECRET")
        expect(result.stderr).not.toContain("PRE_TOOL_SECRET")
        expect(result.stderr).not.toContain("POST_TOOL_SECRET")
        expect(result.stderr).not.toContain("unavailable_sensitive_tool")
        expect(result.stderr).not.toContain("RAW_ARGUMENT_SECRET")
      }),
    60_000,
  )

  cliIt.live(
    "automation does not initialize configured MCP tools or leak details",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("PRE_MCP_SECRET").tool("error_test_fail", {
            detail: "MCP_ARGUMENT_SECRET",
          }),
        )
        yield* llm.text("POST_MCP_SECRET")
        const config = testProviderConfig(llm.url)
        const result = yield* opencode.run("call an MCP tool that reports failure", {
          automation: true,
          agent: "build",
          variant: "high",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...config,
              mcp: {
                error_test: {
                  type: "local",
                  command: ["bun", path.join(import.meta.dir, "../../fixture/mcp-error-server.ts")],
                },
              },
              permission: { error_test_fail: "allow" },
            }),
          },
        })

        opencode.expectExit(result, 1)
        expect(JSON.stringify(yield* llm.inputs)).not.toContain("MCP_RAW_DETAIL_SECRET")
        expect(result.stdout).toBe("")
        expect(result.stderr).not.toContain("PRE_MCP_SECRET")
        expect(result.stderr).not.toContain("POST_MCP_SECRET")
        expect(result.stderr).not.toContain("MCP_ARGUMENT_SECRET")
        expect(result.stderr).not.toContain("MCP_RAW_DETAIL_SECRET")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )
})
