import { z } from "zod";

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

const AnthropicTextBlockSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.passthrough();

const AnthropicToolUseBlockSchema = z
	.object({
		type: z.literal("tool_use"),
		id: z.string(),
		name: z.string(),
		input: z.record(z.unknown()),
	})
	.passthrough();

const AnthropicThinkingBlockSchema = z
	.object({
		type: z.literal("thinking"),
		thinking: z.string(),
		signature: z.string().optional(),
	})
	.passthrough();

const AnthropicRedactedThinkingBlockSchema = z
	.object({
		type: z.literal("redacted_thinking"),
		data: z.string(),
	})
	.passthrough();

const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
	AnthropicTextBlockSchema,
	AnthropicToolUseBlockSchema,
	AnthropicThinkingBlockSchema,
	AnthropicRedactedThinkingBlockSchema,
]);

const AnthropicUsageSchema = z
	.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		cache_creation_input_tokens: z.number().optional(),
		cache_read_input_tokens: z.number().optional(),
	})
	.passthrough();

export const AnthropicResponseSchema = z
	.object({
		id: z.string(),
		type: z.literal("message"),
		role: z.literal("assistant"),
		content: z.array(AnthropicContentBlockSchema),
		model: z.string(),
		stop_reason: z.string().nullable(),
		usage: AnthropicUsageSchema,
	})
	.passthrough();

export const AnthropicErrorSchema = z
	.object({
		type: z.literal("error"),
		error: z
			.object({
				type: z.string(),
				message: z.string(),
			})
			.passthrough(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

const OpenAIOutputTextSchema = z
	.object({
		type: z.literal("output_text"),
		text: z.string(),
	})
	.passthrough();

const OpenAIMessageOutputSchema = z
	.object({
		type: z.literal("message"),
		role: z.string(),
		content: z.array(OpenAIOutputTextSchema),
	})
	.passthrough();

const OpenAIFunctionCallOutputSchema = z
	.object({
		type: z.literal("function_call"),
		id: z.string(),
		name: z.string(),
		arguments: z.string(),
		call_id: z.string(),
	})
	.passthrough();

const OpenAIOutputItemSchema = z.discriminatedUnion("type", [
	OpenAIMessageOutputSchema,
	OpenAIFunctionCallOutputSchema,
]);

const OpenAIOutputTokensDetailsSchema = z
	.object({
		reasoning_tokens: z.number().optional(),
	})
	.passthrough();

const OpenAIUsageSchema = z
	.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		total_tokens: z.number(),
		output_tokens_details: OpenAIOutputTokensDetailsSchema.optional(),
	})
	.passthrough();

export const OpenAIResponseSchema = z
	.object({
		id: z.string(),
		output: z.array(OpenAIOutputItemSchema),
		status: z.string(),
		model: z.string().optional(),
		usage: OpenAIUsageSchema.optional(),
	})
	.passthrough();

export const OpenAIErrorSchema = z
	.object({
		error: z
			.object({
				message: z.string(),
				type: z.string(),
				code: z.string().optional(),
			})
			.passthrough(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Gemini generateContent API
// ---------------------------------------------------------------------------

const GeminiTextPartSchema = z
	.object({
		text: z.string(),
	})
	.passthrough();

const GeminiFunctionCallPartSchema = z
	.object({
		functionCall: z
			.object({
				name: z.string(),
				args: z.record(z.unknown()),
			})
			.passthrough(),
	})
	.passthrough();

const GeminiFunctionResponsePartSchema = z
	.object({
		functionResponse: z
			.object({
				name: z.string(),
				response: z.record(z.unknown()),
			})
			.passthrough(),
	})
	.passthrough();

const GeminiPartSchema = z.union([
	GeminiTextPartSchema,
	GeminiFunctionCallPartSchema,
	GeminiFunctionResponsePartSchema,
]);

const GeminiContentSchema = z
	.object({
		parts: z.array(GeminiPartSchema),
		role: z.string(),
	})
	.passthrough();

const GeminiSafetyRatingSchema = z.record(z.unknown());

const GeminiCandidateSchema = z
	.object({
		content: GeminiContentSchema.optional(),
		finishReason: z.string().optional(),
		safetyRatings: z.array(GeminiSafetyRatingSchema).optional(),
	})
	.passthrough();

const GeminiUsageMetadataSchema = z
	.object({
		promptTokenCount: z.number(),
		candidatesTokenCount: z.number(),
		totalTokenCount: z.number(),
		thoughtsTokenCount: z.number().optional(),
	})
	.passthrough();

export const GeminiResponseSchema = z
	.object({
		candidates: z.array(GeminiCandidateSchema).optional(),
		usageMetadata: GeminiUsageMetadataSchema.optional(),
		modelVersion: z.string().optional(),
	})
	.passthrough();

export const GeminiErrorSchema = z
	.object({
		error: z
			.object({
				code: z.number(),
				message: z.string(),
				status: z.string(),
			})
			.passthrough(),
	})
	.passthrough();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AnthropicResponse = z.infer<typeof AnthropicResponseSchema>;
export type AnthropicError = z.infer<typeof AnthropicErrorSchema>;
export type OpenAIResponse = z.infer<typeof OpenAIResponseSchema>;
export type OpenAIError = z.infer<typeof OpenAIErrorSchema>;
export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;
export type GeminiError = z.infer<typeof GeminiErrorSchema>;
