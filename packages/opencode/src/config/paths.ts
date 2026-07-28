export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@oc2-ai/core/flag/flag"
import { Global } from "@oc2-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Naming } from "@oc2-ai/core/naming"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: name === Naming.appSlug ? [...Naming.configFileSearchTargets] : [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

const directoryPlan = Effect.fnUntraced(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const project = !Flag.OC2_DISABLE_PROJECT_CONFIG
    ? yield* afs.up({
        targets: [...Naming.configDirs].toReversed(),
        start: directory,
        stop: worktree,
      })
    : []
  return {
    project,
    all: unique([
      Global.Path.config,
      ...project,
      ...(yield* afs.up({
        targets: [...Naming.configDirs].toReversed(),
        start: Global.Path.home,
        stop: Global.Path.home,
      })),
      ...(Flag.OC2_CONFIG_DIR ? [Flag.OC2_CONFIG_DIR] : []),
    ]),
  }
})

export const plan = Effect.fn("ConfigPaths.plan")(function* (directory: string, worktree?: string) {
  const direct = Flag.OC2_DISABLE_PROJECT_CONFIG ? [] : yield* files(Naming.appSlug, directory, worktree)
  const directories = yield* directoryPlan(directory, worktree)

  return {
    direct,
    directories: directories.all,
    project: [...direct, ...directories.project.flatMap((dir) => fileInDirectory(dir, Naming.appSlug))],
    candidates: candidateFiles(directory, worktree, directories.all),
  }
})

function candidateFiles(directory: string, worktree: string | undefined, configDirectories: readonly string[]) {
  const stop = worktree ? path.resolve(worktree) : path.parse(path.resolve(directory)).root
  const ancestors: string[] = []
  let current = path.resolve(directory)
  while (true) {
    ancestors.push(current)
    if (current === stop || current === path.dirname(current)) break
    current = path.dirname(current)
  }
  return unique([
    ...ancestors.toReversed().flatMap((dir) => Naming.configFiles.map((file) => path.join(dir, file))),
    ...ancestors.toReversed().flatMap((dir) =>
      Naming.configDirs.flatMap((name) => fileInDirectory(path.join(dir, name), Naming.appSlug)),
    ),
    ...configDirectories.flatMap((dir) => fileInDirectory(dir, Naming.appSlug)),
    ...fileInDirectory(path.join(Global.Path.home, ".oc2"), Naming.appSlug),
    ...Naming.globalConfigFiles.map((file) => path.join(Global.Path.config, file)),
    ...(Flag.OC2_CONFIG ? [Flag.OC2_CONFIG] : []),
  ])
}

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  return (yield* directoryPlan(directory, worktree)).all
})

export function fileInDirectory(dir: string, name: string) {
  if (name === Naming.appSlug) return Naming.configFileLoadOrder.map((file) => path.join(dir, file))
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
