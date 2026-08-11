import { describe, test, expect } from "bun:test"
import { ConfigV1 } from "@oc2-ai/core/v1/config/config"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
import { Truncate } from "@/tool/truncate"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer, FSUtil.defaultLayer))

const configuredLayer = (cfg: ConfigV1.Info) =>
  Layer.mergeAll(
    Truncate.defaultLayer,
    NodeFileSystem.layer,
    FSUtil.defaultLayer,
    TestConfig.layer({ get: () => Effect.succeed(cfg) }),
  )
const configuredIt = (cfg: ConfigV1.Info) => testEffect(configuredLayer(cfg))
const agentWithTaskPermission = (action: "allow" | "deny") => ({
  name: "test",
  mode: "primary" as const,
  permission: [{ permission: "task", pattern: "*", action }],
  options: {},
})
const truncateWithWrite = (writeFileString: FSUtil.Interface["writeFileString"]) =>
  Truncate.layer.pipe(
    Layer.provide(
      Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({ ...fs, writeFileString })
        }),
      ).pipe(Layer.provide(FSUtil.defaultLayer)),
    ),
  )

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("...90 lines truncated...")
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
      }),
    )

    it.live("truncates from head by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("...90 lines truncated...")
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("bytes truncated...")
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large single-line file truncates with byte message", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("The tool call succeeded but the output was truncated")
        expect(result.content).toContain("Grep")
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const fsys = yield* FSUtil.Service
        const written = yield* fsys.readFileString(result.outputPath)
        expect(written).toBe(lines)
      }),
    )

    it.live("suggests Task tool when agent has task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 }, agentWithTaskPermission("allow"))

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).toContain("Task tool")
      }),
    )

    it.live("omits Task tool hint when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 }, agentWithTaskPermission("deny"))

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("outputStrict", () => {
    it.live("returns the exact content without an artifact below both caller limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "first 🙂\nsecond\nthird"
        const result = yield* svc.outputStrict(content, {
          maxLines: 4,
          maxBytes: Buffer.byteLength(content, "utf-8") + 1,
        })

        expect(result).toEqual({ content, truncated: false })
        expect("outputPath" in result).toBe(false)
      }),
    )

    it.live("bounds the complete aggregate by bytes and lines and saves the exact input", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = Array.from({ length: 100 }, (_, i) => `row-${i}-${"🙂".repeat(10)}`).join("\n")
        const maxLines = 7
        const maxBytes = 480
        const result = yield* svc.outputStrict(content, { maxLines, maxBytes })

        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(maxBytes)
        expect(content.split("\n").length).toBeGreaterThan(maxLines)
        expect(result.truncated).toBe(true)
        expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(maxBytes)
        expect(result.content.split("\n").length).toBeLessThanOrEqual(maxLines)
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.content).toContain(`Full output saved to: ${result.outputPath}`)
        expect(yield* fsys.readFileString(result.outputPath)).toBe(content)
      }),
    )

    it.live("selects a deterministic Unicode-safe preview with exact omitted byte and line counts", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const bytesContent = "🙂alpha".repeat(100)
        const options = { maxLines: 20, maxBytes: 420 }
        const first = yield* svc.outputStrict(bytesContent, options)
        const second = yield* svc.outputStrict(bytesContent, options)
        if (!first.truncated || !second.truncated) throw new Error("expected truncated")

        const markerAt = first.content.indexOf("\n\n...")
        const preview = first.content.slice(0, markerAt)
        const omitted = first.content.match(/\.\.\.(\d+) bytes truncated\.\.\./)?.[1]
        expect(markerAt).toBeGreaterThanOrEqual(0)
        expect(omitted).toBeDefined()
        expect(Number(omitted)).toBe(Buffer.byteLength(bytesContent, "utf-8") - Buffer.byteLength(preview, "utf-8"))
        expect(Buffer.from(preview, "utf-8").toString("utf-8")).toBe(preview)
        expect(first.content.replace(first.outputPath, "<path>")).toBe(
          second.content.replace(second.outputPath, "<path>"),
        )

        const linesContent = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n")
        const lines = yield* svc.outputStrict(linesContent, { maxLines: 7, maxBytes: 2_000 })
        if (!lines.truncated) throw new Error("expected truncated")
        const linesMarkerAt = lines.content.indexOf("\n\n...")
        const linesPreview = lines.content.slice(0, linesMarkerAt)
        const omittedLines = lines.content.match(/\.\.\.(\d+) lines truncated\.\.\./)?.[1]
        const previewEnd = linesPreview.length
        const completedLines =
          previewEnd === 0
            ? 0
            : linesPreview.split("\n").length -
              1 +
              (previewEnd === linesContent.length || linesContent[previewEnd] === "\n" ? 1 : 0)
        expect(Number(omittedLines)).toBe(linesContent.split("\n").length - completedLines)
      }),
    )

    it.live("keeps the exact permitted and denied task guidance within the caller limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "result-" + "x".repeat(2_000)
        const limits = { maxLines: 20, maxBytes: 600 }
        const permitted = yield* svc.outputStrict(content, limits, agentWithTaskPermission("allow"))
        const denied = yield* svc.outputStrict(content, limits, agentWithTaskPermission("deny"))

        expect(permitted.content).toContain(
          "Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.",
        )
        expect(denied.content).toContain(
          "Use Grep to search the full content or Read with offset/limit to view specific sections.",
        )
        expect(denied.content).not.toContain("Task tool")
        expect(Buffer.byteLength(permitted.content, "utf-8")).toBeLessThanOrEqual(limits.maxBytes)
        expect(Buffer.byteLength(denied.content, "utf-8")).toBeLessThanOrEqual(limits.maxBytes)
        expect(permitted.content.split("\n").length).toBeLessThanOrEqual(limits.maxLines)
        expect(denied.content.split("\n").length).toBeLessThanOrEqual(limits.maxLines)
      }),
    )

    const impossibleFooterIt = testEffect(truncateWithWrite(() => Effect.void))
    impossibleFooterIt.live("fails explicitly when the mandatory empty-preview footer cannot fit", () =>
      Effect.gen(function* () {
        const failed = yield* (yield* Truncate.Service)
          .outputStrict("large output", { maxLines: 1, maxBytes: 10 })
          .pipe(Effect.exit)

        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed)) expect(Cause.pretty(failed.cause)).toContain("Strict truncation footer exceeds")
      }),
    )

    const writeFailureIt = testEffect(
      truncateWithWrite(() => Effect.die(new Error("simulated strict output write failure"))),
    )
    writeFailureIt.live("fails without rendering when exact artifact storage fails", () =>
      Effect.gen(function* () {
        const failed = yield* (yield* Truncate.Service)
          .outputStrict("x".repeat(500), { maxLines: 20, maxBytes: 400 })
          .pipe(Effect.exit)

        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed)) {
          expect(Cause.pretty(failed.cause)).toContain("simulated strict output write failure")
        }
      }),
    )
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
