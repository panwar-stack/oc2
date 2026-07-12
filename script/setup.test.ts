import { describe, expect, test } from "bun:test"
import {
  createBunInstallArgs,
  createDependencyArgs,
  createPlan,
  createWindowsAdministratorProbeArgs,
  detectPackageManager,
  parseArgs,
  parseWindowsAdministratorProbe,
  runSetup,
  selectBunPackage,
} from "./setup.mjs"

const options = {
  check: false,
  dryRun: false,
  yes: false,
  skipSystem: false,
  skipDeps: true,
  help: false,
}

describe("repository setup", () => {
  test("parses supported flags and rejects invalid combinations", () => {
    expect(parseArgs(["--check", "--yes", "--skip-system", "--skip-deps"])).toEqual({
      check: true,
      dryRun: false,
      yes: true,
      skipSystem: true,
      skipDeps: true,
      help: false,
    })
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option: --unknown")
    expect(() => parseArgs(["--check", "--dry-run"])).toThrow("cannot be used together")
  })

  test("selects supported package managers in platform priority order", () => {
    expect(detectPackageManager("darwin", (command: string) => command === "brew")).toBe("brew")
    expect(detectPackageManager("linux", (command: string) => ["apt-get", "dnf"].includes(command))).toBe("apt-get")
    expect(detectPackageManager("linux", (command: string) => command === "dnf")).toBe("dnf")
    expect(detectPackageManager("win32", (command: string) => command === "winget")).toBe("winget")
    expect(detectPackageManager("freebsd", () => true)).toBeUndefined()
  })

  test("plans system, Bun, and dependency work without executing it", () => {
    expect(
      createPlan({
        packageManager: "apt-get",
        missing: ["git", "curl"],
        bunVersion: "1.3.14",
        bunPath: undefined,
        skipSystem: false,
        skipDeps: false,
      }),
    ).toEqual({
      actions: [
        { type: "system", packageManager: "apt-get", packages: ["git", "curl"] },
        { type: "bun", version: "1.3.14" },
        { type: "dependencies", bunPath: undefined },
      ],
      errors: [],
    })
    expect(
      createPlan({
        packageManager: undefined,
        missing: ["git"],
        bunVersion: "1.3.14",
        bunPath: "/bun",
        skipSystem: false,
        skipDeps: true,
      }).errors,
    ).toEqual(["Missing system prerequisites: git. Install them manually; no supported package manager was found."])
  })

  test("uses the hoisted linker only on Windows", () => {
    expect(createDependencyArgs("win32")).toEqual(["install", "--frozen-lockfile", "--linker", "hoisted"])
    expect(createDependencyArgs("linux")).toEqual(["install", "--frozen-lockfile"])
  })

  test("installs the exact Bun package without a repository lockfile", () => {
    expect(createBunInstallArgs("1.3.14", "/cache/oc2/bun/1.3.14", "@oven/bun-linux-x64-baseline")).toEqual([
      "install",
      "--prefix",
      "/cache/oc2/bun/1.3.14",
      "--package-lock=false",
      "--no-save",
      "--ignore-scripts",
      "@oven/bun-linux-x64-baseline@1.3.14",
    ])
  })

  test("selects script-free Bun packages conservatively for supported hosts", () => {
    expect(selectBunPackage("darwin", "arm64")).toBe("@oven/bun-darwin-aarch64")
    expect(selectBunPackage("darwin", "x64")).toBe("@oven/bun-darwin-x64-baseline")
    expect(() => selectBunPackage("linux", "arm64", "2.16")).toThrow("glibc 2.17 or newer")
    expect(selectBunPackage("linux", "arm64", "2.17")).toBe("@oven/bun-linux-aarch64")
    expect(selectBunPackage("linux", "x64", "2.39")).toBe("@oven/bun-linux-x64-baseline")
    expect(selectBunPackage("win32", "x64")).toBe("@oven/bun-windows-x64-baseline")
    expect(() => selectBunPackage("linux", "x64")).toThrow("glibc 2.17 or newer")
    expect(() => selectBunPackage("win32", "arm64")).toThrow("Unsupported platform architecture")
  })

  test("uses an argv-only PowerShell administrator probe", () => {
    const args = createWindowsAdministratorProbeArgs()
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"])
    expect(args[3]).toContain("WindowsPrincipal")
    expect(parseWindowsAdministratorProbe({ status: 0, stdout: "Administrator\r\n" })).toBe(true)
    expect(parseWindowsAdministratorProbe({ status: 0, stdout: "Standard\r\n" })).toBe(false)
    expect(() => parseWindowsAdministratorProbe({ status: 1, stdout: "" })).toThrow("non-administrator shell")
  })

  test("refuses Windows dependency installation from an elevated shell", async () => {
    await runSetup(
      { ...options, yes: true, skipDeps: false },
      {
        platform: "win32",
        bunPath: "C:\\verified\\bun.exe",
        commandExists: () => true,
        getExecutable: () => undefined,
        windowsAdministrator: true,
      },
    ).then(
      () => expect.unreachable(),
      (error) => expect(error).toHaveProperty("message", expect.stringContaining("elevated Windows shell")),
    )
  })

  test("does not treat an existing node_modules directory as lockfile-ready", async () => {
    await runSetup(
      { ...options, check: true, skipDeps: false },
      {
        platform: "darwin",
        bunPath: "/verified/bun",
        commandExists: () => true,
        getExecutable: () => undefined,
      },
    ).then(
      () => expect.unreachable(),
      (error) => expect(error).toHaveProperty("message", expect.stringContaining("setup is incomplete")),
    )
  })

  test("check and dry-run report plans without invoking installers", async () => {
    const environment = {
      platform: "darwin",
      bunPath: "/not-executed/bun",
      commandExists: (command: string) => command !== "git",
    }
    await runSetup({ ...options, check: true }, environment).then(
      () => expect.unreachable(),
      (error) => expect(error).toHaveProperty("message", expect.stringContaining("setup is incomplete")),
    )
    expect(await runSetup({ ...options, dryRun: true }, environment)).toBeUndefined()
  })

  test("reports unsupported platforms and missing Windows PowerShell", async () => {
    await runSetup(options, { platform: "freebsd" }).then(
      () => expect.unreachable(),
      (error) => expect(error).toHaveProperty("message", expect.stringContaining("Unsupported platform: freebsd")),
    )
    expect(
      createPlan({
        packageManager: "winget",
        missing: ["powershell"],
        bunVersion: "1.3.14",
        bunPath: undefined,
        skipSystem: false,
        skipDeps: true,
      }).errors,
    ).toEqual(["PowerShell is required for safe Windows setup checks. Install PowerShell and rerun setup."])
  })
})
