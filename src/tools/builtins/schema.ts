/** Builds the JSON-schema object wrapper used in model-facing tool definitions. */
export const objectSchema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

/** Builds a described string property for model-facing tool schemas. */
export const stringProperty = (description: string): Record<string, unknown> => ({ type: "string", description })

/** Builds a described number property for model-facing tool schemas. */
export const numberProperty = (description: string): Record<string, unknown> => ({ type: "number", description })

/** Builds a described boolean property for model-facing tool schemas. */
export const booleanProperty = (description: string): Record<string, unknown> => ({ type: "boolean", description })
