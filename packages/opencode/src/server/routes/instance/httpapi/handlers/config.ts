import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { MutationCoordinator } from "@/config/mutation-coordinator"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConfigActivationError } from "../errors"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const mutations = yield* MutationCoordinator.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const instance = yield* InstanceState.context
      const path = yield* configSvc.updatePath()
      const result = yield* mutations.project({
        directory: instance.directory,
        path,
        write: configSvc.updateAt(path, ctx.payload),
      })
      if (result.status === "rejected") {
        return yield* result.reason === "bootstrap"
          ? new ConfigActivationError({ message: result.message ?? "Configuration could not be activated." })
          : new HttpApiError.BadRequest({})
      }
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const publicProviders = yield* providerSvc.listPublic()
      return {
        providers: Object.values(publicProviders.providers),
        default: Provider.defaultModelIDs(publicProviders.providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
