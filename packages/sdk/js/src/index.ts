export * from "./client.js"
export * from "./server.js"

import { createOc2Client } from "./client.js"
import { createOc2Server } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createOc2(options?: ServerOptions) {
  const server = await createOc2Server({
    ...options,
  })

  const client = createOc2Client({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

export const createOpencode = createOc2
