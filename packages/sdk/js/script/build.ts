#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "Oc2Client",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

for (const sdkPath of ["./src/gen/sdk.gen.ts", "./src/v2/gen/sdk.gen.ts"]) {
  const sdkFile = Bun.file(sdkPath)
  const sdkSource = await sdkFile.text()
  const canonical = sdkSource.replace("export class OpencodeClient", "export class Oc2Client")
  const alias = "export { Oc2Client as OpencodeClient }"
  const patched = canonical.includes(alias) ? canonical : `${canonical}\n\n${alias}\n`
  if (patched !== sdkSource) await Bun.write(sdkPath, patched)
}

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`

// Keep the shipped high-level argument name while the PATCH body uses the stricter PartWrite schema.
const v2SdkPath = "./src/v2/gen/sdk.gen.ts"
const v2SdkSource = await Bun.file(v2SdkPath).text()
const v2SdkPatched = v2SdkSource
  .replace("partWrite?: PartWrite", "part?: PartWrite")
  .replace('{ key: "partWrite", map: "body" }', '{ key: "part", map: "body" }')
if (
  v2SdkPatched === v2SdkSource ||
  v2SdkPatched.includes("partWrite?: PartWrite") ||
  v2SdkPatched.includes('{ key: "partWrite", map: "body" }')
) {
  throw new Error(`Part.update compatibility patch did not apply (${v2SdkPath})`)
}
await Bun.write(v2SdkPath, v2SdkPatched)

await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
