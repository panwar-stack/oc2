import { describe, expect, test } from "bun:test"

const publicDir = import.meta.dir + "/../public/assets"

describe("offline product fonts", () => {
  test("uses pinned standard WOFF2 assets without a Nerd family alias or network source", async () => {
    const css = await Bun.file(import.meta.dir + "/index.css").text()
    const faces = css.match(/@font-face\s*\{[^}]+\}/g) ?? []
    const standardMono = faces.find((face) => face.includes('font-family: "JetBrains Mono"'))
    const legacyNerd = faces.find((face) => face.includes('font-family: "JetBrainsMono Nerd Font Mono"'))

    expect(css).not.toMatch(/(?:url|@import)[^(;]*[('"\s]https?:\/\//i)
    expect(standardMono).toContain("/assets/fonts/JetBrainsMonoVariable-Latin.woff2")
    expect(standardMono).not.toContain("NerdFont")
    expect(standardMono).toContain("font-weight: 100 800")
    expect(legacyNerd).toContain("/assets/JetBrainsMonoNerdFontMono-Regular.woff2")
    expect(css).toContain("/assets/fonts/InterVariable-Latin.woff2")
    expect(faces.find((face) => face.includes('font-family: "Inter"'))).toContain("font-weight: 100 900")
    expect(css).not.toContain("Inter.ttf")
    expect(faces.every((face) => face.includes("font-display: swap"))).toBe(true)
  })

  test("tracks exact binaries, provenance, fallback limitations, and OFL notices", async () => {
    const assets = {
      "fonts/InterVariable-Latin.woff2": "2c295d99e26dcf357d4d01bcf270fd6924b600c9a13dd8c363ef114f4c6976fa",
      "fonts/JetBrainsMonoVariable-Latin.woff2": "18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e",
      "JetBrainsMonoNerdFontMono-Regular.woff2": "587236ebb19a2da874c459d14bbe7785a5eb7e1d87969db9574454d09ea50d1c",
    } as const
    const provenance = await Bun.file(publicDir + "/fonts/README.md").text()

    for (const [name, expected] of Object.entries(assets)) {
      const file = Bun.file(`${publicDir}/${name}`)
      expect(await file.exists()).toBe(true)
      expect(new TextDecoder().decode((await file.bytes()).slice(0, 4))).toBe("wOF2")
      expect(new Bun.CryptoHasher("sha256").update(await file.bytes()).digest("hex")).toBe(expected)
      expect(provenance).toContain(expected)
    }

    expect(provenance).toContain("@fontsource-variable/inter@5.2.8")
    expect(provenance).toContain("@fontsource-variable/jetbrains-mono@5.2.8")
    expect(provenance).toContain("system fallback")
    expect(provenance).toContain("does not claim bundled cmap coverage")
    const licenses = {
      "Inter-OFL-1.1.txt": "3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345",
      "JetBrainsMono-OFL-1.1.txt": "403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b",
      "JetBrainsMonoNerdFontMono-OFL-1.1.txt": "60d55f23c6ce05a81099a762cb67ca2c9b6ea251c7912720998b4c89ebfd4faa",
      "NerdFonts-3.4.0-LICENSE.txt": "bede0739eb2bf948765623a7a134360a6320240f4a9e29a5a68f31e191b0f8d0",
    } as const
    for (const [name, expected] of Object.entries(licenses)) {
      const file = Bun.file(`${publicDir}/fonts/${name}`)
      expect(new Bun.CryptoHasher("sha256").update(await file.bytes()).digest("hex")).toBe(expected)
      expect(provenance).toContain(expected)
      const license = await file.text()
      expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1")
      expect(license).toContain("Copyright")
    }
  })
})
