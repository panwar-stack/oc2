import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "@/server/routes/instance/httpapi/public"

type OpenApiSpec = {
  readonly paths: Record<string, unknown>
  readonly components?: { readonly schemas?: Record<string, unknown> }
}

describe("supervisor HttpApi", () => {
  test("does not expose supervisor routes or schemas", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(spec.paths["/session/{sessionID}/supervisor"]).toBeUndefined()
    expect(spec.paths["/session/{sessionID}/supervisor/activity"]).toBeUndefined()
    expect(spec.paths["/session/{sessionID}/supervisor/report"]).toBeUndefined()
    expect(spec.components?.schemas?.SupervisorSettingsPatch).toBeUndefined()
  })
})
