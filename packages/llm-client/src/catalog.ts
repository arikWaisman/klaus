export interface ModelInfo {
	id: string;
	provider: string;
	display_name: string;
	context_window: number;
	max_output: number;
	supports_tools: boolean;
	supports_vision: boolean;
	supports_reasoning: boolean;
	input_cost_per_million: number;
	output_cost_per_million: number;
	aliases: string[];
}

const catalog: ModelInfo[] = [
	// ── Anthropic ────────────────────────────────────────────────
	{
		id: "claude-opus-4-6",
		provider: "anthropic",
		display_name: "Claude Opus 4.6",
		context_window: 200_000,
		max_output: 32_000,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 15,
		output_cost_per_million: 75,
		aliases: ["claude-opus-4-6-20250814"],
	},
	{
		id: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
		display_name: "Claude Sonnet 4.5",
		context_window: 200_000,
		max_output: 16_000,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 3,
		output_cost_per_million: 15,
		aliases: ["claude-sonnet-4-5"],
	},
	{
		id: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		display_name: "Claude Haiku 4.5",
		context_window: 200_000,
		max_output: 8192,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: false,
		input_cost_per_million: 0.8,
		output_cost_per_million: 4,
		aliases: ["claude-haiku-4-5"],
	},

	// ── OpenAI ───────────────────────────────────────────────────
	{
		id: "gpt-5.2",
		provider: "openai",
		display_name: "GPT-5.2",
		context_window: 256_000,
		max_output: 16_384,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 2.5,
		output_cost_per_million: 10,
		aliases: [],
	},
	{
		id: "gpt-5.2-mini",
		provider: "openai",
		display_name: "GPT-5.2 Mini",
		context_window: 128_000,
		max_output: 16_384,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 0.6,
		output_cost_per_million: 2.4,
		aliases: [],
	},
	{
		id: "gpt-5.3-codex",
		provider: "openai",
		display_name: "GPT-5.3 Codex",
		context_window: 256_000,
		max_output: 16_384,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 2.5,
		output_cost_per_million: 10,
		aliases: [],
	},

	// ── Gemini ───────────────────────────────────────────────────
	{
		id: "gemini-3.1-pro-preview",
		provider: "gemini",
		display_name: "Gemini 3.1 Pro",
		context_window: 2_000_000,
		max_output: 65_536,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: true,
		input_cost_per_million: 1.25,
		output_cost_per_million: 10,
		aliases: [],
	},
	{
		id: "gemini-3-flash-preview",
		provider: "gemini",
		display_name: "Gemini 3 Flash",
		context_window: 1_000_000,
		max_output: 65_536,
		supports_tools: true,
		supports_vision: true,
		supports_reasoning: false,
		input_cost_per_million: 0.15,
		output_cost_per_million: 0.6,
		aliases: ["gemini-3-flash"],
	},
];

/**
 * Look up a model by its canonical id or any of its aliases.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
	return catalog.find((m) => m.id === modelId || m.aliases.includes(modelId));
}

/**
 * Return every model in the catalog, optionally filtered to a single provider.
 */
export function listModels(provider?: string): ModelInfo[] {
	if (provider === undefined) {
		return [...catalog];
	}
	return catalog.filter((m) => m.provider === provider);
}

/**
 * Return the first model that matches the given provider and (optionally) a
 * required capability.  Models are ordered by preference inside the catalog, so
 * the first match is the "latest / best" choice for that provider.
 */
export function getLatestModel(
	provider: string,
	capability?: "reasoning" | "vision" | "tools",
): ModelInfo | undefined {
	return catalog.find((m) => {
		if (m.provider !== provider) {
			return false;
		}
		if (capability === "reasoning") {
			return m.supports_reasoning;
		}
		if (capability === "vision") {
			return m.supports_vision;
		}
		if (capability === "tools") {
			return m.supports_tools;
		}
		return true;
	});
}

/**
 * Add a new model to the catalog, or replace an existing entry that shares the
 * same id.  This allows consumers to override built-in definitions or register
 * models from additional providers.
 */
export function registerModel(info: ModelInfo): void {
	const idx = catalog.findIndex((m) => m.id === info.id);
	if (idx !== -1) {
		catalog[idx] = info;
	} else {
		catalog.push(info);
	}
}
