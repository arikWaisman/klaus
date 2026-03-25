import { describe, expect, it } from "vitest";
import { StreamAccumulator } from "../../src/accumulator.js";
import { AnthropicAdapter } from "../../src/adapters/anthropic.js";
import { Client } from "../../src/client.js";
import { stream, generate } from "../../src/generate.js";
import { responseText, responseToolCalls } from "../../src/types.js";

declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)("Anthropic Integration", () => {
	function createClient(): Client {
		return new Client({
			adapters: {
				anthropic: new AnthropicAdapter({ api_key: apiKey! }),
			},
			default_provider: "anthropic",
		});
	}

	it("completes a simple text prompt", async () => {
		const client = createClient();
		const response = await client.complete({
			model: "claude-sonnet-4-5-20250929",
			messages: [
				{
					role: "user",
					content: [{ kind: "text", text: "Say hello in exactly 3 words." }],
				},
			],
		});

		expect(response.provider).toBe("anthropic");
		expect(response.model).toContain("claude");
		const text = responseText(response);
		expect(text.length).toBeGreaterThan(0);
		expect(response.usage.input_tokens).toBeGreaterThan(0);
		expect(response.usage.output_tokens).toBeGreaterThan(0);
	}, 30000);

	it("streams a response", async () => {
		const client = createClient();
		const acc = new StreamAccumulator();
		let eventCount = 0;

		for await (const event of client.stream({
			model: "claude-sonnet-4-5-20250929",
			messages: [
				{
					role: "user",
					content: [{ kind: "text", text: "Count from 1 to 3." }],
				},
			],
		})) {
			acc.push(event);
			eventCount++;
		}

		expect(eventCount).toBeGreaterThan(0);
		const response = acc.response();
		expect(acc.getText().length).toBeGreaterThan(0);
		expect(response.finish_reason.reason).toBe("stop");
	}, 30000);

	it("handles tool use", async () => {
		const client = createClient();
		const result = await generate({
			client,
			model: "claude-sonnet-4-5-20250929",
			prompt: "What is the weather in San Francisco?",
			tools: [
				{
					name: "get_weather",
					description: "Get current weather for a location",
					parameters: {
						type: "object",
						properties: {
							location: { type: "string", description: "City name" },
						},
						required: ["location"],
					},
					execute: async (args) => {
						return JSON.stringify({ temperature: 72, condition: "sunny" });
					},
				},
			],
			max_tool_rounds: 1,
		});

		expect(result.steps.length).toBeGreaterThanOrEqual(1);
		expect(result.total_usage.input_tokens).toBeGreaterThan(0);
		expect(result.text.length).toBeGreaterThan(0);
	}, 60000);

	it("generates with high-level stream()", async () => {
		const client = createClient();
		const result = stream({
			client,
			model: "claude-sonnet-4-5-20250929",
			prompt: "Say hello.",
		});

		const chunks: string[] = [];
		for await (const text of result.text_stream) {
			chunks.push(text);
		}

		expect(chunks.length).toBeGreaterThan(0);
		const response = await result.response();
		expect(response.finish_reason.reason).toBe("stop");
	}, 30000);
});
