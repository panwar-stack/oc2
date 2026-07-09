export * as ServerAuth from "./auth"

import { Flag } from "@oc2-ai/core/flag/flag"
import { Naming } from "@oc2-ai/core/naming"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

const string = (name: string) => EffectConfig.string(name)
const DEFAULT_USERNAME = Naming.appSlug

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly usernameConfigured?: boolean
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static layer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get defaultLayer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: string("OC2_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: string("OC2_SERVER_USERNAME").pipe(EffectConfig.withDefault(DEFAULT_USERNAME)),
            usernameConfigured: string("OC2_SERVER_USERNAME").pipe(
              EffectConfig.option,
              EffectConfig.map(Option.isSome),
            ),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OC2_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OC2_SERVER_USERNAME ?? DEFAULT_USERNAME
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
