import type { AnthropicBillingIterationWrite, BillingProviderMetadataWrite } from "./gen/types.gen.js"

type Assert<T extends true> = T
type IsVariadicNonEmpty<T extends readonly unknown[]> = T extends [infer Item, ...infer Rest]
  ? number extends T["length"]
    ? Rest extends Array<Item>
      ? true
      : false
    : false
  : false
type DeepInfra = NonNullable<BillingProviderMetadataWrite["deepinfra"]>
type DeepInfraPromptDetails = NonNullable<DeepInfra["prompt_tokens_details"]>
type Anthropic = NonNullable<BillingProviderMetadataWrite["anthropic"]>
type AnthropicUsage = NonNullable<Anthropic["usage"]>
type AnthropicIterations = NonNullable<Anthropic["iterations"]>
type AnthropicUsageIterations = NonNullable<AnthropicUsage["iterations"]>
type Vertex = NonNullable<BillingProviderMetadataWrite["vertex"]>
type VertexUsage = NonNullable<Vertex["usage"]>
type VertexIterations = NonNullable<Vertex["iterations"]>
type VertexUsageIterations = NonNullable<VertexUsage["iterations"]>
type MessageIteration = Extract<AnthropicBillingIterationWrite, { type: "message" }>
type CompactionIteration = Extract<AnthropicBillingIterationWrite, { type: "compaction" }>
type AdvisorIteration = Extract<AnthropicBillingIterationWrite, { type: "advisor_message" }>
type OpenRouter = NonNullable<BillingProviderMetadataWrite["openrouter"]>
type OpenRouterUsage = NonNullable<OpenRouter["usage"]>
type OpenRouterCostDetails = NonNullable<OpenRouterUsage["cost_details"]>

type _DeepInfraNullablePromptDetails = Assert<null extends DeepInfra["prompt_tokens_details"] ? true : false>
type _AnthropicNullableCache = Assert<null extends AnthropicUsage["cache_creation_input_tokens"] ? true : false>
type _AnthropicNullableIterationCache = Assert<
  null extends AnthropicBillingIterationWrite["cache_read_input_tokens"] ? true : false
>
type _OpenRouterNullableCost = Assert<null extends OpenRouterUsage["cost"] ? true : false>
type _OpenRouterNullablePromptDetails = Assert<null extends OpenRouterUsage["prompt_tokens_details"] ? true : false>
type _OpenRouterNullableCostDetails = Assert<null extends OpenRouterUsage["cost_details"] ? true : false>
type _OpenRouterNullableCostValue = Assert<null extends OpenRouterCostDetails["upstream_inference_cost"] ? true : false>
type _ClosedProviderMetadata = Assert<string extends keyof BillingProviderMetadataWrite ? false : true>
type _ClosedDeepInfraMetadata = Assert<string extends keyof DeepInfra ? false : true>
type _ClosedDeepInfraPromptDetails = Assert<string extends keyof DeepInfraPromptDetails ? false : true>
type _ClosedAnthropicMetadata = Assert<string extends keyof Anthropic ? false : true>
type _ClosedAnthropicUsage = Assert<string extends keyof AnthropicUsage ? false : true>
type _ClosedMessageIteration = Assert<string extends keyof MessageIteration ? false : true>
type _ClosedCompactionIteration = Assert<string extends keyof CompactionIteration ? false : true>
type _ClosedAdvisorIteration = Assert<string extends keyof AdvisorIteration ? false : true>
type _ClosedOpenRouterUsage = Assert<string extends keyof OpenRouterUsage ? false : true>
type _ClosedOpenRouterCostDetails = Assert<string extends keyof OpenRouterCostDetails ? false : true>
type _AnthropicIterationsAreVariadicNonEmpty = Assert<IsVariadicNonEmpty<AnthropicIterations>>
type _AnthropicUsageIterationsAreVariadicNonEmpty = Assert<IsVariadicNonEmpty<AnthropicUsageIterations>>
type _VertexIterationsAreVariadicNonEmpty = Assert<IsVariadicNonEmpty<VertexIterations>>
type _VertexUsageIterationsAreVariadicNonEmpty = Assert<IsVariadicNonEmpty<VertexUsageIterations>>
