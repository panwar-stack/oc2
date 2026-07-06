export * from "./gen/types.gen.js"
export type {
  FileSystemBinaryContent as LocationFileSystemBinaryContent,
  FileSystemEntry as LocationFileSystemEntry,
  FileSystemTextContent as LocationFileSystemTextContent,
} from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { Oc2Client } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { Oc2Client, Oc2Client as OpencodeClient, type Config as Oc2ClientConfig, type Config as OpencodeClientConfig }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    [["x-oc2-directory", "x-opencode-directory"], "directory"],
    [["x-oc2-workspace", "x-opencode-workspace"], "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name[0]) ?? request.headers.get(name[1]),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-oc2-directory")
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-oc2-workspace")
  next.headers.delete("x-opencode-workspace")
  return next
}

export function createOc2Client(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-oc2-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-oc2-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of oc2 Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new Oc2Client({ client })
}

export const createOpencodeClient = createOc2Client
