import { EventV2Bridge } from "@/event-v2-bridge"

export const Service = EventV2Bridge.Service
export const layer = EventV2Bridge.defaultLayer

export * as Bus from "./index"
