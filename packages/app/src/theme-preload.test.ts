import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 to oc-2 before mount", () => {
    localStorage.setItem("opencode-theme-id", "oc-1")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#000;")
    localStorage.setItem("opencode-theme-css-light.v2", "--background-base:#eee;")
    localStorage.setItem("opencode-theme-css-dark.v2", "--background-base:#111;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("opencode-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-light.v2")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-dark.v2")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("uses only versioned cached css for non-default themes", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#stale;")
    localStorage.setItem("opencode-theme-css-light.v2", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
    expect(document.getElementById("oc-theme-preload")?.textContent).not.toContain("#stale")
    expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
  })

  test("uses versioned dark css for a system-dark non-default theme", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#stale;")
    localStorage.setItem("opencode-theme-css-dark.v2", "--background-base:#000;")
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true }) as MediaQueryList,
      configurable: true,
    })

    run()

    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#000;")
    expect(document.getElementById("oc-theme-preload")?.textContent).not.toContain("#stale")
    expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
  })

  test("sets the light theme color before mount", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000">'

    run()

    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#FFFFFF")
  })

  test("sets the dark theme color before mount", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#FFFFFF">'
    localStorage.setItem("opencode-color-scheme", "dark")

    run()

    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0A0D12")
  })
})
