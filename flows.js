/**
 * The chart collection: every chart in `.spec/flows/`, the references between
 * them, and the checks that only make sense once more than one chart exists.
 *
 * A single chart file is a plain JSON object; the collection is what turns one
 * fixed file name into a named set. The distinction is the whole point: a
 * project keeps one overview of what the product does and one chart per module,
 * and the reader can tell which is which without opening a conversation log.
 *
 * Three file names share one stem, so a chart is a unit rather than a name to
 * look up: `<id>.json` is the model (the truth), `<id>.png` is the picture drawn
 * from it (a cache, rewritten whenever the model changes), and `<id>.brief.md` is
 * the requirements that chart exists for.
 *
 * @module dsh-spec-mode/flows
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateFlow } from './flow.js';

/** The directory name, under `.spec`, that holds the collection. */
export const FLOWS_DIR = 'flows';

/** The one kind that is the whole product; every other chart is a module. */
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

/** Longest a single `ports` entry may run. */
const PORT_MAX_CHARS = 60;

/**
 * Canonical JSON: keys in a fixed order, no trailing whitespace. The revision is
 * a hash of this text, so two writers that produce the same model agree on the
 * revision regardless of how they serialized it.
 * @param {object} model - one chart's model.
 * @returns {string} the canonical text.
 */
export function canonicalModel(model) {
	const ordered = {
		id: model.id,
		kind: model.kind,
		name: model.name,
		scope: model.scope,
		nodes: model.nodes,
		edges: model.edges,
	};
	return `${JSON.stringify(ordered, null, '\t')}\n`;
}

/**
 * The revision of one model: a hash of its canonical text.
 * @param {object} model - one chart's model.
 * @returns {string} the revision.
 */
export function revisionOf(model) {
	return createHash('sha256').update(canonicalModel(model), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Absolute path of one chart's model file.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the path.
 */
export function chartModelPath(specDir, id) {
	return join(specDir, FLOWS_DIR, `${id}.json`);
}

/**
 * Absolute path of one chart's picture.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the path.
 */
export function chartImagePath(specDir, id) {
	return join(specDir, FLOWS_DIR, `${id}.png`);
}

/**
 * Absolute path of one chart's vector fallback.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the path.
 */
export function chartVectorPath(specDir, id) {
	return join(specDir, FLOWS_DIR, `${id}.svg`);
}

/**
 * Absolute path of one chart's brief.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the path.
 */
export function chartBriefPath(specDir, id) {
	return join(specDir, FLOWS_DIR, `${id}.brief.md`);
}

/**
 * Absolute path of the collection directory.
 * @param {string} specDir - the absolute `.spec` directory.
 * @returns {string} the path.
 */
export function flowsDirPath(specDir) {
	return join(specDir, FLOWS_DIR);
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
			.filter((entry) => entry.endsWith('.json'))
			.map((entry) => entry.slice(0, -'.json'.length))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Read one chart's model, or `undefined` when the file is missing.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {{ model: object, revision: string } | { broken: string } | undefined} the chart.
 */
export function readChart(specDir, id) {
	const path = chartModelPath(specDir, id);
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
	let model;
	try {
		model = JSON.parse(text);
	} catch (error) {
		return { broken: `${id}.json 不是合法的 JSON：${error?.message ?? error}` };
	}
	if (model === null || typeof model !== 'object') return { broken: `${id}.json 的顶层必须是对象` };
	return { model, revision: revisionOf(model) };
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
 * Read one chart's brief, or `''` when the file is missing.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the brief text.
 */
export function readChartBrief(specDir, id) {
	try {
		return readFileSync(chartBriefPath(specDir, id), 'utf8');
	} catch {
		return '';
	}
}

/**
 * The charts that point at one chart.
 * @param {Map<string, object>} charts - id → model, for every chart.
 * @param {string} id - the chart being looked up.
 * @returns {string[]} the parent ids.
 */
export function parentsOf(charts, id) {
	const parents = [];
	for (const [otherId, model] of charts) {
		if (otherId === id) continue;
		const found = (model.nodes ?? []).some((node) => node?.module === id);
		if (found) parents.push(otherId);
	}
	return parents;
}

/**
 * The reference graph of the whole collection: which chart points at which, and
 * whether that graph can be laid out at all.
 * @param {Map<string, object>} charts - id → model.
 * @returns {{ parents: Map<string, string[]>, children: Map<string, string[]>, cycles: string[][] }} the graph.
 */
export function referenceGraph(charts) {
	const parents = new Map();
	const children = new Map();
	for (const id of charts.keys()) {
		parents.set(id, []);
		children.set(id, []);
	}
	for (const [id, model] of charts) {
		for (const node of model.nodes ?? []) {
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
 * Validate one chart model on its own: the fields the collection owns, then the
 * graph rules `validateFlow` already applies.
 * @param {unknown} input - the submitted chart.
 * @param {{ knownModules?: Set<string> }} [options] - resolvable module ids.
 * @returns {{ ok: true, model: object } | { ok: false, errors: string[] }} the outcome.
 */
export function validateChart(input, options = {}) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, errors: ['chart: 必须是一个对象 { id, kind, name, scope, nodes, edges }'] };
	}
	const errors = [];
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!ID_RE.test(id)) {
		errors.push(`chart.id: 需匹配 [a-z][a-z0-9-]{0,23}，收到「${id}」——它是文件名，只用小写字母、数字与短横`);
	}
	const kind = input.kind;
	if (kind !== OVERVIEW && kind !== MODULE) {
		errors.push(`chart.kind: 只能是 "${OVERVIEW}" 或 "${MODULE}"，收到「${String(kind)}」`);
	}
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (name === '') errors.push('chart.name: 不能为空——它画在框上，是读者看到的那个名字');
	else if (name.length > NAME_MAX_CHARS) errors.push(`chart.name: 超过 ${NAME_MAX_CHARS} 字符`);
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

	const outcome = validateFlow({ nodes: input.nodes, edges: input.edges }, {
		knownModules: options.knownModules,
	});
	if (!outcome.ok) return outcome;
	return {
		ok: true,
		model: { id, kind, name, scope, nodes: outcome.flow.nodes, edges: outcome.flow.edges },
	};
}

/**
 * The checks that need the whole collection in hand.
 *
 * Everything here is either a contradiction (two overviews, a dangling
 * reference, a cycle) or a warning (an orphan, a row of too many modules). The
 * split matters: a warning must never stop a landing, or the author would attach
 * a fake edge just to pass.
 *
 * @param {Map<string, object>} models - id → model, after per-chart validation.
 * @param {{ removed?: string[] }} [options] - charts this landing deletes.
 * @returns {{ errors: string[], warnings: string[] }} the outcome.
 */
export function validateCollection(models, options = {}) {
	const errors = [];
	const warnings = [];
	const removed = new Set(options.removed ?? []);

	const overviews = [...models.entries()].filter(([, model]) => model.kind === OVERVIEW).map(([id]) => id);
	if (overviews.length === 0) errors.push(`图集里没有总览：恰好要有一张 kind 为 "${OVERVIEW}" 的图，它才是产品全貌`);
	if (overviews.length > 1) errors.push(`图集里有 ${overviews.length} 张总览（${overviews.join('、')}）：只能有一张`);

	// A deleted chart must be unreferenced before it goes, or the parent keeps an
	// arrow into nothing and the reader sees a box that cannot be opened.
	for (const id of removed) {
		const parents = parentsOf(models, id);
		if (parents.length > 0) {
			errors.push(`删除 ${id} 被拒绝：${parents.join('、')} 还在引用它。先改掉那些图里的模块节点，再删`);
		}
		if (models.get(id)?.kind === OVERVIEW) {
			errors.push(`删除 ${id} 被拒绝：它是总览，图集里必须留一张`);
		}
	}

	for (const [id, model] of models) {
		if (removed.has(id)) continue;
		for (const node of model.nodes ?? []) {
			const target = node?.module;
			if (typeof target !== 'string' || target === '') continue;
			if (!models.has(target)) {
				errors.push(`${id}: 节点 ${node.id} 指向的图「${target}」不在图集里`);
			}
		}
	}

	const live = new Map([...models].filter(([id]) => !removed.has(id)));
	const graph = referenceGraph(live);
	for (const cycle of graph.cycles) {
		errors.push(`图之间的引用成环：${cycle.join(' → ')}。模块图不能再指回引用它的那张图`);
	}

	for (const [id, model] of live) {
		if (model.kind === OVERVIEW) continue;
		const parents = (graph.parents.get(id) ?? []).filter((parent) => !removed.has(parent));
		if (parents.length === 0) {
			warnings.push(`${id} 没有被任何图引用，看图的人找不到它：要么把它接进总览，要么删掉`);
		}
	}

	for (const [id, model] of live) {
		const modules = (model.nodes ?? []).filter((node) => typeof node?.module === 'string' && node.module !== '');
		if (modules.length > TOP_MODULE_WARN) {
			warnings.push(
				`${id} 有 ${modules.length} 个模块框，一行排下来字会缩到看不清：`
				+ '把其中几个先收进一张子图，总览只留顶层',
			);
		}
	}

	return { errors, warnings };
}

/**
 * Fill in the words a chart draws but does not store: every module node's box
 * takes the name of the chart it points at.
 *
 * The name lives in exactly one place — the target chart — and is copied here at
 * draw time. Storing it in the parent instead would mean renaming a chart leaves
 * a stale box in every parent that uses it, and nothing would report it.
 *
 * @param {object} model - one validated chart.
 * @param {Map<string, object>} models - every chart, by id.
 * @returns {{ nodes: object[], edges: object[] }} the chart as the renderer takes it.
 */
export function drawableChart(model, models) {
	const nodes = (model.nodes ?? []).map((node) => {
		if (typeof node.module !== 'string' || node.module === '') return node;
		const target = models.get(node.module);
		return {
			id: node.id,
			label: target?.name ?? `${node.module}（缺图）`,
			ports: node.ports,
			isModule: true,
		};
	});
	return { nodes, edges: model.edges ?? [] };
}

/**
 * Write one chart's model and revision marker.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {object} model - the validated model.
 * @returns {{ path: string, revision: string }} what was written.
 */
export function writeChartModel(specDir, model) {
	ensureFlowsDir(specDir);
	const path = chartModelPath(specDir, model.id);
	try {
		writeFileSync(path, canonicalModel(model), 'utf8');
	} catch (error) {
		// A half-written landing must name the file that failed, or the caller cannot
		// tell which chart is missing.
		throw new Error(`落盘失败（${path}）：${error?.message ?? error}。修正后重新调用。`);
	}
	return { path, revision: revisionOf(model) };
}

/**
 * Write one chart's brief. An empty text removes the file, so "no brief yet" has
 * exactly one representation on disk.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @param {string} text - the brief content, or `''` to remove it.
 */
export function writeChartBrief(specDir, id, text) {
	const path = chartBriefPath(specDir, id);
	if (typeof text !== 'string' || text.trim() === '') {
		try {
			unlinkSync(path);
		} catch {
			// A brief that never existed is already in the desired state.
		}
		return;
	}
	ensureFlowsDir(specDir);
	try {
		writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
	} catch (error) {
		throw new Error(`落盘失败（${path}）：${error?.message ?? error}。修正后重新调用。`);
	}
}

/**
 * Remove one chart and everything written for it.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 */
export function removeChartFiles(specDir, id) {
	for (const path of [chartModelPath(specDir, id), chartImagePath(specDir, id), chartVectorPath(specDir, id), chartBriefPath(specDir, id)]) {
		try {
			unlinkSync(path);
		} catch {
			// Missing is already removed.
		}
	}
}

/**
 * Whether one chart's picture is older than its model, which is the only thing
 * the reader has to know about the cache.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {boolean} true when the picture needs redrawing.
 */
export function pictureIsStale(specDir, id) {
	const image = chartImagePath(specDir, id);
	const vector = chartVectorPath(specDir, id);
	const model = chartModelPath(specDir, id);
	const picture = existsSync(image) ? image : (existsSync(vector) ? vector : undefined);
	if (picture === undefined) return true;
	try {
		return readFileSync(picture).length === 0;
	} catch {
		return true;
	}
}
