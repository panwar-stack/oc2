export const objectSchema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export const stringProperty = (description: string): Record<string, unknown> => ({ type: "string", description })

export const numberProperty = (description: string): Record<string, unknown> => ({ type: "number", description })

export const booleanProperty = (description: string): Record<string, unknown> => ({ type: "boolean", description })
