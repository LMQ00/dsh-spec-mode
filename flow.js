/**
 * The functional flow chart: the product a person reads.
 *
 * What lands is an image (`flow.png`, drawn by `flow-svg.js` and rasterized by
 * `rasterize.js`). This module supplies the half the image cannot: the graph the
 * image is drawn from is validated here, so a cycle, a dangling edge or a
 * code-carrying label is refused before anything is written.
 *
 * Nodes say who does what in everyday words; edges say what happens next.
 * Nothing about the reasoning behind the flow goes in, and no source file names:
 * a reader who does not read the code must still be able to follow the picture.
 *
 * The graph has exactly one entry and may contain loops: a step that has to be
 * repeated is drawn as an arrow back to the step it returns to, because that is
 * what the reader needs to see — unrolling the loop once would make the picture
 * claim the procedure runs it once.
 *
 * @module dsh-spec-mode/flow
 */

/** Longest a node label may run before it stops being readable at a glance. */
const LABEL_MAX_CHARS = 120;

/** Node ids: a short, stable handle a reader can follow in the edge list. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

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

/**
 * One problem with a node label, or `undefined` when it reads fine.
 * @param {string} label - the trimmed label.
 * @param {string} path - the field path, for the message.
 * @returns {string | undefined} the problem.
 */
function labelProblem(label, path) {
	if (label === '') return `${path}: 节点说明不能为空`;
	if (label.length > LABEL_MAX_CHARS) return `${path}: 超过 ${LABEL_MAX_CHARS} 字符，拆成两个节点`;
	// A label is written on one `- N1 …` line: a line break would render as a
	// second line the parser cannot attribute to the node, so the tail would be
	// lost at landing time.
	if (label.includes('\n')) return `${path}: 只能一行，要分两步就拆成两个节点`;
	if (CODE_FENCE_RE.test(label) || /`[^`\n]*[(){}[\]=;<>][^`\n]*`/.test(label)) {
		return `${path}: 含代码；节点说明写人和模型看得懂的话，不写代码`;
	}
	const reason = REASON_RE.exec(label);
	if (reason !== null) return `${path}: 含「${reason[0]}」这类理由说明；流程图只写发生什么，不写为什么`;
	if (LOCAL_PATH_RE.test(label)) return `${path}: 含本机绝对路径`;
	return undefined;
}

/**
 * The edges that close a loop: the ones that point back at a step the walk has
 * already entered but not yet left.
 *
 * A procedure with a retry is a loop, and a loop is what the reader has to see —
 * drawing the retry out once makes the picture claim it happens once. The layering
 * in `flow-svg.js` needs the same set: a loop edge cannot decide a row, or no row
 * could ever be assigned.
 *
 * Depth-first, from the declaration order, so the answer is stable for one graph.
 *
 * @param {{ nodes: object[], edges: object[] }} flow - the flow.
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
			// 1 means "on the stack right now": reaching it again closes a loop.
			if (seen === 1) back.add(`${id}->${next}`);
			else if (seen === 0) walk(next);
		}
		state.set(id, 2);
	};
	for (const node of flow.nodes) if ((state.get(node.id) ?? 0) === 0) walk(node.id);
	return back;
}

/**
 * Validate and normalize one flow chart.
 * @param {unknown} input - the model-supplied `{ nodes, edges }`.
 * @returns {{ ok: true, flow: { nodes: object[], edges: object[] } } | { ok: false, errors: string[] }} the outcome.
 */
export function validateFlow(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, errors: ['flow: 必须是 { nodes: [{id,label}], edges: [{from,to,when?}] }'] };
	}
	const errors = [];
	const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
	const rawEdges = Array.isArray(input.edges) ? input.edges : [];
	if (rawNodes.length < 2) errors.push('flow.nodes: 至少两个节点');

	const nodes = [];
	const seen = new Set();
	const labelOwners = new Map();
	rawNodes.forEach((node, index) => {
		const path = `flow.nodes[${index}]`;
		if (node === null || typeof node !== 'object') {
			errors.push(`${path}: 必须是 { id, label }`);
			return;
		}
		const id = typeof node.id === 'string' ? node.id.trim() : '';
		const label = typeof node.label === 'string' ? node.label.trim() : '';
		if (!ID_RE.test(id)) {
			errors.push(`${path}.id: 需匹配 [A-Za-z][A-Za-z0-9_-]{0,15}，收到「${id}」`);
		} else if (seen.has(id)) {
			errors.push(`${path}.id: 重复的节点 id「${id}」`);
		} else {
			seen.add(id);
		}
		// Two boxes with the same words are indistinguishable in the picture, so a
		// reader cannot tell which arrow belongs to which step.
		const owner = labelOwners.get(label);
		if (label !== '' && owner !== undefined) {
			errors.push(`${path}.label: 与 ${owner} 一字不差。两个框写同一句话，看图的人分不出谁是谁`);
		} else if (label !== '') {
			labelOwners.set(label, id);
		}
		const problem = labelProblem(label, `${path}.label`);
		if (problem !== undefined) errors.push(problem);
		nodes.push({ id, label });
	});

	const edges = [];
	const edgeKeys = new Set();
	rawEdges.forEach((edge, index) => {
		const path = `flow.edges[${index}]`;
		if (edge === null || typeof edge !== 'object') {
			errors.push(`${path}: 必须是 { from, to, when? }`);
			return;
		}
		const from = typeof edge.from === 'string' ? edge.from.trim() : '';
		const to = typeof edge.to === 'string' ? edge.to.trim() : '';
		let when;
		if (edge.when !== undefined && edge.when !== null && edge.when !== '') {
			if (typeof edge.when !== 'string') errors.push(`${path}.when: 必须是字符串`);
			else {
				const problem = labelProblem(edge.when.trim(), `${path}.when`);
				if (problem !== undefined) errors.push(problem);
				when = edge.when.trim();
			}
		}
		if (!seen.has(from)) errors.push(`${path}.from: 未声明的节点「${from}」`);
		if (!seen.has(to)) errors.push(`${path}.to: 未声明的节点「${to}」`);
		if (from !== '' && from === to) errors.push(`${path}: 节点不能连向自己`);
		const key = `${from}->${to}`;
		if (seen.has(from) && seen.has(to) && edgeKeys.has(key)) errors.push(`${path}: 重复的连线 ${from} -> ${to}`);
		edgeKeys.add(key);
		edges.push(when === undefined ? { from, to } : { from, to, when });
	});

	if (errors.length > 0) return { ok: false, errors };

	if (rawEdges.length === 0) {
		return { ok: false, errors: ['flow.edges: 至少一条连线——只有节点没有连线，就不是一条流程'] };
	}

	// A loop is allowed and must not be unrolled: a retry is drawn as an arrow
	// back to the step it returns to, so the picture says "this can happen again"
	// rather than "this happens once". Layering and layout skip these edges — see
	// `backEdgesOf` — so a loop never makes the picture unrunnable.
	const back = backEdgesOf({ nodes, edges });

	// One entry, proven on the forward edges only: a loop edge always has a
	// forward path into its head, so it cannot create a second entry.
	const starts = nodes.filter((node) => !edges.some((edge) => edge.to === node.id && !back.has(`${edge.from}->${edge.to}`))).map((node) => node.id);
	if (starts.length > 1) {
		errors.push(`flow: 有 ${starts.length} 个起点（${starts.join('、')}）。一条流程只从一个框开始，先合并成一个起点`);
	}
	if (errors.length > 0) return { ok: false, errors };

	// A branch has to say what makes it go each way. The picture and the brief are
	// two renderings of one procedure, and the condition on the arrow is the one
	// place they can disagree without anyone noticing: the box text is checked by
	// both, the condition lives only in the picture.
	const branching = new Map();
	for (const edge of edges) branching.set(edge.from, (branching.get(edge.from) ?? 0) + 1);
	const conditions = new Map();
	edges.forEach((edge, index) => {
		if (branching.get(edge.from) > 1 && edge.when === undefined) {
			errors.push(
				`flow.edges[${index}]: ${edge.from} 有两条以上出边，这条必须写 when——` 
				+ '分叉条件只存在于图上，不写清楚，只看文字描述的人就对不上',
			);
		}
		// A single way out is not a branch: a condition there is drawn as a label
		// the reader will look for and never find a second branch for.
		if (branching.get(edge.from) === 1 && edge.when !== undefined) {
			errors.push(
				`flow.edges[${index}].when: ${edge.from} 只有这一条出边，不是分叉，不用写 when——`
				+ '写上去像在说「还有别的走法」，图上却只有一根箭头',
			);
		}
		if (edge.when === undefined) return;
		// Two arrows leaving the same box under the same words cannot be told
		// apart: the reader has no way to decide which one applies.
		const key = `${edge.from}\u0000${edge.when}`;
		const previous = conditions.get(key);
		if (previous !== undefined) {
			errors.push(
				`flow.edges[${index}].when: ${edge.from} 的两条出边条件都写成「${edge.when}」，`
				+ '读者分不出走哪条',
			);
			return;
		}
		conditions.set(key, index);
	});
	if (errors.length > 0) return { ok: false, errors };

	return { ok: true, flow: { nodes, edges } };
}
