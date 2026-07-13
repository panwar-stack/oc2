import { expect, test } from "bun:test"
import { copyCommand, readImage } from "../src/clipboard"

test("reads a macOS clipboard image as PNG", async () => {
  const image = Buffer.from("png")
  expect(await readImage("darwin", "", async () => Buffer.alloc(0), async () => image)).toEqual({
    data: image.toString("base64"),
    mime: "image/png",
  })
})

test("reads Windows and WSL clipboard images from PowerShell", async () => {
  const run = async (command: string) => {
    expect(command).toBe("powershell.exe")
    return Buffer.from(" cG5n\r\n")
  }
  expect(await readImage("win32", "", run)).toEqual({ data: "cG5n", mime: "image/png" })
  expect(await readImage("linux", "4.4.0-microsoft-standard", run)).toEqual({ data: "cG5n", mime: "image/png" })
})

test("reads Wayland and X11 clipboard image bytes as PNG", async () => {
  const image = Buffer.from("png")
  expect(await readImage("linux", "", async () => image)).toEqual({
    data: image.toString("base64"),
    mime: "image/png",
  })

  const commands: string[] = []
  expect(
    await readImage("linux", "", async (command) => {
      commands.push(command)
      return command === "xclip" ? image : Buffer.alloc(0)
    }),
  ).toEqual({ data: image.toString("base64"), mime: "image/png" })
  expect(commands).toEqual(["wl-paste", "xclip"])
})

test("ignores empty clipboard image output", async () => {
  expect(await readImage("win32", "", async () => Buffer.from("\r\n"))).toBeUndefined()
  expect(await readImage("linux", "", async () => Buffer.alloc(0))).toBeUndefined()
})

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})
