import { getConfigPaths, type ConfigPathOptions } from "../config/paths"

export function collectEnvironmentInfo(options: ConfigPathOptions = {}): Record<string, unknown> {
  const paths = getConfigPaths(options)
  return {
    cwd: paths.cwd,
    homeDir: paths.homeDir,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    config: {
      user: paths.userConfigPath,
      project: paths.projectConfigPaths,
      explicit: paths.explicitConfigPath ?? null,
    },
    dataDir: paths.dataDir,
  }
}
