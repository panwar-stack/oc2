export interface BunCompileTarget {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export const bunCompileTargets: BunCompileTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function selectBunCompileTargets(options: { single: boolean; baseline: boolean }): BunCompileTarget[] {
  if (!options.single) return bunCompileTargets

  return bunCompileTargets.filter((item) => {
    if (item.os !== process.platform || item.arch !== process.arch) return false
    if (item.avx2 === false) return options.baseline
    return item.abi === undefined
  })
}

export function formatBunCompileTargetName(prefix: string, target: BunCompileTarget): string {
  return [
    prefix,
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter(Boolean)
    .join("-")
}
