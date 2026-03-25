/**
 * A simple FIFO queue for steering and follow-up messages.
 */
export class MessageQueue {
	private queue: string[] = [];

	push(message: string): void {
		this.queue.push(message);
	}

	drain(): string[] {
		const messages = this.queue.splice(0);
		return messages;
	}

	isEmpty(): boolean {
		return this.queue.length === 0;
	}

	get length(): number {
		return this.queue.length;
	}
}
