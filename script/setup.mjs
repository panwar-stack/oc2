#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline/promises"
import { spawnSync } from "node:child_process"

const minimumNodeMajor = 24
const root = resolve(import.meta.dirname, "..")

export function parseArgs(argv) {
  const options = {
    check: false,
    dryRun: false,
    yes: false,
    skipSystem: false,
    skipDeps: false,
    help: false,
  }
  const flags = {
    "--check": "check",
    "--dry-run": "dryRun",
    "--yes": "yes",
    "--skip-system": "skipSystem",
    "--skip-deps": "skipDeps",
    "--help": "help",
    "-h": "help",
  }

  for (const arg of argv) {
    const key = flags[arg]
    if (!key) throw new Error(`Unknown option: ${arg}. Run npm run setup -- --help for usage.`)
    options[key] = true
  }

  if (options.check && options.dryRun) throw new Error("--check and --dry-run cannot be used together.")
  return options
}

export function detectPackageManager(platform, commandExists) {
  if (platform === "darwin") return commandExists("brew") ? "brew" : undefined
  if (platform === "linux") {
    if (commandExists("apt-get")) return "apt-get"
    if (commandExists("dnf")) return "dnf"
    return undefined
  }
  if (platform === "win32") return commandExists("winget") ? "winget" : undefined
  return undefined
}

export function createPlan({ packageManager, missing, bunVersion, bunPath, skipSystem, skipDeps }) {
  const actions = []
  const errors = []
  const installable = missing.filter((command) => command !== "powershell")

  if (missing.length && skipSystem) {
    errors.push(`Missing system prerequisites: ${missing.join(", ")}. Install them and rerun without --skip-system.`)
  } else if (installable.length && !packageManager) {
    errors.push(
      `Missing system prerequisites: ${installable.join(", ")}. Install them manually; no supported package manager was found.`,
    )
  } else if (missing.includes("powershell")) {
    errors.push("PowerShell is required for safe Windows setup checks. Install PowerShell and rerun setup.")
  } else if (installable.length) {
    actions.push({ type: "system", packageManager, packages: installable })
  }

  if (!bunPath) actions.push({ type: "bun", version: bunVersion })
  if (!skipDeps) actions.push({ type: "dependencies", bunPath })

  return { actions, errors }
}

export function createDependencyArgs(platform) {
  return ["install", "--frozen-lockfile", ...(platform === "win32" ? ["--linker", "hoisted"] : [])]
}

export function createBunInstallArgs(version, directory, packageName) {
  return [
    "install",
    "--prefix",
    directory,
    "--package-lock=false",
    "--no-save",
    "--ignore-scripts",
    `${packageName}@${version}`,
  ]
}

export function selectBunPackage(platform, arch, glibcVersion) {
  if (platform === "darwin" && arch === "arm64") return "@oven/bun-darwin-aarch64"
  if (platform === "darwin" && arch === "x64") return "@oven/bun-darwin-x64-baseline"
  const glibc = /^(\d+)\.(\d+)/.exec(glibcVersion ?? "")
  if (platform === "linux" && (!glibc || Number(glibc[1]) < 2 || (Number(glibc[1]) === 2 && Number(glibc[2]) < 17))) {
    throw new Error("Setup requires glibc 2.17 or newer on Linux.")
  }
  if (platform === "linux" && arch === "arm64") return "@oven/bun-linux-aarch64"
  if (platform === "linux" && arch === "x64") return "@oven/bun-linux-x64-baseline"
  if (platform === "win32" && arch === "x64") return "@oven/bun-windows-x64-baseline"
  throw new Error(`Unsupported platform architecture: ${platform} ${arch}.`)
}

export function createWindowsAdministratorProbeArgs() {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Output 'Administrator' } else { Write-Output 'Standard' }",
  ]
}

export function parseWindowsAdministratorProbe(result) {
  if (result.error || result.status !== 0) {
    throw new Error("Could not determine whether PowerShell is elevated. Rerun setup from a non-administrator shell.")
  }
  const value = result.stdout.trim()
  if (value === "Administrator") return true
  if (value === "Standard") return false
  throw new Error("PowerShell returned an unexpected elevation result. Rerun setup from a non-administrator shell.")
}

export async function runSetup(options, environment = {}) {
  if (Number(process.versions.node.split(".")[0]) < minimumNodeMajor) {
    throw new Error(`Node.js ${minimumNodeMajor} or newer is required. Found ${process.versions.node}.`)
  }

  const platform = environment.platform ?? process.platform
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}. Setup supports macOS, Linux, and Windows.`)
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const bunMatch = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "")
  if (!bunMatch) throw new Error('package.json must declare an exact "packageManager": "bun@x.y.z" version.')
  const bunVersion = bunMatch[1]
  const bunPackage = selectBunPackage(
    platform,
    environment.arch ?? process.arch,
    environment.glibcVersion ??
      (platform === "linux" ? process.report?.getReport().header.glibcVersionRuntime : undefined),
  )
  const getResult = environment.getCommandResult ?? getCommandResult
  const findExecutable = environment.getExecutable ?? ((command) => getExecutable(command, platform, getResult))
  const commandExists = environment.commandExists ?? ((command) => Boolean(findExecutable(command)))
  const packageManager = detectPackageManager(platform, commandExists)
  const gitAvailable = commandExists("git")
  const bunDirectory = getBunDirectory(platform, bunVersion, environment)
  const bun = resolveBun(platform, bunVersion, bunPackage, bunDirectory, environment, findExecutable, getResult)
  const missing = []

  if (!gitAvailable) missing.push("git")
  if (platform === "win32" && !commandExists("powershell") && !commandExists("pwsh")) {
    missing.push("powershell")
  }

  const plan = createPlan({
    packageManager,
    missing,
    bunVersion,
    bunPath: bun.path,
    skipSystem: options.skipSystem,
    skipDeps: options.skipDeps,
  })
  printStatus("Node.js", process.versions.node, true)
  printStatus("Git", gitAvailable ? "available" : "missing", gitAvailable)
  printStatus(
    "Bun",
    bun.path ? `${bunVersion} (${bun.path})` : (bun.found ?? `missing; need ${bunVersion}`),
    Boolean(bun.path),
  )
  if (!options.skipDeps) printStatus("Dependencies", "not verified; frozen install required", false)

  if (plan.errors.length) throw new Error(plan.errors.join("\n"))
  if (options.check) {
    if (plan.actions.length) {
      throw new Error("Repository setup is incomplete. Run npm run setup to repair it.")
    }
    console.log("Repository prerequisites are ready.")
    return
  }

  if (options.dryRun) {
    console.log("\nPlanned actions:")
    for (const action of plan.actions) console.log(`  - ${describeAction(action, platform)}`)
    if (!plan.actions.length) console.log("  - No changes needed")
    return
  }

  if (!plan.actions.length) {
    console.log("Repository setup is already complete.")
    if (bun.path) {
      console.log(`Pinned Bun executable: ${bun.path}`)
      console.log(`Next: ${JSON.stringify(bun.path)} run dev:build`)
    }
    return
  }

  if (plan.actions.some((action) => action.type === "dependencies")) {
    if (platform === "win32") {
      const powershell = commandExists("powershell") ? "powershell" : "pwsh"
      const administrator =
        environment.windowsAdministrator ??
        parseWindowsAdministratorProbe(getResult(powershell, createWindowsAdministratorProbeArgs()))
      if (administrator) {
        throw new Error(
          "Refusing to install repository dependencies from an elevated Windows shell. Run setup as a regular user.",
        )
      }
    } else if (typeof process.getuid === "function" && process.getuid() === 0) {
      throw new Error("Refusing to install repository dependencies as root. Run setup as a regular user.")
    }
  }
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Setup would modify the system or workspace in a non-interactive shell. Rerun with --yes.")
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await prompt.question(`Proceed with ${plan.actions.length} setup action(s)? [y/N] `)
    prompt.close()
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Setup cancelled.")
  }

  let bunPath = bun.path
  for (const action of plan.actions) {
    console.log(`\n${describeAction(action, platform)}...`)
    if (action.type === "system") {
      installSystemPackages(action.packageManager, action.packages, commandExists)
      if (platform === "win32" && action.packages.includes("git")) {
        const powershell = commandExists("powershell") ? "powershell" : "pwsh"
        refreshWindowsPath(powershell, getResult)
        const gitPath = findExecutable("git")
        if (!gitPath || getResult(gitPath, ["--version"]).status !== 0) {
          throw new Error(
            "Git was installed by winget but is not available to this process. Open a new regular terminal and rerun npm run setup.",
          )
        }
        console.log(`Verified Git at ${gitPath}.`)
      }
    }
    if (action.type === "bun") {
      const npmCli = environment.npmExecPath ?? process.env.npm_execpath
      if (!npmCli) throw new Error("npm setup context is missing. Run this command through npm run setup.")
      bunPath = await installBun(platform, action.version, bunPackage, bunDirectory, npmCli, getResult)
    }
    if (action.type === "dependencies") {
      if (!bunPath) throw new Error(`Bun ${bunVersion} is required before dependencies can be installed.`)
      run(bunPath, createDependencyArgs(platform), {
        cwd: root,
      })
    }
  }

  console.log("\nRepository setup complete.")
  if (bunPath) {
    console.log(`Pinned Bun executable: ${bunPath}`)
    console.log(`Next: ${JSON.stringify(bunPath)} run dev:build`)
  }
}

function getBunDirectory(platform, version, environment) {
  const cache =
    environment.cacheDirectory ??
    (platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"))
  return join(cache, "oc2", "bun", version)
}

function resolveBun(platform, version, packageName, directory, environment, findExecutable, getResult) {
  const candidates = [findExecutable("bun"), getInstalledBunPath(platform, packageName, directory)].filter(Boolean)
  let found

  for (const candidate of new Set(candidates)) {
    const result = getResult(candidate, ["--version"])
    if (result.status !== 0) continue
    const candidateVersion = result.stdout.trim()
    if (candidateVersion === version) return { path: candidate, found: candidateVersion }
    found = `${candidateVersion} at ${candidate}`
  }

  return { path: environment.bunPath, found }
}

function getExecutable(command, platform, getResult) {
  const locator = platform === "win32" ? "where.exe" : "which"
  const result = getResult(locator, [command])
  return result.status === 0 ? result.stdout.split(/\r?\n/, 1)[0].trim() : undefined
}

function getCommandResult(command, args) {
  return spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true })
}

function installSystemPackages(packageManager, packages, commandExists) {
  if (packageManager === "winget") {
    if (packages.some((item) => item !== "git")) throw new Error("winget setup only supports installing Git.")
    run("winget", [
      "install",
      "--id",
      "Git.Git",
      "--exact",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ])
    return
  }

  if (packageManager === "brew") {
    run("brew", ["install", ...packages])
    return
  }

  const elevate = typeof process.getuid === "function" && process.getuid() === 0 ? [] : ["sudo"]
  if (elevate.length && !commandExists("sudo")) {
    throw new Error(`sudo is required to install ${packages.join(", ")} with ${packageManager}. Install them manually.`)
  }
  const command = elevate[0] ?? packageManager
  const prefix = elevate.length ? [packageManager] : []
  if (packageManager === "apt-get") run(command, [...prefix, "update"])
  run(command, [...prefix, "install", "-y", ...packages])
}

async function installBun(platform, version, packageName, directory, npmCli, getResult) {
  await mkdir(directory, { recursive: true })
  run(process.execPath, [npmCli, ...createBunInstallArgs(version, directory, packageName)])
  const bunPath = getInstalledBunPath(platform, packageName, directory)
  const result = getResult(bunPath, ["--version"])
  if (result.status !== 0 || result.stdout.trim() !== version) {
    throw new Error(`Bun ${version} was installed from npm but could not be verified at ${bunPath}.`)
  }
  return bunPath
}

function getInstalledBunPath(platform, packageName, directory) {
  return join(directory, "node_modules", packageName, "bin", platform === "win32" ? "bun.exe" : "bun")
}

function refreshWindowsPath(powershell, getResult) {
  const result = getResult(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Write-Output (([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join [IO.Path]::PathSeparator)",
  ])
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      "Git was installed by winget, but setup could not refresh PATH. Open a new regular terminal and rerun npm run setup.",
    )
  }
  process.env.PATH = `${result.stdout.trim()};${process.env.PATH ?? ""}`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit", shell: false, windowsHide: true })
  if (result.error) throw new Error(`Failed to run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${basename(command)} exited with status ${result.status ?? "unknown"}.`)
}

function describeAction(action, platform) {
  if (action.type === "system") return `Install ${action.packages.join(", ")} with ${action.packageManager}`
  if (action.type === "bun") return `Install Bun ${action.version} from the npm registry into the user cache`
  return `Install frozen workspace dependencies${platform === "win32" ? " with the hoisted linker" : ""}`
}

function printStatus(name, value, ready) {
  console.log(`${ready ? "[ok]" : "[missing]"} ${name}: ${value}`)
}

function printHelp() {
  console.log(`Usage: npm run setup -- [options]

Prepare the repository on macOS, Linux, or Windows.

Options:
  --check         Check prerequisites without making changes
  --dry-run       Print planned actions without making changes
  --yes           Allow changes without an interactive confirmation
  --skip-system   Do not install system prerequisites
  --skip-deps     Do not install workspace dependencies
  -h, --help      Show this help`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  await runSetup(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`setup: ${error.message}`)
    process.exitCode = 1
  })
}
