import type { Request, Response, StreamEvent, ToolChoiceMode } from "../types.js";

export interface ProviderAdapterConfig {
	api_key: string;
	base_url?: string;
	default_headers?: Record<string, string>;
	timeout?: number;
}

export interface ProviderAdapter {
	readonly name: string;

	complete(request: Request): Promise<Response>;
	stream(request: Request): AsyncIterableIterator<StreamEvent>;

	close?(): Promise<void>;
	initialize?(): Promise<void>;
	supports_tool_choice?(mode: ToolChoiceMode): boolean;
}
