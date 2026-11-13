/**
 * The flowchart source: mermaid text in, one graph out.
 *
 * The chart no longer has a model file of its own. What a person reads is the
 * fenced `mermaid` block inside `<id>.md`, and that block is also what the tools
 * edit and what the checks run on — one rendering, one truth, no second
 * representation that can drift.
 *
 * The subset is deliberately small so that a rejected chart gets a sentence
 * naming the line, not a parser stack trace:
 *
 * - a header line, `flowchart LR`
 * - node lines, `n1["说明"]`, and module nodes, `n4[["check<br/>入：…<br/>出：…"]]`
 * - edge lines, `n1 --> n2`, `n1 -->|条件| n2`, and the dotted variants `-.->` / `==>`
 *
 * Anything else in the block is refused with the line number, because a
 * construct the host does not understand is a construct it cannot check.
 *
 * @module dsh-spec-mode/mermaid-graph
 */

/** Longest a node label may run before it stops being readable at a glance. */
const LABEL_MAX_CHARS = 120;

/** Longest a module port may run. */
const PORT_MAX_CHARS = 60;

/** Node ids: a short, stable handle a reader can follow in the edge list. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

/** The separator mermaid draws a line break at, inside a label. */
export const LABEL_BREAK = '<br/>';

/** Wording that explains the flow instead of stating it. */
const REASON_RE = new RegExp(
	['为什么', '为何', '因为', '之所以', '权衡', '取舍', '背景', '动机', '被否决', '备选方案', '替代方案', '\\bwhy\\b', '\\bbecause\\b', '\\brationale\\b']
		.join('|'),
	'i',
);

/** A machine-specific absolute path: never in a product file. */
const LOCAL_PATH_RE = /(?:^|[\s(（`"'])(?:\/home\/|\/Users\/|\/storage\/|\/nix\/store\/|[A-Za-z]:[\\/])/;

/** A fenced code block, which the flow chart never carries. */
const CODE_FENCE_RE = /^\s*```/;

/** The header line, and the direction it names. */
const HEADER_RE = /^(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)$/;

/** The node shapes this parser reads, longest opening bracket first. */
const SHAPES = [
	{ open: '[[', close: ']]', module: true },
	{ open: '((', close: '))' },
	{ open: '{{', close: '}}' },
	{ open: '([', close: '])' },
	{ open: '[', close: ']' },
	{ open: '(', close: ')' },
	{ open: '{', close: '}' },
];

/** An arrow, and the optional `|condition|` that follows it on the same edge. */
const ARROW_RE = /\s*(-->|-.->|==>|---)\s*(?:\|([^|]*)\|\s*)?/;

/** Lines of a diagram that carry no graph and are dropped before parsing. */
const NOISE_RE = /^(?:classDef|class|style|linkStyle|click|direction)\b/;

/**
 * One problem with a node label, or `undefined` when it reads fine.
 * @param {string} label - the label text.
 * @param {string} path - where it came from, for the message.
 * @returns {string | undefined} the problem.
 */
function labelProblem(label, path) {
	if (label === '') return `${path}: 节点说明不能为空`;
	if (label.length > LABEL_MAX_CHARS) return `${path}: 超过 ${LABEL_MAX_CHARS} 字符，拆成两个节点`;
	if (label.includes('\n')) return `${path}: 只能一行，要分两步就拆成两个节点`;
	// The text sits inside mermaid's own quoting: a double quote ends the label and
	// an angle bracket starts markup, and `<br/>` is how a module box writes its ports.
	if (label.includes('"')) return `${path}: 含双引号；它会结束这个框的文字，换成「」`;
	if (label.includes('<')) return `${path}: 含 <；它会被当成标记，换行只由模块框的 <br/> 产生`;
	if (CODE_FENCE_RE.test(label) || /`[^`\n]*[(){}[\]=;<>][^`\n]*`/.test(label)) {
		return `${path}: 含代码；节点说明写人和模型看得懂的话，不写代码`;
	}
	const reason = REASON_RE.exec(label);
	if (reason !== null) return `${path}: 含「${reason[0]}」这类理由说明；流程图只写发生什么，不写为什么`;
	if (LOCAL_PATH_RE.test(label)) return `${path}: 含本机绝对路径`;
	return undefined;
}

/**
 * Split one module node's text into the chart it names and the ports that cross
 * the boundary.
 * @param {string} text - the text inside `[[ ]]`.
 * @returns {{ module: string, ports: string[] }} the parts.
 */
function splitModuleText(text) {
	const [first, ...rest] = text.split(LABEL_BREAK);
	return { module: (first ?? '').trim(), ports: rest.map((port) => port.trim()) };
}

/**
 * Read one node reference: an id, optionally followed by a shaped label.
 * @param {string} raw - the text between arrows.
 * @returns {{ id: string, shape?: object, text?: string } | { error: string }} the reference.
 */
function parseNodeRef(raw) {
	const text = raw.trim();
	const head = /^([A-Za-z][A-Za-z0-9_-]*)([\s\S]*)$/.exec(text);
	if (head === null) return { error: `看不懂的节点写法「${text}」` };
	const id = head[1];
	const rest = head[2].trim();
	if (rest === '') return { id };
	for (const shape of SHAPES) {
		if (!rest.startsWith(shape.open) || !rest.endsWith(shape.close) || rest.length < shape.open.length + shape.close.length) continue;
		const inner = rest.slice(shape.open.length, rest.length - shape.close.length).trim();
		const unquoted = inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
		return { id, shape, text: unquoted };
	}
	return { error: `节点 ${id} 的括号不成对「${rest}」` };
}

/**
 * Parse one line of a diagram into the reference it draws.
 * @param {string} line - one source line, already trimmed.
 * @returns {{ nodes: object[], arrows: {op: string, when?: string}[] } | { error: string }} the parts.
 */
function parseLine(line) {
	const nodes = [];
	const arrows = [];
	let rest = line;
	let guard = 0;
	while (rest !== '') {
		if (guard++ > 200) return { error: '这一行太长' };
		const arrow = ARROW_RE.exec(rest);
		const at = arrow === null ? -1 : arrow.index;
		const piece = at === -1 ? rest : rest.slice(0, at);
		const ref = parseNodeRef(piece);
		if (ref.error !== undefined) return { error: ref.error };
		nodes.push(ref);
		if (arrow === null) break;
		const label = (arrow[2] ?? '').trim();
		arrows.push(label === '' ? { op: arrow[1] } : { op: arrow[1], when: label });
		rest = rest.slice(at + arrow[0].length);
		if (rest === '') {
			return { error: '箭头后面少了节点' };
		}
	}
	if (nodes.length === 0) return { error: '这一行没有节点' };
	return { nodes, arrows };
}

/**
 * Parse a mermaid flowchart block into the graph the checks and the drawing use.
 *
 * @param {string} source - the fenced block's content.
 * @returns {{ ok: true, graph: { direction: string, nodes: object[], edges: object[] } } | { ok: false, errors: string[] }} the outcome.
 */
export function parseMermaid(source) {
	const lines = String(source ?? '').split(/\r?\n/);
	const errors = [];
	const nodes = [];
	const edges = [];
	const declared = new Map();
	let direction;
	let headerLine = 0;

	lines.forEach((rawLine, index) => {
		const lineNumber = index + 1;
		const line = rawLine.replace(/%%.*$/, '').trim();
		if (line === '') return;
		if (NOISE_RE.test(line)) return;

		const header = HEADER_RE.exec(line);
		if (header !== null) {
			if (direction !== undefined) errors.push(`第 ${lineNumber} 行: 只能有一个 flowchart 头`);
			else {
				direction = header[1];
				headerLine = lineNumber;
			}
			return;
		}
		if (direction === undefined) {
			errors.push(`第 ${lineNumber} 行: 第一行要是「flowchart LR」，它决定图的走向`);
			direction = 'LR';
		}
		if (/^(?:subgraph|end)$/.test(line)) {
			errors.push(`第 ${lineNumber} 行: 不支持 ${line.split(/\s/)[0]}；分层靠箭头，不靠子图分组`);
			return;
		}

		const parsed = parseLine(line);
		if (parsed.error !== undefined) {
			errors.push(`第 ${lineNumber} 行: ${parsed.error}`);
			return;
		}

		for (const ref of parsed.nodes) {
			const isModule = ref.shape?.module === true;
			if (ref.shape === undefined) {
				if (!declared.has(ref.id)) declared.set(ref.id, { id: ref.id, line: lineNumber, label: undefined });
				continue;
			}
			const previous = declared.get(ref.id);
			if (previous !== undefined && previous.label !== undefined) {
				errors.push(`第 ${lineNumber} 行: 节点 ${ref.id} 重复声明（第 ${previous.line} 行已经写过）`);
				continue;
			}
			const text = ref.text ?? '';
			if (isModule) {
				const { module, ports } = splitModuleText(text);
				if (!ID_RE.test(module)) {
					errors.push(`第 ${lineNumber} 行: 模块框的第一行要写它指向的图 id，收到「${module}」`);
					continue;
				}
				if (ports.length === 0) {
					errors.push(`第 ${lineNumber} 行: 模块框要写端口——至少一条进来的或出去的条件，否则读者不知道这个模块接在哪`);
					continue;
				}
				ports.forEach((port, portIndex) => {
					if (port === '') {
						errors.push(`第 ${lineNumber} 行: 模块框第 ${portIndex + 1} 条端口是空的`);
						return;
					}
					const problem = port.length > PORT_MAX_CHARS
						? `第 ${lineNumber} 行 端口「${port}」: 超过 ${PORT_MAX_CHARS} 字符，端口写的是进出这件事的条件，一句话就够`
						: labelProblem(port, `第 ${lineNumber} 行 端口「${port}」`);
					if (problem !== undefined) errors.push(problem);
				});
				nodes.push({ id: ref.id, module, ports, line: lineNumber });
			} else {
				const problem = labelProblem(text, `第 ${lineNumber} 行 节点 ${ref.id}`);
				if (problem !== undefined) errors.push(problem);
				nodes.push({ id: ref.id, label: text, line: lineNumber });
			}
			declared.set(ref.id, { id: ref.id, line: lineNumber, label: text });
		}

		for (let i = 0; i < parsed.arrows.length; i += 1) {
			const from = parsed.nodes[i];
			const to = parsed.nodes[i + 1];
			if (from === undefined || to === undefined) break;
			edges.push({ from: from.id, to: to.id, when: parsed.arrows[i].when, line: lineNumber });
		}
	});

	if (direction === undefined) errors.push('这一块里没有「flowchart LR」，它不是一张流程图');
	if (nodes.length < 2) errors.push('流程图至少两个节点');
	if (edges.length === 0) errors.push('流程图至少一条连线——只有节点没有连线，就不是一条流程');
	if (errors.length > 0) return { ok: false, errors };

	return { ok: true, graph: normalize({ nodes, edges, direction }) };
}

/**
 * Check and normalize the graph rules that need the whole picture: declared
 * ends, one entry, conditions only where the flow actually branches.
 *
 * @param {{ nodes: object[], edges: object[] }} graph - the parsed graph.
 * @param {{ knownModules?: Set<string> }} [options] - chart ids a module node may name.
 * @returns {{ ok: true, graph: object } | { ok: false, errors: string[] }} the outcome.
 */
export function validateGraph(graph, options = {}) {
	const errors = [];
	const known = options.knownModules;
	const ids = new Set(graph.nodes.map((node) => node.id));
	const seen = new Set();
	const labelOwners = new Map();

	for (const node of graph.nodes) {
		const where = node.line === undefined ? '节点' : `第 ${node.line} 行`;
		if (!ID_RE.test(node.id)) errors.push(`${where}: 节点 id「${node.id}」只能用字母、数字、下划线与短横，最多 16 位`);
		if (seen.has(node.id)) errors.push(`${where}: 重复的节点 id「${node.id}」`);
		seen.add(node.id);
		if (typeof node.module === 'string') {
			if (known !== undefined && !known.has(node.module)) {
				errors.push(`${where}: 图集里没有「${node.module}」这张图`);
			}
			continue;
		}
		const label = node.label ?? '';
		const owner = labelOwners.get(label);
		if (label !== '' && owner !== undefined) {
			errors.push(`${where}: 与 ${owner} 一字不差。两个框写同一句话，看图的人分不出谁是谁`);
		} else if (label !== '') {
			labelOwners.set(label, node.id);
		}
	}

	const edges = [];
	const keys = new Set();
	for (const edge of graph.edges) {
		const where = edge.line === undefined ? '连线' : `第 ${edge.line} 行`;
		if (!ids.has(edge.from)) errors.push(`${where}: 未声明的节点「${edge.from}」`);
		if (!ids.has(edge.to)) errors.push(`${where}: 未声明的节点「${edge.to}」`);
		if (edge.from === edge.to) errors.push(`${where}: ${edge.from} 连向了自己`);
		const key = `${edge.from}->${edge.to}`;
		if (keys.has(key)) errors.push(`${where}: 重复的连线 ${edge.from} → ${edge.to}`);
		keys.add(key);
		edges.push(edge);
	}
	if (errors.length > 0) return { ok: false, errors };

	const back = backEdgesOf({ nodes: graph.nodes, edges });

	// One entry, proven on the forward edges only: a loop edge always has a
	// forward path into its head, so it cannot create a second entry.
	const starts = graph.nodes
		.filter((node) => !edges.some((edge) => edge.to === node.id && !back.has(`${edge.from}->${edge.to}`)))
		.map((node) => node.id);
	if (starts.length > 1) {
		errors.push(`有 ${starts.length} 个起点（${starts.join('、')}）。一条流程只从一个框开始，先合并成一个起点`);
	}

	const branching = new Map();
	for (const edge of edges) branching.set(edge.from, (branching.get(edge.from) ?? 0) + 1);
	const conditions = new Map();
	for (const edge of edges) {
		const where = edge.line === undefined ? `${edge.from} → ${edge.to}` : `第 ${edge.line} 行`;
		if (branching.get(edge.from) > 1 && edge.when === undefined) {
			errors.push(`${where}: ${edge.from} 有两条以上出边，这条必须写条件——分叉条件只存在于图上，不写清楚，只看文字描述的人就对不上`);
		}
		if (branching.get(edge.from) === 1 && edge.when !== undefined) {
			errors.push(`${where}: ${edge.from} 只有这一条出边，不是分叉，不用写条件——写上去像在说「还有别的走法」，图上却只有一根箭头`);
		}
		if (edge.when === undefined) continue;
		const key = `${edge.from}\u0000${edge.when}`;
		if (conditions.has(key)) {
			errors.push(`${where}: ${edge.from} 的两条出边条件都写成「${edge.when}」，读者分不出走哪条`);
			continue;
		}
		conditions.set(key, true);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, graph: normalize({ nodes: graph.nodes, edges, direction: graph.direction }) };
}

/**
 * The edges that close a loop: the ones that point back at a step the walk has
 * already entered but not yet left.
 * @param {{ nodes: object[], edges: object[] }} flow - the graph.
 * @returns {Set<string>} `from->to` keys of the loop-closing edges.
 */
export function backEdgesOf(flow) {
	const outgoing = new Map(flow.nodes.map((node) => [node.id, []]));
	for (const edge of flow.edges) outgoing.get(edge.from)?.push(edge.to);
	const state = new Map();
	const back = new Set();
	const walk = (id) => {
		state.set(id, 1);
		for (const next of outgoing.get(id) ?? []) {
			const seen = state.get(next) ?? 0;
			if (seen === 1) back.add(`${id}->${next}`);
			else if (seen === 0) walk(next);
		}
		state.set(id, 2);
	};
	for (const node of flow.nodes) if ((state.get(node.id) ?? 0) === 0) walk(node.id);
	return back;
}

/**
 * Put one graph into its canonical shape: declaration order kept, line numbers
 * dropped, conditions kept only where they were written.
 * @param {object} graph - the graph.
 * @returns {{ direction: string, nodes: object[], edges: object[] }} the canonical graph.
 */
function normalize(graph) {
	return {
		direction: graph.direction ?? 'LR',
		// The line each box and arrow was written on travels with it: a chart the
		// checks refuse is a chart someone is editing by hand, and the number is what
		// turns "n2 → n3 has a branch without a condition" into a place to look.
		nodes: graph.nodes.map((node) => (typeof node.module === 'string'
			? { id: node.id, module: node.module, ports: [...node.ports], line: node.line }
			: { id: node.id, label: node.label ?? '', line: node.line })),
		edges: graph.edges.map((edge) => (edge.when === undefined
			? { from: edge.from, to: edge.to, line: edge.line }
			: { from: edge.from, to: edge.to, when: edge.when, line: edge.line })),
	};
}

/**
 * The text one node is written as.
 * @param {object} node - one node.
 * @returns {string} the line body.
 */
function nodeText(node) {
	if (typeof node.module === 'string') {
		return `${node.id}[["${[node.module, ...node.ports].join(LABEL_BREAK)}"]]`;
	}
	return `${node.id}["${node.label}"]`;
}

/**
 * Draw one graph back into mermaid source.
 * @param {{ direction?: string, nodes: object[], edges: object[] }} graph - the graph.
 * @returns {string} the source, without the fence.
 */
export function drawMermaid(graph) {
	const lines = [`flowchart ${graph.direction ?? 'LR'}`];
	for (const node of graph.nodes) lines.push(`  ${nodeText(node)}`);
	for (const edge of graph.edges) {
		lines.push(edge.when === undefined ? `  ${edge.from} --> ${edge.to}` : `  ${edge.from} -->|${edge.when}| ${edge.to}`);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The source with every module box carrying the name of the chart it points at.
 *
 * The name lives in exactly one place — the target chart — and is copied here at
 * draw time, so renaming that chart renames every place it appears.
 *
 * @param {{ direction?: string, nodes: object[], edges: object[] }} graph - the graph.
 * @param {(id: string) => string | undefined} nameOf - a chart's name by id.
 * @returns {string} the mermaid source the view renders.
 */
export function drawMermaidNamed(graph, nameOf) {
	const renamed = {
		direction: graph.direction,
		nodes: graph.nodes.map((node) => {
			if (typeof node.module !== 'string') return node;
			return { ...node, module: nameOf(node.module) ?? `${node.module}（缺图）`, ports: node.ports };
		}),
		edges: graph.edges,
	};
	return drawMermaid(renamed);
}
