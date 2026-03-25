export interface SSEEvent {
	event?: string;
	data: string;
	id?: string;
	retry?: number;
}

export async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncIterableIterator<SSEEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				break;
			}

			const { done, value } = await reader.read();
			if (done) {
				// Flush any remaining bytes from the decoder
				buffer += decoder.decode(new Uint8Array(0), { stream: false });
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			// Last element is the incomplete line; keep it in the buffer
			buffer = lines.pop()!;

			let event: string | undefined;
			let data: string[] = [];
			let id: string | undefined;
			let retry: number | undefined;

			for (const line of lines) {
				if (line === "") {
					// Empty line — dispatch the event if we have data
					if (data.length > 0) {
						const joined = data.join("\n");
						if (joined === "[DONE]") {
							return;
						}
						yield { event, data: joined, id, retry };
					}
					event = undefined;
					data = [];
					id = undefined;
					retry = undefined;
				} else if (line.startsWith(":")) {
					// Comment — ignore
				} else if (line.startsWith("data:")) {
					const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
					data.push(value);
				} else if (line.startsWith("event:")) {
					event = line.startsWith("event: ") ? line.slice(7) : line.slice(6);
				} else if (line.startsWith("id:")) {
					id = line.startsWith("id: ") ? line.slice(4) : line.slice(3);
				} else if (line.startsWith("retry:")) {
					const raw = line.startsWith("retry: ") ? line.slice(7) : line.slice(6);
					const parsed = Number.parseInt(raw, 10);
					if (!Number.isNaN(parsed)) {
						retry = parsed;
					}
				}
			}
		}

		// Handle remaining data in buffer after stream ends
		if (buffer.length > 0) {
			// Process any trailing content that wasn't terminated by a newline
			if (buffer.startsWith("data:")) {
				const value = buffer.startsWith("data: ") ? buffer.slice(6) : buffer.slice(5);
				if (value !== "[DONE]") {
					yield { data: value };
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
