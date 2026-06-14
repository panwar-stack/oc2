import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { WorkspaceRoot } from "../../src/persistence/repositories/sessions"

export const createTempWorkspace = async () => {
  const path = await mkdtemp(join(tmpdir(), "oc2-tools-"))
  const root: WorkspaceRoot = { id: "root", path, readonly: false }
  return {
    path,
    root,
    cleanup: () => rm(path, { recursive: true, force: true }),
  }
}
