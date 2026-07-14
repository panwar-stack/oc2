import { describe, expect, test } from "bun:test"
import { allocateVersion, findRelease } from "./release-plan"

const source = "1111111111111111111111111111111111111111"
const foreign = "2222222222222222222222222222222222222222"

function release(overrides: Record<string, unknown> = {}) {
  const markerSource = typeof overrides.target_commitish === "string" ? overrides.target_commitish : source
  return {
    body: `<!-- oc2-release-source:${markerSource} -->`,
    draft: true,
    prerelease: false,
    tag_name: "v1.2.3",
    target_commitish: markerSource,
    ...overrides,
  }
}

describe("release plan", () => {
  test("allocates 0.0.1 with empty release history", () => {
    expect(allocateVersion([], [])).toBe("0.0.1")
  })

  test("allocates from Git-tag-only history", () => {
    expect(allocateVersion([], ["refs/tags/v1.2.3"])).toBe("1.2.4")
  })

  test("allocates from Release-only history", () => {
    expect(allocateVersion([[{ tag_name: "v1.2.3" }]], [])).toBe("1.2.4")
  })

  test("reserves versions used by draft Releases", () => {
    expect(allocateVersion([[release({ tag_name: "v1.2.3" })]], [])).toBe("1.2.4")
  })

  test("selects the highest version across Releases and Git tags", () => {
    expect(allocateVersion([[{ tag_name: "v1.2.3" }]], ["refs/tags/v1.2.4"])).toBe("1.2.5")
  })

  test("deduplicates duplicate and annotated Git tags", () => {
    expect(
      allocateVersion([[{ tag_name: "v1.2.3" }, { tag_name: "v1.2.3" }]], ["refs/tags/v1.2.3", "refs/tags/v1.2.3^{}"]),
    ).toBe("1.2.4")
  })

  test("ignores malformed and prerelease versions", () => {
    expect(
      allocateVersion(
        [[{ tag_name: "v1.2.3-beta.1" }, { tag_name: "invalid" }]],
        ["refs/tags/v1.2", "refs/tags/v2.0.0-rc.1"],
      ),
    ).toBe("0.0.1")
  })

  test("does not normalize Release tags as Git refs", () => {
    expect(allocateVersion([[{ tag_name: "refs/tags/v9.0.0" }]], [])).toBe("0.0.1")
  })

  test("rejects version increment failures", () => {
    expect(() => allocateVersion([], [], () => null)).toThrow("could not allocate patch version")
  })

  test("rejects noncanonical increment results", () => {
    expect(() => allocateVersion([], [], () => "1.0")).toThrow("could not allocate patch version")
  })

  test("rejects an actual patch overflow", () => {
    expect(() => allocateVersion([[{ tag_name: "v0.0.9007199254740991" }]], [])).toThrow(
      "could not allocate patch version",
    )
  })

  test("allocates only when no workflow Release exists", () => {
    expect(findRelease([[release({ body: "unrelated" })]], source)).toEqual({ state: "missing", complete: false })
  })

  test("resumes a valid draft for the source", () => {
    expect(findRelease([[release()]], source)).toEqual({
      state: "draft",
      complete: false,
      tag: "v1.2.3",
      version: "1.2.3",
      source,
    })
  })

  test("completes a valid published Release for the source", () => {
    expect(findRelease([[release({ draft: false })]], source)).toEqual({
      state: "published",
      complete: true,
      tag: "v1.2.3",
      version: "1.2.3",
      source,
    })
  })

  test("preserves source resume when another workflow draft exists", () => {
    expect(findRelease([[release(), release({ target_commitish: foreign, tag_name: "v1.2.4" })]], source).state).toBe(
      "draft",
    )
  })

  test("rejects multiple Releases for the source", () => {
    expect(() => findRelease([[release(), release({ draft: false })]], source)).toThrow("found 2 Releases")
  })

  test("blocks allocation for one valid foreign workflow draft", () => {
    expect(findRelease([[release({ target_commitish: foreign })]], source)).toEqual({
      state: "blocked",
      complete: false,
      tag: "v1.2.3",
      version: "1.2.3",
      source: foreign,
    })
  })

  test("rejects malformed and duplicate workflow markers", () => {
    expect(() =>
      findRelease([[release({ body: "<!-- oc2-release-source:ABC -->", target_commitish: foreign })]], source),
    ).toThrow("exactly one lowercase 40-hex")
    expect(() =>
      findRelease(
        [[release({ body: `<!-- oc2-release-source:${foreign} -->\n<!-- oc2-release-source:${foreign} -->` })]],
        source,
      ),
    ).toThrow("exactly one lowercase 40-hex")
  })

  test("rejects a workflow marker that differs from target_commitish", () => {
    expect(() => findRelease([[release({ body: `<!-- oc2-release-source:${foreign} -->` })]], source)).toThrow(
      "must match target_commitish",
    )
  })

  test("rejects noncanonical, unstable, and prerelease Releases", () => {
    expect(() => findRelease([[release({ target_commitish: foreign, tag_name: "1.2.3" })]], source)).toThrow(
      "canonical stable semver",
    )
    expect(() => findRelease([[release({ target_commitish: foreign, tag_name: "v1.2.3-beta.1" })]], source)).toThrow(
      "canonical stable semver",
    )
    expect(() => findRelease([[release({ target_commitish: foreign, prerelease: true })]], source)).toThrow(
      "must not be a prerelease",
    )
  })

  test("rejects multiple foreign workflow drafts", () => {
    expect(() =>
      findRelease(
        [
          [
            release({ target_commitish: foreign }),
            release({ target_commitish: "3333333333333333333333333333333333333333", tag_name: "v1.2.4" }),
          ],
        ],
        source,
      ),
    ).toThrow("found 2 workflow draft Releases")
  })

  test("rejects malformed foreign Release draft state", () => {
    expect(() => findRelease([[release({ target_commitish: foreign, draft: "true" })]], source)).toThrow(
      "unexpected Release draft state",
    )
    const missing = release({ target_commitish: foreign })
    Reflect.deleteProperty(missing, "draft")
    expect(() => findRelease([[missing]], source)).toThrow("unexpected Release draft state")
  })
})
