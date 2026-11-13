/**
 * The chart collection: every file in `.spec/flows/`, the references between
 * them, and the checks that only make sense once more than one chart exists.
 *
 * One chart is one markdown file — its title, its scope, its mermaid block and
 * its brief — so a chart is a document rather than a name to look up. The
 * collection is what turns a folder of documents into a set: a project keeps one
 * overview of what the product does and one document per module, and the reader
 * can tell which is which without opening a conversation log.
 *
 * The overview is the chart filed as `overview`. That is the one id the
 * collection reserves, and it is what makes 「exactly one overview」 a fact about
 * the folder instead of a field every writer has to remember to copy.
 *
 * @module dsh-spec-mode/flows
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHART_EXT, canonicalMarkdown, chartPath, graphOf, parseChartMarkdown, revisionOf } from './chart-md.js';
import { drawMermaidNamed } from './mermaid-graph.js';

export { CHART_EXT, FLOWS_DIR, chartPath } from './chart-md.js';

/** The id the overview is filed under. */
export const OVERVIEW = 'overview';

/** The other kind: a chart some parent chart points at. */
export const MODULE = 'module';

/** A chart id: the file stem, so it has to be safe on every platform and stable. */
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** A diagram with more top-level modules than this stops being readable at one glance. */
export const TOP_MODULE_WARN = 6;

/** Longest a chart's name may run, and longest its scope line may run. */
const NAME_MAX_CHARS = 40;
const SCOPE_MAX_CHARS = 160;

/**
 * Wording that leaves the scope open, which is the one thing the field exists to
 * prevent: a chart that says 「本次相关」 is back to being unlabelled.
 */
const VAGUE_SCOPE_RE = /(本次|相关|等等|之类|若干|一些)/;

/**
 * The kind of chart an id names.
 * @param {string} id - the chart id.
 * @returns {string} `overview` or `module`.
 */
export function kindOf(id) {
	return id === OVERVIEW ? OVERVIEW : MODULE;
}

/**
 * Absolute path of the collection directory.
 * @param {string} specDir - the absolute `.spec` directory.
 * @returns {string} the path.
 */
export function flowsDirPath(specDir) {
	return join(specDir, 'flows');
}

/**
 * Create the collection directory when it is missing.
 * @param {string} specDir - the absolute `.spec` directory.
 */
export function ensureFlowsDir(specDir) {
	try {
		mkdirSync(flowsDirPath(specDir), { recursive: true });
	} catch {
		// A concurrent creation or an unwritable parent surfaces later as a tool error.
	}
}

/**
 * The ids present on disk, in file order.
 * @param {string} specDir - the absolute `.spec` directory.
 * @returns {string[]} the ids.
 */
export function listChartIds(specDir) {
	try {
		return readdirSync(flowsDirPath(specDir))
			.filter((entry) => entry.endsWith(CHART_EXT))
			.map((entry) => entry.slice(0, -CHART_EXT.length))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Read one chart, or `undefined` when the file is missing.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {{ chart: object, graph: object, revision: string } | { broken: string } | undefined} the chart.
 */
export function readChart(specDir, id) {
	const path = chartPath(specDir, id);
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
	const parsed = parseChartMarkdown(id, text);
	if (parsed.broken !== undefined) return { broken: parsed.broken };
	const graph = graphOf(parsed.chart);
	if (!graph.ok) return { broken: `${id}${CHART_EXT} 画不出来：${graph.errors.join('；')}` };
	return { chart: parsed.chart, graph: graph.graph, revision: revisionOf(text) };
}

/**
 * Read the whole collection. A chart whose file will not parse is reported but
 * does not abort the read: the reader still sees the rest.
 * @param {string} specDir - the absolute `.spec` directory.
 * @returns {{ charts: Map<string, object>, problems: string[] }} the collection.
 */
export function readCollection(specDir) {
	const charts = new Map();
	const problems = [];
	for (const id of listChartIds(specDir)) {
		const read = readChart(specDir, id);
		if (read === undefined) continue;
		if (read.broken !== undefined) {
			problems.push(read.broken);
			continue;
		}
		charts.set(id, read);
	}
	return { charts, problems };
}

/**
 * Read one chart's brief, or `''` when the file or the section is missing.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the brief text.
 */
export function readChartBrief(specDir, id) {
	try {
		const parsed = parseChartMarkdown(id, readFileSync(chartPath(specDir, id), 'utf8'));
		return parsed.chart?.brief ?? '';
	} catch {
		return '';
	}
}

/**
 * The charts that point at one chart.
 * @param {Map<string, object>} charts - id → entry, for every chart.
 * @param {string} id - the chart being looked up.
 * @returns {string[]} the parent ids.
 */
export function parentsOf(charts, id) {
	const parents = [];
	for (const [otherId, entry] of charts) {
		if (otherId === id) continue;
		if ((entry.graph?.nodes ?? []).some((node) => node?.module === id)) parents.push(otherId);
	}
	return parents;
}

/**
 * The reference graph of the whole collection: which chart points at which, and
 * whether that graph can be laid out at all.
 * @param {Map<string, object>} charts - id → entry.
 * @returns {{ parents: Map<string, string[]>, children: Map<string, string[]>, cycles: string[][] }} the graph.
 */
export function referenceGraph(charts) {
	const parents = new Map();
	const children = new Map();
	for (const id of charts.keys()) {
		parents.set(id, []);
		children.set(id, []);
	}
	for (const [id, entry] of charts) {
		for (const node of entry.graph?.nodes ?? []) {
			const target = node?.module;
			if (typeof target !== 'string' || target === '') continue;
			if (!charts.has(target)) continue;
			parents.get(target).push(id);
			children.get(id).push(target);
		}
	}
	// Any cycle in the reference graph is a chart that contains itself, one step
	// removed: the reader can never finish reading it.
	const cycles = [];
	const state = new Map();
	const stack = [];
	const walk = (id) => {
		state.set(id, 1);
		stack.push(id);
		for (const child of children.get(id) ?? []) {
			const seen = state.get(child) ?? 0;
			if (seen === 1) {
				const at = stack.indexOf(child);
				cycles.push([...stack.slice(at), child]);
			} else if (seen === 0) walk(child);
		}
		stack.pop();
		state.set(id, 2);
	};
	for (const id of charts.keys()) if ((state.get(id) ?? 0) === 0) walk(id);
	return { parents, children, cycles };
}

/**
 * Validate one chart on its own: the fields the file owns, then the graph rules
 * `mermaid-graph.js` applies.
 * @param {unknown} input - the submitted chart.
 * @param {{ knownModules?: Set<string> }} [options] - resolvable chart ids.
 * @returns {{ ok: true, chart: object, graph: object } | { ok: false, errors: string[] }} the outcome.
 */
export function validateChart(input, options = {}) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, errors: ['chart: 必须是一个对象 { id, name, scope, source, brief }'] };
	}
	const errors = [];
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!ID_RE.test(id)) {
		errors.push(`chart.id: 需匹配 [a-z][a-z0-9-]{0,23}，收到「${id}」——它是文件名，只用小写字母、数字与短横`);
	}
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (name === '') errors.push('chart.name: 不能为空——它就是文件第一行，也是模块框上显示的字');
	else if (name.length > NAME_MAX_CHARS) errors.push(`chart.name: 超过 ${NAME_MAX_CHARS} 字符`);
	// The name is copied into every parent's mermaid when that parent is drawn, so
	// it has to survive being put inside a quoted label.
	else if (name.includes('"') || name.includes('<')) errors.push('chart.name: 含双引号或 <；它要出现在引用它的模块框里，换成「」');
	const scope = typeof input.scope === 'string' ? input.scope.trim() : '';
	if (scope === '') errors.push('chart.scope: 不能为空——它说明这张图从哪到哪，是这份图集存在的理由');
	else if (scope.length > SCOPE_MAX_CHARS) errors.push(`chart.scope: 超过 ${SCOPE_MAX_CHARS} 字符，说清楚从哪到哪就够`);
	else {
		const vague = VAGUE_SCOPE_RE.exec(scope);
		if (vague !== null) {
			errors.push(`chart.scope: 含「${vague[0]}」这类无边界说法；写清楚从哪一步到哪一步，否则这张图又变回一张无名图`);
		}
	}
	if (errors.length > 0) return { ok: false, errors };

	const source = typeof input.source === 'string' ? input.source : '';
	const drawn = graphOf({ source }, options);
	if (!drawn.ok) return { ok: false, errors: drawn.errors };
	return {
		ok: true,
		chart: { id, name, scope, source: source.endsWith('\n') ? source : `${source}\n`, brief: typeof input.brief === 'string' ? input.brief.trim() : '' },
		graph: drawn.graph,
	};
}

/**
 * The checks that need the whole collection in hand.
 *
 * Everything here is either a contradiction (no overview, a dangling reference,
 * a cycle) or a warning (an orphan, a row of too many modules). The split
 * matters: a warning must never stop a landing, or the author would attach a fake
 * edge just to pass.
 *
 * @param {Map<string, object>} charts - id → entry, after per-chart validation.
 * @param {{ removed?: string[] }} [options] - charts this landing deletes.
 * @returns {{ errors: string[], warnings: string[] }} the outcome.
 */
export function validateCollection(charts, options = {}) {
	const errors = [];
	const warnings = [];
	const removed = new Set(options.removed ?? []);

	if (!charts.has(OVERVIEW) && !removed.has(OVERVIEW)) {
		errors.push(`图集里没有总览：恰好要有一个 id 为 "${OVERVIEW}" 的图，它才是产品全貌`);
	}

	// A deleted chart must be unreferenced before it goes, or the parent keeps an
	// arrow into nothing and the reader sees a box that cannot be opened.
	for (const id of removed) {
		const parents = parentsOf(charts, id);
		if (parents.length > 0) {
			errors.push(`删除 ${id} 被拒绝：${parents.join('、')} 还在引用它。先改掉那些图里的模块框，再删`);
		}
		if (id === OVERVIEW) errors.push(`删除 ${id} 被拒绝：它是总览，图集里必须留一张`);
	}

	for (const [id, entry] of charts) {
		if (removed.has(id)) continue;
		for (const node of entry.graph?.nodes ?? []) {
			const target = node?.module;
			if (typeof target !== 'string' || target === '') continue;
			if (!charts.has(target)) errors.push(`${id}: 模块框 ${node.id} 指向的图「${target}」不在图集里`);
		}
	}

	const live = new Map([...charts].filter(([id]) => !removed.has(id)));
	const graph = referenceGraph(live);
	for (const cycle of graph.cycles) {
		errors.push(`图之间的引用成环：${cycle.join(' → ')}。模块图不能再指回引用它的那张图`);
	}

	for (const [id, entry] of live) {
		if (kindOf(id) === OVERVIEW) continue;
		const parents = (graph.parents.get(id) ?? []).filter((parent) => !removed.has(parent));
		if (parents.length === 0) warnings.push(`${id} 没有被任何图引用，看图的人找不到它：要么把它接进总览，要么删掉`);
	}

	for (const [id, entry] of live) {
		const modules = (entry.graph?.nodes ?? []).filter((node) => typeof node?.module === 'string' && node.module !== '');
		if (modules.length > TOP_MODULE_WARN) {
			warnings.push(`${id} 有 ${modules.length} 个模块框，一行排下来字会缩到看不清：把其中几个先收进一张子图，总览只留顶层`);
		}
	}

	return { errors, warnings };
}

/**
 * The source the view draws: every module box takes the name of the chart it
 * points at, so renaming a chart renames every place it appears.
 * @param {object} entry - one chart's entry.
 * @param {Map<string, object>} charts - every chart, by id.
 * @returns {string} the mermaid source.
 */
export function drawableChart(entry, charts) {
	return drawMermaidNamed(entry.graph, (id) => charts.get(id)?.chart?.name);
}

/**
 * Write one chart file.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {object} chart - the validated chart.
 * @returns {{ path: string, revision: string }} what was written.
 */
export function writeChart(specDir, chart) {
	ensureFlowsDir(specDir);
	const path = chartPath(specDir, chart.id);
	const text = canonicalMarkdown(chart);
	try {
		writeFileSync(path, text, 'utf8');
	} catch (error) {
		// A half-written landing must name the file that failed, or the caller cannot
		// tell which chart is missing.
		throw new Error(`落盘失败（${path}）：${error?.message ?? error}。修正后重新调用。`);
	}
	return { path, revision: revisionOf(text) };
}

/**
 * Remove one chart file.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 */
export function removeChartFiles(specDir, id) {
	try {
		unlinkSync(chartPath(specDir, id));
	} catch {
		// Missing is already removed.
	}
}
