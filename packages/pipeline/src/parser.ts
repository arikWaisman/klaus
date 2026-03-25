import type {
	Edge,
	EdgeAttributes,
	FidelityMode,
	Graph,
	GraphAttributes,
	Node,
	NodeAttributes,
	Subgraph,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shape-to-handler-type mapping
// ---------------------------------------------------------------------------

const SHAPE_TO_TYPE: Record<string, string> = {
	mdiamond: "start",
	msquare: "exit",
	box: "codergen",
	hexagon: "wait.human",
	diamond: "conditional",
	component: "parallel",
	tripleoctagon: "parallel.fan_in",
	parallelogram: "tool",
	house: "stack.manager_loop",
};

function inferType(shape: string | undefined): string | undefined {
	if (!shape) return undefined;
	return SHAPE_TO_TYPE[shape.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type TokenKind = "word" | "string" | "symbol";

interface Token {
	kind: TokenKind;
	value: string;
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

function stripComments(input: string): string {
	let result = "";
	let i = 0;
	const len = input.length;

	while (i < len) {
		// Inside a quoted string -- pass through as-is
		if (input[i] === '"') {
			result += '"';
			i++;
			while (i < len && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < len) {
					result += input[i] + input[i + 1];
					i += 2;
				} else {
					result += input[i];
					i++;
				}
			}
			if (i < len) {
				result += '"';
				i++;
			}
			continue;
		}

		// Line comment
		if (input[i] === "/" && i + 1 < len && input[i + 1] === "/") {
			i += 2;
			while (i < len && input[i] !== "\n") {
				i++;
			}
			continue;
		}

		// Block comment
		if (input[i] === "/" && i + 1 < len && input[i + 1] === "*") {
			i += 2;
			while (i < len && !(input[i] === "*" && i + 1 < len && input[i + 1] === "/")) {
				i++;
			}
			if (i < len) {
				i += 2; // skip */
			}
			continue;
		}

		result += input[i];
		i++;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const len = input.length;

	while (i < len) {
		// Skip whitespace
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}

		// Quoted string
		if (input[i] === '"') {
			i++; // skip opening quote
			let str = "";
			while (i < len && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < len) {
					const next = input[i + 1];
					if (next === '"') {
						str += '"';
					} else if (next === "\\") {
						str += "\\";
					} else if (next === "n") {
						str += "\n";
					} else if (next === "t") {
						str += "\t";
					} else {
						str += next;
					}
					i += 2;
				} else {
					str += input[i];
					i++;
				}
			}
			if (i < len) {
				i++; // skip closing quote
			}
			tokens.push({ kind: "string", value: str });
			continue;
		}

		// Symbols: -> [ ] { } ; = ,
		if (input[i] === "-" && i + 1 < len && input[i + 1] === ">") {
			tokens.push({ kind: "symbol", value: "->" });
			i += 2;
			continue;
		}

		if ("[]{}=;,".includes(input[i])) {
			tokens.push({ kind: "symbol", value: input[i] });
			i++;
			continue;
		}

		// Word (identifier, keyword, number, bare value)
		if (/[a-zA-Z0-9_.\-+]/.test(input[i])) {
			let word = "";
			while (i < len && /[a-zA-Z0-9_.\-+:]/.test(input[i])) {
				word += input[i];
				i++;
			}
			tokens.push({ kind: "word", value: word });
			continue;
		}

		// Skip unknown characters
		i++;
	}

	return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
	private tokens: Token[];
	private pos: number;

	private graphName = "";
	private graphAttrs: GraphAttributes = {};
	private nodes: Map<string, Node> = new Map();
	private edges: Edge[] = [];
	private subgraphs: Subgraph[] = [];

	private defaultNodeAttrs: Record<string, string> = {};
	private defaultEdgeAttrs: Record<string, string> = {};

	constructor(tokens: Token[]) {
		this.tokens = tokens;
		this.pos = 0;
	}

	// -- Helpers -------------------------------------------------------------

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private advance(): Token {
		const t = this.tokens[this.pos];
		if (!t) {
			throw new Error("Unexpected end of input");
		}
		this.pos++;
		return t;
	}

	private expect(kind: TokenKind, value?: string): Token {
		const t = this.advance();
		if (t.kind !== kind || (value !== undefined && t.value !== value)) {
			throw new Error(
				`Expected ${kind}${value ? ` '${value}'` : ""} but got ${t.kind} '${t.value}'`,
			);
		}
		return t;
	}

	private match(kind: TokenKind, value?: string): boolean {
		const t = this.peek();
		if (!t) return false;
		if (t.kind !== kind) return false;
		if (value !== undefined && t.value !== value) return false;
		this.pos++;
		return true;
	}

	private isAtEnd(): boolean {
		return this.pos >= this.tokens.length;
	}

	private skipSemicolons(): void {
		while (this.match("symbol", ";")) {
			// consume
		}
	}

	// -- Attribute parsing ---------------------------------------------------

	private parseAttributeList(): Record<string, string> {
		const attrs: Record<string, string> = {};
		this.expect("symbol", "[");

		while (!this.isAtEnd()) {
			const t = this.peek();
			if (t && t.kind === "symbol" && t.value === "]") {
				this.advance();
				return attrs;
			}

			// Optional comma/semicolon separator between attrs
			if (t && t.kind === "symbol" && (t.value === "," || t.value === ";")) {
				this.advance();
				continue;
			}

			const key = this.advance();
			if (key.kind !== "word" && key.kind !== "string") {
				throw new Error(`Expected attribute key, got ${key.kind} '${key.value}'`);
			}

			this.expect("symbol", "=");

			const val = this.advance();
			attrs[key.value] = val.value;
		}

		throw new Error("Unterminated attribute list");
	}

	private hasAttributeList(): boolean {
		const t = this.peek();
		return t !== undefined && t.kind === "symbol" && t.value === "[";
	}

	// -- Attribute coercion --------------------------------------------------

	private coerceValue(value: string): string | number | boolean {
		// Boolean
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;

		// Integer
		if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);

		// Float
		if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);

		return value;
	}

	private buildNodeAttributes(
		raw: Record<string, string>,
		defaults: Record<string, string>,
	): NodeAttributes {
		const merged = { ...defaults, ...raw };
		const attrs: NodeAttributes = {};

		for (const [key, val] of Object.entries(merged)) {
			const coerced = this.coerceValue(val);
			switch (key) {
				case "label":
					attrs.label = String(coerced);
					break;
				case "shape":
					attrs.shape = String(coerced).toLowerCase();
					break;
				case "type":
					attrs.type = String(coerced);
					break;
				case "prompt":
					attrs.prompt = String(coerced);
					break;
				case "max_retries":
					attrs.max_retries = typeof coerced === "number" ? coerced : Number.parseInt(val, 10);
					break;
				case "goal_gate":
					attrs.goal_gate = coerced === true || val.toLowerCase() === "true";
					break;
				case "fidelity":
					attrs.fidelity = String(coerced) as FidelityMode;
					break;
				case "thread_id":
					attrs.thread_id = String(coerced);
					break;
				case "class":
					attrs.class = String(coerced);
					break;
				case "timeout":
					attrs.timeout = String(coerced);
					break;
				case "llm_model":
					attrs.llm_model = String(coerced);
					break;
				case "llm_provider":
					attrs.llm_provider = String(coerced);
					break;
				case "reasoning_effort":
					attrs.reasoning_effort = String(coerced);
					break;
				case "auto_status":
					attrs.auto_status = coerced === true || val.toLowerCase() === "true";
					break;
				case "allow_partial":
					attrs.allow_partial = coerced === true || val.toLowerCase() === "true";
					break;
				case "tool_command":
					attrs.tool_command = String(coerced);
					break;
				case "max_parallel":
					attrs.max_parallel = typeof coerced === "number" ? coerced : Number.parseInt(val, 10);
					break;
				// Ignore unknown attributes silently
			}
		}

		return attrs;
	}

	private buildEdgeAttributes(
		raw: Record<string, string>,
		defaults: Record<string, string>,
	): EdgeAttributes {
		const merged = { ...defaults, ...raw };
		const attrs: EdgeAttributes = {};

		for (const [key, val] of Object.entries(merged)) {
			const coerced = this.coerceValue(val);
			switch (key) {
				case "label":
					attrs.label = String(coerced);
					break;
				case "condition":
					attrs.condition = String(coerced);
					break;
				case "weight":
					attrs.weight = typeof coerced === "number" ? coerced : Number.parseFloat(val);
					break;
				case "fidelity":
					attrs.fidelity = String(coerced) as FidelityMode;
					break;
				case "thread_id":
					attrs.thread_id = String(coerced);
					break;
				case "loop_restart":
					attrs.loop_restart = coerced === true || val.toLowerCase() === "true";
					break;
				// Ignore unknown attributes silently
			}
		}

		return attrs;
	}

	private buildGraphAttributes(raw: Record<string, string>): GraphAttributes {
		const attrs: GraphAttributes = {};

		for (const [key, val] of Object.entries(raw)) {
			const coerced = this.coerceValue(val);
			switch (key) {
				case "goal":
					attrs.goal = String(coerced);
					break;
				case "label":
					attrs.label = String(coerced);
					break;
				case "model_stylesheet":
					attrs.model_stylesheet = String(coerced);
					break;
				case "default_max_retries":
					attrs.default_max_retries =
						typeof coerced === "number" ? coerced : Number.parseInt(val, 10);
					break;
				case "retry_target":
					attrs.retry_target = String(coerced);
					break;
				case "default_fidelity":
					attrs.default_fidelity = String(coerced) as FidelityMode;
					break;
			}
		}

		return attrs;
	}

	// -- Node management -----------------------------------------------------

	private ensureNode(id: string): Node {
		let node = this.nodes.get(id);
		if (!node) {
			node = { id, attributes: {} };
			this.nodes.set(id, node);
		}
		return node;
	}

	private resolveNodeType(node: Node): void {
		// Explicit type takes precedence
		if (node.attributes.type) return;

		const inferred = inferType(node.attributes.shape);
		if (inferred) {
			node.attributes.type = inferred;
		}
	}

	// -- Statement parsing ---------------------------------------------------

	private parseStatements(
		localNodeDefaults: Record<string, string>,
		localEdgeDefaults: Record<string, string>,
	): void {
		while (!this.isAtEnd()) {
			this.skipSemicolons();

			const t = this.peek();
			if (!t) break;

			// End of block
			if (t.kind === "symbol" && t.value === "}") break;

			// Subgraph
			if (t.kind === "word" && t.value === "subgraph") {
				this.parseSubgraph(localNodeDefaults, localEdgeDefaults);
				continue;
			}

			// graph [...]
			if (t.kind === "word" && t.value === "graph" && this.looksLikeAttrList()) {
				this.advance();
				const raw = this.parseAttributeList();
				this.graphAttrs = {
					...this.graphAttrs,
					...this.buildGraphAttributes(raw),
				};
				this.skipSemicolons();
				continue;
			}

			// Default node attrs: node [...]
			if (t.kind === "word" && t.value === "node" && this.looksLikeAttrList()) {
				this.advance();
				const raw = this.parseAttributeList();
				Object.assign(localNodeDefaults, raw);
				this.skipSemicolons();
				continue;
			}

			// Default edge attrs: edge [...]
			if (t.kind === "word" && t.value === "edge" && this.looksLikeAttrList()) {
				this.advance();
				const raw = this.parseAttributeList();
				Object.assign(localEdgeDefaults, raw);
				this.skipSemicolons();
				continue;
			}

			// Must be a node or edge statement
			if (t.kind === "word" || t.kind === "string") {
				this.parseNodeOrEdgeStatement(localNodeDefaults, localEdgeDefaults);
				continue;
			}

			// Skip unexpected tokens
			this.advance();
		}
	}

	private looksLikeAttrList(): boolean {
		const next = this.tokens[this.pos + 1];
		return next !== undefined && next.kind === "symbol" && next.value === "[";
	}

	private parseNodeOrEdgeStatement(
		nodeDefaults: Record<string, string>,
		edgeDefaults: Record<string, string>,
	): void {
		const firstName = this.advance().value;
		const chain: string[] = [firstName];

		// Collect chain: a -> b -> c ...
		while (this.match("symbol", "->")) {
			const next = this.advance();
			chain.push(next.value);
		}

		// Optional attribute list
		const rawAttrs = this.hasAttributeList() ? this.parseAttributeList() : {};

		if (chain.length === 1) {
			// Node declaration
			const id = chain[0];
			const node = this.ensureNode(id);
			node.attributes = {
				...node.attributes,
				...this.buildNodeAttributes(rawAttrs, nodeDefaults),
			};
		} else {
			// Edge chain: ensure all nodes exist and create edges
			for (const id of chain) {
				this.ensureNode(id);
			}

			for (let i = 0; i < chain.length - 1; i++) {
				this.edges.push({
					from: chain[i],
					to: chain[i + 1],
					attributes: this.buildEdgeAttributes(rawAttrs, edgeDefaults),
				});
			}
		}

		this.skipSemicolons();
	}

	private parseSubgraph(
		parentNodeDefaults: Record<string, string>,
		parentEdgeDefaults: Record<string, string>,
	): void {
		this.expect("word", "subgraph");

		let name: string | undefined;
		const t = this.peek();
		if (t && t.kind === "word") {
			name = this.advance().value;
		}

		this.expect("symbol", "{");

		// Subgraph inherits parent defaults
		const localNodeDefaults = { ...parentNodeDefaults };
		const localEdgeDefaults = { ...parentEdgeDefaults };

		const nodesBefore = new Set(this.nodes.keys());

		this.parseStatements(localNodeDefaults, localEdgeDefaults);

		this.expect("symbol", "}");

		// Collect node IDs added in this subgraph
		const nodesAfter = new Set(this.nodes.keys());
		const subgraphNodeIds: string[] = [];
		for (const id of nodesAfter) {
			if (!nodesBefore.has(id)) {
				subgraphNodeIds.push(id);
			}
		}

		const subgraph: Subgraph = {
			name,
			defaults: { ...localNodeDefaults },
			node_ids: subgraphNodeIds,
		};

		this.subgraphs.push(subgraph);
	}

	// -- Top-level -----------------------------------------------------------

	parse(): Graph {
		this.expect("word", "digraph");

		const nameToken = this.peek();
		if (nameToken && nameToken.kind === "word") {
			this.graphName = this.advance().value;
		}

		this.expect("symbol", "{");

		this.parseStatements(this.defaultNodeAttrs, this.defaultEdgeAttrs);

		this.expect("symbol", "}");

		// Resolve handler types from shapes for all nodes
		for (const node of this.nodes.values()) {
			this.resolveNodeType(node);
		}

		return {
			name: this.graphName,
			attributes: this.graphAttrs,
			nodes: this.nodes,
			edges: this.edges,
			subgraphs: this.subgraphs,
		};
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a DOT-language string (Graphviz `digraph` subset) into a `Graph`
 * object. Supports graph/node/edge attributes, chained edges, subgraphs,
 * and both line and block comments.
 */
export function parseDOT(input: string): Graph {
	const cleaned = stripComments(input);
	const tokens = tokenize(cleaned);
	const parser = new Parser(tokens);
	return parser.parse();
}
