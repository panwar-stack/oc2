import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repository = join(import.meta.dir, "..")
let root = ""
let archive = ""
let digest = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "oc2-install-test-"))
  const payload = join(root, "payload")
  const bin = join(root, "bin")
  archive = join(root, "oc2-linux-x64.tar.gz")
  await mkdir(payload)
  await mkdir(bin)
  await Bun.write(join(payload, "oc2"), "#!/bin/sh\nprintf '1.2.3\\n'\n")
  await chmod(join(payload, "oc2"), 0o755)

  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", payload, "oc2"])
  expect(tar.exitCode).toBe(0)
  digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")

  await Bun.write(
    join(bin, "uname"),
    "#!/bin/sh\nif [ \"${1:-}\" = \"-s\" ]; then printf 'Linux\\n'; else printf 'x86_64\\n'; fi\n",
  )
  await Bun.write(
    join(bin, "curl"),
    '#!/bin/sh\ncase " $* " in *" -sI "*) printf "200"; exit 0;; esac\noutput=""\ntrace=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then output=$2; shift 2; continue; fi\n  if [ "$1" = "--trace-ascii" ]; then trace=$2; shift 2; continue; fi\n  shift\ndone\nif [ -n "$trace" ]; then : > "$trace"; fi\ncp "$TEST_ARCHIVE" "$output"\n',
  )
  await chmod(join(bin, "uname"), 0o755)
  await chmod(join(bin, "curl"), 0o755)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runInstaller(expectedSHA256: string, preinstallSameVersion = false, hostileTemporary = false) {
  const home = await mkdtemp(join(root, "home-"))
  const marker = join(root, "trap-injected")
  const temporary = hostileTemporary
    ? join(root, 'tmp-$(touch "$TEST_MARKER")')
    : await mkdtemp(join(root, "tmp-"))
  if (hostileTemporary) await mkdir(temporary)
  if (preinstallSameVersion) {
    const installed = join(home, ".oc2/bin/oc2")
    await mkdir(join(home, ".oc2/bin"), { recursive: true })
    await Bun.write(installed, "#!/bin/sh\nprintf '1.2.3\\n'\n# stale installation\n")
    await chmod(installed, 0o755)
  }
  const installer = ["/bin/bash", join(repository, "install"), "--version", "1.2.3", "--no-modify-path"]
  const command = hostileTemporary
    ? process.platform === "darwin"
      ? ["script", "-q", "/dev/null", ...installer]
      : ["script", "-q", "-e", "-c", '/bin/bash "$TEST_INSTALLER" --version 1.2.3 --no-modify-path', "/dev/null"]
    : installer
  const child = Bun.spawnSync(command, {
    env: {
      ...Bun.env,
      HOME: home,
      OC2_ASSET_SHA256: expectedSHA256,
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      SHELL: "/bin/sh",
      TEST_ARCHIVE: archive,
      TEST_INSTALLER: join(repository, "install"),
      TEST_MARKER: marker,
      TMPDIR: temporary,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    home,
    marker,
    status: child.exitCode,
    output: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

describe("release archive verification", () => {
  test("rejects a missing expected digest", async () => {
    const result = await runInstaller("")
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("OC2_ASSET_SHA256 is required")
    expect(await Bun.file(join(result.home, ".oc2/bin/oc2")).exists()).toBe(false)
  })

  test("rejects a malformed expected digest", async () => {
    const result = await runInstaller("not-a-sha256")
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("must be exactly 64 hexadecimal characters")
    expect(await Bun.file(join(result.home, ".oc2/bin/oc2")).exists()).toBe(false)
  })

  test("rejects a mismatched expected digest", async () => {
    const result = await runInstaller("0".repeat(64))
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("SHA-256 does not match")
    expect(await Bun.file(join(result.home, ".oc2/bin/oc2")).exists()).toBe(false)
  })

  test("installs an archive with the expected digest", async () => {
    const result = await runInstaller(digest)
    expect(result.status).toBe(0)
    const binary = join(result.home, ".oc2/bin/oc2")
    expect(await Bun.file(binary).exists()).toBe(true)
    expect(Bun.spawnSync([binary]).stdout.toString()).toBe("1.2.3\n")
  })

  test("verifies and replaces an existing binary with the requested version", async () => {
    const result = await runInstaller(digest, true)
    expect(result.status).toBe(0)
    const binary = join(result.home, ".oc2/bin/oc2")
    expect(await Bun.file(binary).text()).toBe("#!/bin/sh\nprintf '1.2.3\\n'\n")
  })

  test("does not evaluate shell syntax from TMPDIR during cleanup", async () => {
    const result = await runInstaller(digest, false, true)
    expect(result.status).toBe(0)
    expect(await Bun.file(result.marker).exists()).toBe(false)
  })
})
