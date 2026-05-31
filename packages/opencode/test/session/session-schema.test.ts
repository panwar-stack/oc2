import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Supervisor } from "../../src/supervisor/supervisor"

const info = {
  id: SessionID.descending(),
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  workspaceID: undefined,
  directory: "/tmp/opencode",
  parentID: undefined,
  summary: undefined,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  share: undefined,
  title: "Test session",
  version: "1.0.0",
  time: {
    created: 1,
    updated: 2,
    compacting: undefined,
    archived: undefined,
    processing: 0,
  },
  permission: undefined,
  revert: undefined,
} satisfies Session.Info

describe("Session schema", () => {
  test("encodes undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)(info) as Record<string, unknown>

    for (const key of ["workspaceID", "parentID", "summary", "share", "permission", "revert", "supervisor"]) {
      expect(Object.hasOwn(encoded, key)).toBe(false)
    }
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "compacting")).toBe(false)
    expect(Object.hasOwn(encoded.time as Record<string, unknown>, "archived")).toBe(false)
    expect((encoded.time as Record<string, unknown>).processing).toBe(0)
    expect(JSON.stringify(encoded)).not.toContain("parentID")
  })

  test("encodes undefined optional global session project fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.GlobalInfo)({
      ...info,
      project: {
        id: ProjectV2.ID.global,
        name: undefined,
        worktree: "/tmp/opencode",
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded, "parentID")).toBe(false)
    expect(Object.hasOwn(encoded.project as Record<string, unknown>, "name")).toBe(false)
  })

  test("encodes nested undefined optional session fields as omitted keys", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...info,
      summary: {
        additions: 1,
        deletions: 2,
        files: 3,
        diffs: undefined,
      },
      revert: {
        messageID: MessageID.ascending(),
        partID: undefined,
        snapshot: undefined,
        diff: undefined,
      },
    }) as Record<string, unknown>

    expect(Object.hasOwn(encoded.summary as Record<string, unknown>, "diffs")).toBe(false)
    for (const key of ["partID", "snapshot", "diff"]) {
      expect(Object.hasOwn(encoded.revert as Record<string, unknown>, key)).toBe(false)
    }
  })

  test("encodes supervisor session settings", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...info,
      supervisor: {
        mode: "advise",
        recommendation_model: "anthropic/claude-sonnet-4",
        insert_recommendations: false,
        updatedAt: 10,
      },
    }) as Record<string, unknown>

    expect(encoded.supervisor).toEqual({
      mode: "advise",
      recommendation_model: "anthropic/claude-sonnet-4",
      insert_recommendations: false,
      updatedAt: 10,
    })
  })

  test("resolves supervisor settings with session precedence and model fallback", () => {
    expect(
      Supervisor.resolveEffectiveConfig({
        config: { model: "test/default", supervisor: { mode: "observe", broad_diff_file_limit: 7 } },
        session: { mode: "advise", max_recommendation_chars: 400, updatedAt: 20 },
      }),
    ).toMatchObject({
      mode: "advise",
      recommendation_model: "test/default",
      broad_diff_file_limit: 7,
      max_recommendation_chars: 400,
      insert_recommendations: true,
    })
  })

  test("session supervisor migration adds nullable json column", () => {
    expect(
      readFileSync(
        new URL("../../migration/20260531203016_session_supervisor_settings/migration.sql", import.meta.url),
        "utf-8",
      ).trim(),
    ).toBe("ALTER TABLE `session` ADD `supervisor` text;")
  })
})
