import { getFilename } from "@opencode-ai/core/util/path"
import { pathKey } from "@/utils/path-key"

type WorkspaceNamingStore = {
  workspaceName: Record<string, string>
  workspaceBranchName: Record<string, Record<string, string>>
}

type SetWorkspaceNamingStore = {
  (property: "workspaceName", key: string, value: string): void
  (property: "workspaceBranchName", projectId: string, value: Record<string, string>): void
  (property: "workspaceBranchName", projectId: string, branch: string, value: string): void
}

export function createWorkspaceNaming(store: WorkspaceNamingStore, setStore: SetWorkspaceNamingStore) {
  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  return { workspaceName, setWorkspaceName, workspaceLabel }
}
