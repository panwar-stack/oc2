import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Log from "@opencode-ai/core/util/log"
import * as Bom from "../util/bom"
import { parsePatch } from "./parser"
import type { AffectedPaths, Hunk, UpdateFileChunk } from "."

const log = Log.create({ service: "patch" })

interface ApplyPatchFileUpdate {
  unified_diff: string
  content: string
  bom: boolean
}

export function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
  originalText: string,
): ApplyPatchFileUpdate {
  const originalContent = Bom.split(originalText)

  let originalLines = originalContent.text.split("\n")

  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop()
  }

  const replacements = computeReplacements(originalLines, filePath, chunks)
  let newLines = applyReplacements(originalLines, replacements)

  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("")
  }

  const next = Bom.split(newLines.join("\n"))
  const newContent = next.text
  const unifiedDiff = generateUnifiedDiff(originalContent.text, newContent)

  return {
    unified_diff: unifiedDiff,
    content: newContent,
    bom: originalContent.bom || next.bom,
  }
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex)
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`)
      }
      lineIndex = contextIdx + 1
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length
      replacements.push([insertionIdx, 0, chunk.new_lines])
      continue
    }

    let pattern = chunk.old_lines
    let newSlice = chunk.new_lines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1)
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice])
      lineIndex = found + pattern.length
    } else {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`)
    }
  }

  replacements.sort((a, b) => a[0] - b[0])

  return replacements
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines]

  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]
    result.splice(startIdx, oldLen)
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j])
    }
  }

  return result
}

function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
}

type Comparator = (a: string, b: string) => boolean

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= startIndex) {
      let matches = true
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false
          break
        }
      }
      if (matches) return fromEnd
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false
        break
      }
    }
    if (matches) return i
  }

  return -1
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof)
  if (exact !== -1) return exact

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof)
  if (rstrip !== -1) return rstrip

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof)
  if (trim !== -1) return trim

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  )
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  let diff = "@@ -1 +1 @@\n"
  const maxLen = Math.max(oldLines.length, newLines.length)
  let hasChanges = false

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] || ""
    const newLine = newLines[i] || ""

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`
      if (newLine) diff += `+${newLine}\n`
      hasChanges = true
    } else if (oldLine) {
      diff += ` ${oldLine}\n`
    }
  }

  return hasChanges ? diff : ""
}

export const applyHunksToFiles = Effect.fn("Patch.applyHunksToFiles")(function* (hunks: Hunk[]) {
  if (hunks.length === 0) {
    return yield* Effect.fail(new Error("No files were modified."))
  }

  const fs = yield* FSUtil.Service

  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const hunk of hunks) {
    switch (hunk.type) {
      case "add": {
        yield* fs.writeWithDirs(hunk.path, hunk.contents)
        added.push(hunk.path)
        log.info(`Added file: ${hunk.path}`)
        break
      }

      case "delete": {
        yield* fs.remove(hunk.path)
        deleted.push(hunk.path)
        log.info(`Deleted file: ${hunk.path}`)
        break
      }

      case "update": {
        const originalText = yield* fs.readFileString(hunk.path)
        const fileUpdate = deriveNewContentsFromChunks(hunk.path, hunk.chunks, originalText)

        if (hunk.move_path) {
          yield* fs.writeWithDirs(hunk.move_path, Bom.join(fileUpdate.content, fileUpdate.bom))
          yield* fs.remove(hunk.path)
          modified.push(hunk.move_path)
          log.info(`Moved file: ${hunk.path} -> ${hunk.move_path}`)
        } else {
          yield* fs.writeWithDirs(hunk.path, Bom.join(fileUpdate.content, fileUpdate.bom))
          modified.push(hunk.path)
          log.info(`Updated file: ${hunk.path}`)
        }
        break
      }
    }
  }

  return { added, modified, deleted } satisfies AffectedPaths
})

export const applyPatch = Effect.fn("Patch.applyPatch")(function* (patchText: string) {
  const { hunks } = parsePatch(patchText)
  return yield* applyHunksToFiles(hunks)
})
