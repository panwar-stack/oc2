// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OC2_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt, testModelID } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

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
        })
        expect(result.exitCode).not.toBe(0)
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
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...config,
              provider: {
                test: {
                  ...config.provider.test,
                  options: { ...config.provider.test.options, chunkTimeout: 50 },
                },
              },
            }),
          },
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero when a permission request is rejected",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", {
          command: "pwd",
          description: "Inspect the working directory path",
        })
        const result = yield* opencode.run("request permission", {
          automation: true,
          agent: "build",
          variant: "high",
          env: {
            OC2_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              permission: { bash: "ask" },
            }),
          },
        })
        expect(result.exitCode).not.toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero when a tool times out",
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
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
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
        })
        opencode.expectExit(result, 1)
        expect(result.stdout).toBe("")
        expect(result.stderr).not.toContain("PRE_TOOL_SECRET")
        expect(result.stderr).not.toContain("POST_TOOL_SECRET")
        expect(result.stderr).not.toContain("unavailable_sensitive_tool")
        expect(result.stderr).not.toContain("RAW_ARGUMENT_SECRET")
      }),
    60_000,
  )

  cliIt.live(
    "automation exits nonzero without leaking MCP isError details",
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
        expect(JSON.stringify(yield* llm.inputs)).toContain("MCP_RAW_DETAIL_SECRET")
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
