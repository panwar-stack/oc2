#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import { rm } from "fs/promises"
import path from "path"
import { formatBunCompileTargetName, Script, selectBunCompileTargets } from "@oc2-ai/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import pkg from "../package.json"
import { modelsData } from "./generate"

const dir = path.resolve(import.meta.dirname, "..")
const binary = "lildax"
process.chdir(dir)

await rm("dist", { recursive: true, force: true })

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

const targets = selectBunCompileTargets({ single: singleFlag, baseline: baselineFlag })

if (!skipInstall) await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`

const localParserWorker = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootParserWorker = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localParserWorker) ? localParserWorker : rootParserWorker)

for (const item of targets) {
  const target = formatBunCompileTargetName(binary, item)
  const name = target.replace(binary, "cli")
  console.log(`building ${name}`)
  const result = await Bun.build({
    entrypoints: ["./src/index.ts", parserWorker],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      outfile: `./dist/${name}/bin/${binary}`,
      execArgv: [`--user-agent=${binary}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_CLI_NAME: `'${binary}'`,
      OPENCODE_MODELS_DEV: modelsData,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      OTUI_TREE_SITTER_WORKER_PATH:
        (item.os === "win32" ? '"B:/~BUN/root/' : '"/$bunfs/root/') +
        path.relative(dir, parserWorker).replaceAll("\\", "/") +
        '"',
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  await Bun.write(
    `./dist/${name}/package.json`,
    JSON.stringify(
      {
        name: `@opencode-ai/${name}`,
        version: Script.version,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/panwar-stack/oc2.git" },
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
}
