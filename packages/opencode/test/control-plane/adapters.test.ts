import { expect, test } from "bun:test"
import { ProjectV2 } from "@oc2-ai/core/project"
import {
  activateAdapters,
  getAdapter,
  listAdapters,
  registerAdapter,
  releaseAdapters,
} from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"

const adapter = (name: string): WorkspaceAdapter => ({
  name,
  description: name,
  configure: (info) => info,
  create: async () => {},
  remove: async () => {},
  target: (info) => ({ type: "local", directory: info.directory ?? "/" }),
})

test("active staged adapters overlay rather than hide project adapters", () => {
  const projectID = ProjectV2.ID.make(`adapter-overlay-${crypto.randomUUID()}`)
  const owner = `owner-${crypto.randomUUID()}`
  registerAdapter(projectID, "baseline", adapter("baseline"))
  registerAdapter(projectID, "candidate", adapter("candidate"), owner)

  activateAdapters(projectID, owner)

  expect(getAdapter(projectID, "baseline").name).toBe("baseline")
  expect(getAdapter(projectID, "candidate", owner).name).toBe("candidate")
  expect(listAdapters(projectID, owner).map((item) => item.type)).toContainAllValues([
    "worktree",
    "baseline",
    "candidate",
  ])
  releaseAdapters(projectID, owner)
  expect(() => getAdapter(projectID, "candidate")).toThrow("Unknown workspace adapter")
  expect(getAdapter(projectID, "baseline").name).toBe("baseline")
})

test("simultaneous owners select their own overlay and releasing the newer preserves the older", () => {
  const projectID = ProjectV2.ID.make(`adapter-generations-${crypto.randomUUID()}`)
  const owner1 = `/worktree:1:${crypto.randomUUID()}`
  const owner2 = `/worktree:2:${crypto.randomUUID()}`
  registerAdapter(projectID, "custom", adapter("one"), owner1)
  registerAdapter(projectID, "custom", adapter("two"), owner2)

  activateAdapters(projectID, owner1)
  activateAdapters(projectID, owner2)
  expect(getAdapter(projectID, "custom", owner1).name).toBe("one")
  expect(getAdapter(projectID, "custom", owner2).name).toBe("two")

  releaseAdapters(projectID, owner2)
  expect(getAdapter(projectID, "custom", owner1).name).toBe("one")
  expect(() => getAdapter(projectID, "custom", owner2)).toThrow("Unknown workspace adapter")
  releaseAdapters(projectID, owner1)
})

test("failed candidate adapters remain invisible", () => {
  const projectID = ProjectV2.ID.make(`adapter-failure-${crypto.randomUUID()}`)
  const owner = `owner-${crypto.randomUUID()}`
  registerAdapter(projectID, "candidate", adapter("candidate"), owner)

  expect(() => getAdapter(projectID, "candidate")).toThrow("Unknown workspace adapter")
  releaseAdapters(projectID, owner)
  expect(() => getAdapter(projectID, "candidate")).toThrow("Unknown workspace adapter")
})
