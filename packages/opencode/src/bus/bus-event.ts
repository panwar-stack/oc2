import { EventV2 } from "@oc2-ai/core/event"

export const BusEvent = {
  define<const Type extends string>(type: Type, schema: any) {
    return Object.assign(EventV2.define({ type, schema: schema.fields ?? {} }), { properties: schema })
  },
}
