import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

export interface ConfigPathOptions {
  cwd?: string
  homeDir?: string
  env?: Record<string, string | undefined>
}

export interface ConfigPaths {
  cwd: string
  homeDir: string
  userConfigPath: string
  projectConfigPaths: string[]
  explicitConfigPath?: string
  dataDir: string
}

/** Expands a leading tilde without changing other shell-like syntax. */
export function expandHome(path: string, homeDir = homedir()): string {
  if (path === "~") return homeDir
  if (path.startsWith("~/")) return `${homeDir}${path.slice(1)}`
  return path
}

/** Resolves config paths after applying oc2's home-directory expansion rules. */
export function resolvePath(path: string, baseDir: string, homeDir = homedir()): string {
  const expanded = expandHome(path, homeDir)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded)
}

/**
 * Computes all filesystem paths used by config loading and diagnostics from
 * process defaults plus OC2_CONFIG/OC2_DATA_DIR overrides.
 */
export function getConfigPaths(options: ConfigPathOptions = {}): ConfigPaths {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const explicitConfigPath = env.OC2_CONFIG ? resolvePath(env.OC2_CONFIG, cwd, homeDir) : undefined
  const dataDir = env.OC2_DATA_DIR ? resolvePath(env.OC2_DATA_DIR, cwd, homeDir) : resolve(homeDir, ".local/share/oc2")

  return {
    cwd,
    homeDir,
    userConfigPath: resolve(homeDir, ".config/oc2/config.jsonc"),
    projectConfigPaths: [resolve(cwd, "oc2.jsonc"), resolve(cwd, ".oc2/config.jsonc")],
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
    dataDir,
  }
}
